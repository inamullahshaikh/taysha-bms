import { ArrowRightLeft } from 'lucide-react'
import { date, label, qty } from '../../lib/format'
import { productLabel, useLookupName, useLookups, useRefMap } from '../../lib/hooks'
import { DataTable } from '../../ui/DataTable'
import { cx } from '../../ui/kit'
import { SourceLink } from './shared'

const REASONS = ['receipt', 'opening', 'purchase_receipt', 'sale', 'issue', 'sample', 'internal_use', 'wastage', 'damage', 'expired',
  'adjustment', 'count', 'transfer_out', 'transfer_in', 'production_in', 'production_out', 'production_return', 'customer_return']

/** The append-only stock ledger. Embeddable on product and batch pages via `params`. */
export function MovementTable({ params, persist = true, hideProduct }: { params?: Record<string, any>; persist?: boolean; hideProduct?: boolean }) {
  const { data: lk } = useLookups()
  const wh = useLookupName('warehouses')
  const product = useRefMap('/products', productLabel)
  const user = useRefMap('/users')
  return (
    <DataTable
      path="/stock/movements"
      params={params}
      persist={persist}
      search={false}
      dense
      exportFeature="inventory"
      filters={[
        { key: 'warehouse_id', label: 'All warehouses', options: (lk?.warehouses ?? []).map((w) => ({ value: w.id, label: w.name! })) },
        { key: 'reason', label: 'Any reason', options: REASONS },
        { key: 'date_from', label: 'From', type: 'date' },
        { key: 'date_to', label: 'To', type: 'date' },
      ]}
      empty={{ title: 'No movements yet', icon: <ArrowRightLeft /> }}
      columns={[
        { key: 'movement_date', label: 'Date', render: (m: any) => <span className="whitespace-nowrap">{date(m.movement_date)}</span> },
        ...(hideProduct ? [] : [{ key: 'product_id', label: 'Item', render: (m: any) => product(m.product_id) }]),
        { key: 'warehouse_id', label: 'Warehouse', render: (m: any) => wh(m.warehouse_id) },
        { key: 'reason', label: 'Reason', render: (m: any) => label(m.reason) },
        { key: 'quantity', label: 'Change', align: 'right', render: (m: any) => <span className={cx('font-medium', Number(m.quantity) < 0 ? 'text-bad' : 'text-good')}>{Number(m.quantity) > 0 ? '+' : ''}{qty(m.quantity)}</span> },
        { key: 'balance_after', label: 'Balance', align: 'right', render: (m: any) => qty(m.balance_after) },
        { key: 'ref', label: 'Source', render: (m: any) => <SourceLink m={m} /> },
        { key: 'user_id', label: 'By', render: (m: any) => <span className="text-ink-2">{m.user_id ? user(m.user_id) : 'System'}</span> },
      ]}
    />
  )
}

export default function Movements() {
  return <MovementTable />
}
