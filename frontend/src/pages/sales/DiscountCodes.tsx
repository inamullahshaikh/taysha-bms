import { date, money } from '../../lib/format'
import type { FieldDef } from '../../ui/Form'
import { Badge } from '../../ui/kit'
import { ResourcePage } from '../../ui/Resource'

const COMMON: FieldDef[] = [
  { name: 'description', label: 'Description', full: true },
  { name: 'valid_from', label: 'Valid from', type: 'date' },
  { name: 'valid_to', label: 'Valid to', type: 'date' },
  { name: 'min_order_amount', label: 'Minimum order', type: 'money' },
  { name: 'max_uses', label: 'Maximum uses', type: 'number' },
  { name: 'is_active', label: 'Active', type: 'bool' },
]
const FIELDS: FieldDef[] = [
  { name: 'code', label: 'Code', required: true, placeholder: 'EID20' },
  { name: 'kind', label: 'Type', type: 'select', required: true, options: [{ value: 'percent', label: 'Percentage off' }, { value: 'fixed', label: 'Fixed amount off' }] },
  { name: 'value', label: 'Value', type: 'number', required: true, hint: '% or PKR' },
  ...COMMON,
]

export default function DiscountCodes() {
  return (
    <ResourcePage
      path="/discount-codes"
      feature="discount_codes"
      noun="discount code"
      search="Search codes"
      fields={FIELDS}
      editFields={COMMON}
      defaults={{ kind: 'percent', is_active: true }}
      filters={[{ key: 'is_active', label: 'Status', options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }] }]}
      columns={[
        { key: 'code', label: 'Code', render: (r: any) => <span className="block"><span className="font-mono font-medium">{r.code}</span>{r.description && <span className="block text-[12px] text-muted">{r.description}</span>}</span> },
        { key: 'value', label: 'Discount', render: (r: any) => (r.kind === 'percent' ? `${Number(r.value)}% off` : `${money(r.value)} off`) },
        { key: 'min_order_amount', label: 'Min order', render: (r: any) => (r.min_order_amount ? money(r.min_order_amount) : '—') },
        { key: 'valid', label: 'Valid', render: (r: any) => (r.valid_from || r.valid_to ? `${r.valid_from ? date(r.valid_from) : 'now'} – ${r.valid_to ? date(r.valid_to) : 'no end'}` : 'Always') },
        { key: 'max_uses', label: 'Max uses', align: 'right', render: (r: any) => r.max_uses ?? '—' },
        { key: 'is_active', label: 'Status', render: (r: any) => (r.is_active ? <Badge tone="good">Active</Badge> : <Badge>Inactive</Badge>) },
      ]}
    />
  )
}
