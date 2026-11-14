import { useQueries } from '@tanstack/react-query'
import { ChevronDown, Plus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { date, money } from '../../lib/format'
import { StatTile } from '../../ui/charts'
import { DataTable } from '../../ui/DataTable'
import { Button, Menu, MenuItem, Status } from '../../ui/kit'
import { DOC_LABEL, DOC_TYPES } from './common'

const TILES = [
  { label: 'Unpaid invoices', params: { doc_type: 'invoice', unpaid: true }, to: '/documents?doc_type=invoice&unpaid=true' },
  { label: 'Overdue', params: { doc_type: 'invoice', status: 'overdue' }, to: '/documents?doc_type=invoice&status=overdue' },
  { label: 'Quotes awaiting reply', params: { doc_type: 'quotation', status: 'issued' }, to: '/documents?doc_type=quotation&status=issued' },
  { label: 'Drafts', params: { status: 'draft' }, to: '/documents?status=draft' },
]
const NEW_TYPES = ['invoice', 'quotation', 'proforma', 'debit_note', 'delivery_challan']

export default function Documents() {
  const can = useCan()
  const navigate = useNavigate()
  const counts = useQueries({
    queries: TILES.map((t) => ({ queryKey: ['/documents', 'count', t.params], queryFn: () => api.get('/documents', { ...t.params, page_size: 1 }) })),
  })
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {TILES.map((t, i) => <StatTile key={t.label} label={t.label} value={counts[i].data?.total?.toLocaleString() ?? '—'} to={t.to} />)}
      </div>
      <DataTable
        path="/documents"
        search="Search number or customer"
        exportFeature="invoices"
        rowTo={(r: any) => `/documents/${r.id}`}
        empty={{ title: 'No documents yet', body: 'Create an invoice from a confirmed order, or start one here.' }}
        toolbar={can('invoices', 'create') && (
          <Menu trigger={<Button size="sm" variant="primary" icon={<Plus className="size-4" />}>New <ChevronDown className="size-3.5" /></Button>}>
            {NEW_TYPES.map((t) => <MenuItem key={t} onClick={() => navigate(`/documents/new?type=${t}`)}>{DOC_LABEL[t]}</MenuItem>)}
          </Menu>
        )}
        filters={[
          { key: 'doc_type', label: 'Type', options: DOC_TYPES.map((t) => ({ value: t, label: DOC_LABEL[t] })) },
          { key: 'status', label: 'Status', options: ['draft', 'issued', 'partially_paid', 'paid', 'overdue', 'accepted', 'rejected', 'expired', 'converted', 'credited', 'cancelled'] },
          { key: 'date_from', label: 'From', type: 'date' },
          { key: 'date_to', label: 'To', type: 'date' },
          { key: 'unpaid', label: 'Unpaid', type: 'bool' },
        ]}
        columns={[
          { key: 'number', label: 'Number', sort: 'number', render: (r: any) => <span className="font-medium">{r.number ?? <span className="text-muted">Draft</span>}</span> },
          { key: 'doc_type', label: 'Type', render: (r: any) => DOC_LABEL[r.doc_type] ?? r.doc_type },
          { key: 'doc_date', label: 'Date', sort: 'doc_date', render: (r: any) => date(r.doc_date) },
          { key: 'customer_name', label: 'Customer', render: (r: any) => r.customer_name ?? '—' },
          { key: 'due_date', label: 'Due', render: (r: any) => (r.due_date ? date(r.due_date) : '—') },
          { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} /> },
          { key: 'grand_total', label: 'Total', sort: 'grand_total', align: 'right', render: (r: any) => (
            <span className="block">{money(r.grand_total)}
              {r.doc_type === 'invoice' && Number(r.balance_due) > 0 && r.status !== 'cancelled' && <span className="block text-[12px] text-muted">{money(r.balance_due)} due</span>}</span>
          ) },
        ]}
      />
    </div>
  )
}
