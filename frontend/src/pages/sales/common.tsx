import { useLookups } from '../../lib/hooks'

export const ORDER_STATUSES = ['draft', 'confirmed', 'processing', 'packed', 'dispatched', 'delivered', 'cancelled', 'returned', 'refunded']
export const PAYMENT_STATUSES = ['unpaid', 'partially_paid', 'paid', 'cod_pending', 'refunded', 'failed']
export const ORDER_TYPES = ['retail', 'wholesale', 'corporate', 'cafe', 'stall', 'sample', 'promotional', 'replacement']
export const PAY_METHODS = [
  { value: 'cash', label: 'Cash' }, { value: 'card', label: 'Card' }, { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'cod', label: 'Cash on delivery' }, { value: 'online', label: 'Online' }, { value: 'cheque', label: 'Cheque' }, { value: 'other', label: 'Other' },
]
export const CUSTOMER_TYPES = ['retail', 'wholesale', 'cafe', 'corporate', 'distributor', 'retailer', 'other']
export const DOC_TYPES = ['invoice', 'quotation', 'proforma', 'receipt', 'credit_note', 'debit_note', 'delivery_challan']
export const DOC_LABEL: Record<string, string> = {
  invoice: 'Invoice', quotation: 'Quotation', proforma: 'Pro-forma', receipt: 'Receipt', credit_note: 'Credit note',
  debit_note: 'Debit note', delivery_challan: 'Delivery challan',
}

/** Sales channel options keyed by code (orders store the code). */
export function useChannels() {
  const { data } = useLookups()
  const list = data?.sales_channels ?? []
  return {
    options: list.map((c) => ({ value: c.code!, label: c.name! })),
    name: (code?: string | null) => (code ? (list.find((c) => c.code === code)?.name ?? code) : '—'),
  }
}

export function Address({ a }: { a?: any }) {
  if (!a) return <span className="text-muted">—</span>
  return (
    <span className="block leading-snug">
      {[a.line1, a.line2].filter(Boolean).join(', ')}
      <span className="block text-ink-2">{[a.area, a.city, a.postal_code].filter(Boolean).join(', ')}</span>
      {a.phone && <span className="block text-ink-2">{a.phone}</span>}
    </span>
  )
}

/** Small "label · value" totals block. Values come from the API as-is. */
export function Totals({ rows }: { rows: [string, string, boolean?][] }) {
  return (
    <dl className="ml-auto w-full max-w-xs text-[13.5px]">
      {rows.map(([k, v, strong]) => (
        <div key={k} className={strong ? 'mt-1.5 flex justify-between border-t border-line pt-2 font-semibold' : 'flex justify-between py-0.5 text-ink-2'}>
          <dt>{k}</dt><dd className="tabular text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  )
}
