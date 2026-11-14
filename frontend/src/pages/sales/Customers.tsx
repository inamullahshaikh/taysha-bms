import { date, label } from '../../lib/format'
import { USERS, type FieldDef } from '../../ui/Form'
import { Badge } from '../../ui/kit'
import { ResourcePage } from '../../ui/Resource'
import { CUSTOMER_TYPES } from './common'

export const CUSTOMER_FIELDS: FieldDef[] = [
  { name: 'name', label: 'Name', required: true },
  { name: 'phone', label: 'Phone', placeholder: '+92 3xx xxxxxxx' },
  { name: 'type', label: 'Type', type: 'select', options: CUSTOMER_TYPES },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'company_name', label: 'Company' },
  { name: 'tags', label: 'Tags', type: 'tags' },
  { name: 'source', label: 'How they found us', placeholder: 'Instagram, referral…' },
  { name: 'marketing_opt_in', label: 'Happy to receive offers', type: 'bool' },
  { name: 'price_list_id', label: 'Price list', type: 'lookup', lookup: 'price_lists' },
  { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number' },
  { name: 'credit_limit', label: 'Credit limit', type: 'money' },
  { name: 'territory_id', label: 'Territory', type: 'record', record: { path: '/territories' } },
  { name: 'sales_rep_id', label: 'Sales rep', type: 'record', record: USERS },
  { name: 'ntn', label: 'NTN' },
  { name: 'strn', label: 'STRN' },
  { name: 'preferences', label: 'Preferences', type: 'textarea' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
]

export default function Customers() {
  return (
    <ResourcePage
      path="/customers"
      feature="customers"
      noun="customer"
      search="Search name, phone or email"
      fields={CUSTOMER_FIELDS}
      defaults={{ type: 'retail' }}
      rowTo={(r: any) => `/customers/${r.id}`}
      columns={[
        { key: 'name', label: 'Customer', sort: 'name', render: (r: any) => (
          <span className="block">
            <span className="font-medium">{r.name}</span>
            {r.company_name && <span className="block text-[12px] text-muted">{r.company_name}</span>}
          </span>
        ) },
        { key: 'type', label: 'Type', render: (r: any) => label(r.type) },
        { key: 'phone', label: 'Phone' },
        { key: 'tags', label: 'Tags', render: (r: any) => r.tags?.length ? <span className="flex flex-wrap gap-1">{r.tags.map((t: string) => <Badge key={t}>{t}</Badge>)}</span> : <span className="text-muted">—</span> },
        { key: 'created_at', label: 'Since', render: (r: any) => date(r.created_at) },
      ]}
      filters={[{ key: 'type', label: 'Type', options: CUSTOMER_TYPES }]}
    />
  )
}
