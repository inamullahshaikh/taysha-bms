import { useQueryClient } from '@tanstack/react-query'
import { ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { PRODUCTS, type FieldDef, type LineCol } from '../../ui/Form'
import { Button } from '../../ui/kit'
import { FormDrawer } from '../../ui/Resource'
import { useToast } from '../../ui/toast'
import { LinesDrawer } from './LinesDrawer'

type Op = 'receive' | 'issue' | 'adjust' | 'transfer'

const BATCHES = { path: '/stock/batches', label: (r: any) => `${r.number}${r.expiry_date ? ` · exp ${r.expiry_date}` : ''}`, params: { in_stock: true } }

const receiveFields: FieldDef[] = [
  { name: 'warehouse_id', label: 'Warehouse', type: 'lookup', lookup: 'warehouses', required: true },
  { name: 'reason', label: 'Reason', type: 'select', options: ['receipt', 'opening'], required: true },
  { name: 'reference', label: 'Reference', placeholder: 'Delivery note, invoice…' },
  { name: 'note', label: 'Note' },
]
const receiveCols: LineCol[] = [
  { name: 'product_id', label: 'Item', type: 'product' },
  { name: 'quantity', label: 'Qty', type: 'number', width: '90px' },
  { name: 'unit_cost', label: 'Unit cost', type: 'money', width: '110px' },
  { name: 'batch_number', label: 'Batch', type: 'text', width: '120px' },
  { name: 'expiry_date', label: 'Expiry', type: 'text', placeholder: 'YYYY-MM-DD', width: '130px' },
]
const issueFields: FieldDef[] = [
  { name: 'warehouse_id', label: 'Warehouse', type: 'lookup', lookup: 'warehouses', required: true },
  { name: 'reason', label: 'Reason', type: 'select', options: ['issue', 'sample', 'internal_use', 'wastage', 'damage', 'expired'], required: true },
  { name: 'note', label: 'Why', required: true, full: true },
]
const issueCols: LineCol[] = [
  { name: 'product_id', label: 'Item', type: 'product' },
  { name: 'quantity', label: 'Qty', type: 'number', width: '90px' },
  { name: 'batch_id', label: 'Batch (optional)', type: 'record', record: BATCHES },
]
const transferFields: FieldDef[] = [
  { name: 'from_warehouse_id', label: 'From', type: 'lookup', lookup: 'warehouses', required: true },
  { name: 'to_warehouse_id', label: 'To', type: 'lookup', lookup: 'warehouses', required: true },
  { name: 'note', label: 'Note', full: true },
]
const transferCols: LineCol[] = [
  { name: 'product_id', label: 'Item', type: 'product' },
  { name: 'quantity', label: 'Qty', type: 'number', width: '100px' },
  { name: 'batch_id', label: 'Batch (optional)', type: 'record', record: BATCHES },
]
const adjustFields: FieldDef[] = [
  { name: 'warehouse_id', label: 'Warehouse', type: 'lookup', lookup: 'warehouses', required: true },
  { name: 'product_id', label: 'Item', type: 'record', record: PRODUCTS, required: true },
  { name: 'new_quantity', label: 'Counted quantity', type: 'number', required: true, hint: 'What is actually on the shelf' },
  { name: 'batch_id', label: 'Batch', type: 'record', record: BATCHES },
  { name: 'note', label: 'Reason for the change', required: true, full: true },
]

/** Receive / issue / adjust / transfer buttons with their forms. Each needs its own grant. */
export function StockActions({ defaults = {} }: { defaults?: Record<string, any> }) {
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const [op, setOp] = useState<Op | null>(null)
  const done = (msg: string) => { toast(msg); qc.invalidateQueries() }
  const close = () => setOp(null)
  const wh = defaults.warehouse_id

  return (
    <>
      {can('inventory', 'create') && <>
        <Button size="sm" icon={<ArrowDownToLine className="size-4" />} onClick={() => setOp('receive')}>Receive</Button>
        <Button size="sm" icon={<ArrowUpFromLine className="size-4" />} onClick={() => setOp('issue')}>Issue</Button>
        <Button size="sm" icon={<ArrowLeftRight className="size-4" />} onClick={() => setOp('transfer')}>Transfer</Button>
      </>}
      {can('inventory', 'edit') && <Button size="sm" icon={<SlidersHorizontal className="size-4" />} onClick={() => setOp('adjust')}>Adjust</Button>}

      <LinesDrawer open={op === 'receive'} onClose={close} title="Receive stock" scan fields={receiveFields} columns={receiveCols}
        initial={{ reason: 'receipt', warehouse_id: wh }} initialLines={defaults.product_id ? [{ product_id: String(defaults.product_id), quantity: '' }] : undefined}
        note={<p className="text-[12.5px] text-ink-2">For deliveries against a purchase order, receive from the order instead so it tracks what arrived.</p>}
        submit={async (b) => { await api.post('/stock/receive', b); done('Stock received') }} submitLabel="Receive" />
      <LinesDrawer open={op === 'issue'} onClose={close} title="Issue stock" scan fields={issueFields} columns={issueCols}
        initial={{ reason: 'issue', warehouse_id: wh }} initialLines={defaults.product_id ? [{ product_id: String(defaults.product_id), quantity: '' }] : undefined}
        submit={async (b) => { await api.post('/stock/issue', b); done('Stock issued') }} submitLabel="Issue" />
      <LinesDrawer open={op === 'transfer'} onClose={close} title="Transfer between warehouses" scan fields={transferFields} columns={transferCols}
        initial={{ from_warehouse_id: wh }} initialLines={defaults.product_id ? [{ product_id: String(defaults.product_id), quantity: '' }] : undefined}
        submit={async (b) => { await api.post('/stock/transfers', b); done('Transfer created') }} submitLabel="Create transfer" />
      <FormDrawer open={op === 'adjust'} onClose={close} title="Adjust stock" fields={adjustFields}
        initial={{ warehouse_id: wh, product_id: defaults.product_id }}
        submit={async (b) => { await api.post('/stock/adjust', b); done('Stock adjusted') }} submitLabel="Adjust" />
    </>
  )
}
