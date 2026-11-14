import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, ApiError } from '../../lib/api'
import { CUSTOMERS, LineItems, RecordSelect, cleanLines, type FormValues } from '../../ui/Form'
import { Button, Card, ErrorNote, Field, Input, Loading, Textarea } from '../../ui/kit'
import { RecordHeader } from '../../ui/Record'
import { useToast } from '../../ui/toast'
import { DOC_LABEL } from './common'

const blankLine = () => ({ product_id: '', description: '', quantity: '1', unit_price: '', discount_pct: '' })
const ADDR = ['line1', 'line2', 'area', 'city', 'phone']

/** Manual sales documents. Totals are worked out by the server when saved. */
export default function DocumentForm() {
  const { id } = useParams()
  const [sp] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const existing = useQuery({ queryKey: [`/documents/${id}`], queryFn: () => api.get(`/documents/${id}`), enabled: !!id })
  const [d, setD] = useState<FormValues>({ doc_type: sp.get('type') ?? 'invoice' })
  const [lines, setLines] = useState<FormValues[]>([blankLine()])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: string, v: any) => setD((s) => ({ ...s, [k]: v }))

  useEffect(() => {
    const r = existing.data
    if (!r) return
    const a = r.billing_address ?? {}
    setD({
      doc_type: r.doc_type, customer_id: r.customer_id ? String(r.customer_id) : '', customer_name: r.customer_name ?? '',
      customer_phone: r.customer_phone ?? '', customer_email: r.customer_email ?? '', customer_ntn: r.customer_ntn ?? '',
      doc_date: r.doc_date, due_date: r.due_date ?? '', valid_until: r.valid_until ?? '', notes: r.notes ?? '', terms: r.terms ?? '',
      delivery_charge: Number(r.delivery_charge) ? r.delivery_charge : '', order_discount_pct: Number(r.order_discount_pct) ? r.order_discount_pct : '',
      related_document_id: r.related_document_id ? String(r.related_document_id) : '',
      ...Object.fromEntries(ADDR.map((k) => [`addr_${k}`, a[k] ?? ''])),
    })
    setLines((r.lines ?? []).map((l: any) => ({
      product_id: l.product_id ? String(l.product_id) : '', description: l.description, quantity: l.quantity,
      unit_price: l.unit_price, discount_pct: Number(l.discount_pct) ? l.discount_pct : '',
    })))
  }, [existing.data])

  const pickCustomer = (v: string, c?: any) => setD((s) => ({
    ...s, customer_id: v,
    ...(c ? { customer_name: c.name, customer_phone: c.phone ?? '', customer_email: c.email ?? '', customer_ntn: c.ntn ?? '' } : {}),
  }))

  const save = async () => {
    setBusy(true); setErrors({}); setError(null)
    const body: FormValues = {}
    for (const [k, v] of Object.entries(d)) if (v !== '' && v != null && !k.startsWith('addr_')) body[k] = v
    for (const k of ['customer_id', 'related_document_id']) if (body[k]) body[k] = Number(body[k])
    if (d.addr_line1 && d.addr_city) body.billing_address = Object.fromEntries(ADDR.map((k) => [k, d[`addr_${k}`] || null]))
    body.lines = cleanLines(lines)
    try {
      const r = id ? await api.put(`/documents/${id}`, body) : await api.post('/documents', body)
      toast('Draft saved')
      navigate(`/documents/${r.id}`, { replace: true })
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fields)
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  if (id && existing.isLoading) return <Loading />
  const type = d.doc_type
  const name = DOC_LABEL[type] ?? 'Document'

  return (
    <>
      <RecordHeader back={id ? `/documents/${id}` : '/documents'} backLabel={id ? 'Back to document' : 'Invoices & quotes'}
        title={id ? `Edit draft ${name.toLowerCase()}` : `New ${name.toLowerCase()}`}
        actions={<Button variant="primary" loading={busy} onClick={save}>Save draft</Button>} />
      <div className="flex max-w-4xl flex-col gap-4">
        {error != null && <ErrorNote error={error} />}
        <Card title="Bill to">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Customer" className="sm:col-span-2" hint="Pick a saved customer, or type the details below">
              <RecordSelect source={CUSTOMERS} value={d.customer_id} onChange={pickCustomer} />
            </Field>
            <Field label="Name" error={errors.customer_name}><Input value={d.customer_name ?? ''} onChange={(e) => set('customer_name', e.target.value)} /></Field>
            <Field label="Phone"><Input value={d.customer_phone ?? ''} onChange={(e) => set('customer_phone', e.target.value)} /></Field>
            <Field label="Email" error={errors.customer_email}><Input type="email" value={d.customer_email ?? ''} onChange={(e) => set('customer_email', e.target.value)} /></Field>
            <Field label="NTN"><Input value={d.customer_ntn ?? ''} onChange={(e) => set('customer_ntn', e.target.value)} /></Field>
            <Field label="Address" className="sm:col-span-2"><Input value={d.addr_line1 ?? ''} onChange={(e) => set('addr_line1', e.target.value)} /></Field>
            <Field label="Area"><Input value={d.addr_area ?? ''} onChange={(e) => set('addr_area', e.target.value)} /></Field>
            <Field label="City"><Input value={d.addr_city ?? ''} onChange={(e) => set('addr_city', e.target.value)} /></Field>
          </div>
        </Card>

        <Card title="Items">
          <LineItems value={lines} onChange={setLines} newRow={blankLine} errors={errors} columns={[
            { name: 'product_id', label: 'Product', type: 'product' },
            { name: 'description', label: 'Description', type: 'text', placeholder: 'Optional with a product' },
            { name: 'quantity', label: 'Qty', type: 'number', width: '80px' },
            { name: 'unit_price', label: 'Price', type: 'money', width: '110px', placeholder: 'List' },
            { name: 'discount_pct', label: 'Disc. %', type: 'number', width: '80px' },
          ]} />
          <p className="mt-2 text-[12px] text-muted">Prices include tax. Totals are calculated when you save.</p>
        </Card>

        <Card title="Terms">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date"><Input type="date" value={d.doc_date ?? ''} onChange={(e) => set('doc_date', e.target.value)} /></Field>
            {type === 'quotation'
              ? <Field label="Valid until"><Input type="date" value={d.valid_until ?? ''} onChange={(e) => set('valid_until', e.target.value)} /></Field>
              : type === 'invoice' || type === 'debit_note'
                ? <Field label="Due date" hint="Leave empty to use the customer's terms"><Input type="date" value={d.due_date ?? ''} onChange={(e) => set('due_date', e.target.value)} /></Field>
                : <div />}
            {type === 'debit_note' && (
              <Field label="Against invoice" error={errors.related_document_id} className="sm:col-span-2">
                <RecordSelect source={{ path: '/documents', params: { doc_type: 'invoice' }, label: (r) => `${r.number ?? 'Draft'} · ${r.customer_name ?? ''}` }}
                  value={d.related_document_id} onChange={(v) => set('related_document_id', v)} />
              </Field>
            )}
            <Field label="Order discount %"><Input type="number" step="any" value={d.order_discount_pct ?? ''} onChange={(e) => set('order_discount_pct', e.target.value)} /></Field>
            <Field label="Delivery charge"><Input type="number" step="any" value={d.delivery_charge ?? ''} onChange={(e) => set('delivery_charge', e.target.value)} /></Field>
            <Field label="Notes" className="sm:col-span-2"><Textarea className="min-h-14" value={d.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></Field>
            <Field label="Terms" className="sm:col-span-2" hint="Leave empty to use the company's standard terms"><Textarea className="min-h-14" value={d.terms ?? ''} onChange={(e) => set('terms', e.target.value)} /></Field>
          </div>
        </Card>
      </div>
    </>
  )
}
