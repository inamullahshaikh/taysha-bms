import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileDown, Mail, Wallet } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, openFile } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { compactMoney, date, label, money, today } from '../../lib/format'
import { useAction } from '../../lib/hooks'
import { ChartCard, SegmentBar, TrendChart } from '../../ui/charts'
import type { FieldDef } from '../../ui/Form'
import { Button, Card, Drawer, Empty, Field, Input, Loading, Segmented, Select } from '../../ui/kit'
import { FormDrawer } from '../../ui/Resource'
import { useToast } from '../../ui/toast'
import { Amount, ExportMenu } from './shared'

/** Age buckets are ordered, so one hue light → dark (older is darker). */
const BUCKETS = [
  { key: 'current', label: 'Not yet due', color: '#e3b3bd' },
  { key: '1_30', label: '1–30 days', color: '#cc8496' },
  { key: '31_60', label: '31–60 days', color: '#b05a70' },
  { key: '61_90', label: '61–90 days', color: '#8c2f45' },
  { key: 'over_90', label: 'Over 90 days', color: '#581c28' },
]

export default function Receivables() {
  const { can } = useAuth()
  const kinds = [can('invoices') && { value: 'ar', label: 'Customers owe us' }, can('supplier_bills') && { value: 'ap', label: 'We owe suppliers' }].filter(Boolean) as { value: 'ar' | 'ap'; label: string }[]
  const [kind, setKind] = useState<'ar' | 'ap'>(kinds[0]?.value ?? 'ar')
  const [asOf, setAsOf] = useState(today())
  const [customer, setCustomer] = useState<{ id: number; name: string } | null>(null)
  const path = kind === 'ar' ? '/reports/receivables-aging' : '/reports/payables-aging'
  const { data } = useQuery({ queryKey: [path, asOf], queryFn: () => api.get(path, { as_of: asOf }) })

  const rows: any[] = data?.rows ?? []
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {kinds.length > 1 && <Segmented options={kinds} value={kind} onChange={setKind} />}
          <label className="flex items-center gap-2 text-[12.5px] text-muted">As of
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)}
              className="h-8 rounded-lg border border-line bg-surface px-2 text-[13px] text-ink focus:border-wine-600 focus:outline-none" />
          </label>
        </div>
        <ExportMenu feature={kind === 'ar' ? 'invoices' : 'supplier_bills'} path={path} params={{ as_of: asOf }} />
      </div>

      {!data ? <Loading /> : (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
            <ChartCard title={kind === 'ar' ? 'Owed to us' : 'We owe'} sub={`${compactMoney(data.totals.total)} across ${rows.length} ${kind === 'ar' ? 'customers' : 'suppliers'}`}>
              <SegmentBar fmt={(v) => compactMoney(v)} parts={BUCKETS.map((b) => ({ label: b.label, value: data.totals[b.key], color: b.color }))} />
              <p className="mt-4 text-[12.5px] text-ink-2">
                {compactMoney(Number(data.totals['61_90']) + Number(data.totals.over_90))} is more than 60 days late.
              </p>
            </ChartCard>
            <ChartCard title="Who owes the most" sub="By age of the balance">
              {rows.length ? (
                <TrendChart data={rows.slice(0, 8)} x="name" kind="bar" stacked height={220} fmt={(v) => money(v)}
                  xFmt={(v) => (v.length > 14 ? `${v.slice(0, 13)}…` : v)}
                  series={BUCKETS.map((b) => ({ key: b.key, label: b.label, color: b.color }))} />
              ) : <Empty title="Nothing outstanding" />}
            </ChartCard>
          </div>

          <Card pad={false}>
            <div className="scroll-quiet overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-[12px] text-muted">
                    <th className="h-9 px-4 font-medium">{kind === 'ar' ? 'Customer' : 'Supplier'}</th>
                    {BUCKETS.map((b) => <th key={b.key} className="px-3 text-right font-medium whitespace-nowrap">{b.label}</th>)}
                    <th className="px-4 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={`border-b border-line ${kind === 'ar' ? 'cursor-pointer hover:bg-wine-50/60' : ''}`}
                      onClick={() => (kind === 'ar' ? setCustomer({ id: r.id, name: r.name }) : undefined)}>
                      <td className="h-11 px-4 font-medium">
                        {kind === 'ap' ? <Link to={`/suppliers/${r.id}`} className="hover:text-wine-800">{r.name}</Link> : r.name}
                      </td>
                      {BUCKETS.map((b) => <td key={b.key} className="px-3 text-right">{Number(r[b.key]) ? <Amount v={r[b.key]} /> : <span className="text-muted">–</span>}</td>)}
                      <td className="px-4 text-right"><Amount v={r.total} strong /></td>
                    </tr>
                  ))}
                  <tr className="bg-page font-semibold">
                    <td className="h-11 px-4">Total</td>
                    {BUCKETS.map((b) => <td key={b.key} className="px-3 text-right"><Amount v={data.totals[b.key]} /></td>)}
                    <td className="px-4 text-right"><Amount v={data.totals.total} strong /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
      {customer && <Statement customer={customer} onClose={() => setCustomer(null)} />}
    </div>
  )
}

const PAY_FIELDS: FieldDef[] = [
  { name: 'amount', label: 'Amount', type: 'money', required: true },
  { name: 'method', label: 'Method', type: 'select', required: true, options: ['cash', 'card', 'bank_transfer', 'cod', 'online', 'cheque', 'other'] },
  { name: 'payment_date', label: 'Date', type: 'date' },
  { name: 'reference', label: 'Reference' },
  { name: 'note', label: 'Note', type: 'textarea' },
]

/** Customer statement with PDF/email, on-account payments and allocation to invoices. */
function Statement({ customer, onClose }: { customer: { id: number; name: string }; onClose: () => void }) {
  const { can } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [paying, setPaying] = useState(false)
  const range = { date_from: from || undefined, date_to: to || undefined }
  const base = `/customers/${customer.id}`
  const st = useQuery({ queryKey: [`${base}/statement`, range], queryFn: () => api.get(`${base}/statement`, range) })
  const unallocated = useQuery({ queryKey: [`${base}/unallocated-payments`], queryFn: () => api.get<any[]>(`${base}/unallocated-payments`), enabled: can('order_payments'), retry: false })
  const invoices = useQuery({ queryKey: ['/documents', 'unpaid', customer.id], queryFn: () => api.get('/documents', { customer_id: customer.id, doc_type: 'invoice', unpaid: true, page_size: 100 }) })
  const email = useAction(() => api.post(`${base}/statement/email`, range), { success: 'Statement emailed' })
  const allocate = useAction((v: { pay: number; inv: number }) => api.post(`/payments/${v.pay}/allocate`, { invoice_id: v.inv }), { success: 'Payment allocated' })

  return (
    <Drawer open onClose={onClose} title={`${customer.name} · statement`} wide
      footer={<>
        {can('order_payments', 'create') && <Button className="mr-auto" icon={<Wallet className="size-4" />} onClick={() => setPaying(true)}>Record payment</Button>}
        {can('invoices', 'edit') && <Button icon={<Mail className="size-4" />} loading={email.isPending} onClick={() => email.mutate(undefined)}>Email</Button>}
        <Button variant="primary" icon={<FileDown className="size-4" />} onClick={() => openFile(`${base}/statement`, { ...range, format: 'pdf' })}>PDF</Button>
      </>}>
      <div className="mb-4 flex flex-wrap gap-3">
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {!st.data ? <Loading /> : (
        <table className="w-full text-[13px]">
          <thead><tr className="border-b border-line text-left text-[12px] text-muted">
            <th className="py-2 font-medium">Date</th><th className="font-medium">Item</th><th className="text-right font-medium">Amount</th><th className="text-right font-medium">Balance</th>
          </tr></thead>
          <tbody>
            <tr className="border-b border-line"><td className="py-2 text-ink-2" colSpan={3}>Opening balance · {date(st.data.from)}</td><td className="text-right"><Amount v={st.data.opening_balance} /></td></tr>
            {st.data.lines.map((l: any, i: number) => (
              <tr key={i} className="border-b border-line">
                <td className="py-2 whitespace-nowrap">{date(l.date)}</td>
                <td>{label(l.type)} <span className="text-muted">{l.reference}</span></td>
                <td className="text-right"><Amount v={l.amount} /></td>
                <td className="text-right"><Amount v={l.balance} /></td>
              </tr>
            ))}
            <tr className="font-semibold"><td className="py-2.5" colSpan={3}>Closing balance · {date(st.data.to)}</td><td className="text-right"><Amount v={st.data.closing_balance} strong /></td></tr>
          </tbody>
        </table>
      )}

      {!!unallocated.data?.length && (
        <div className="mt-6">
          <h3 className="mb-2 text-[13px] font-semibold">Payments not matched to an invoice</h3>
          <ul className="flex flex-col gap-2">
            {unallocated.data.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1"><span className="font-medium">{p.number}</span> · {money(p.amount)} · {date(p.payment_date)}</span>
                {can('order_payments', 'create') && (
                  <Select className="h-8 w-56" placeholder="Allocate to invoice…" value=""
                    options={(invoices.data?.items ?? []).map((d: any) => ({ value: d.id, label: `${d.number} · ${money(d.balance_due)} due` }))}
                    onChange={(e) => e.target.value && allocate.mutate({ pay: p.id, inv: Number(e.target.value) })} />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <FormDrawer open={paying} onClose={() => setPaying(false)} title="Record payment on account" fields={PAY_FIELDS} initial={{ method: 'bank_transfer', payment_date: today() }}
        submit={async (body) => {
          await api.post(`${base}/payments`, body)
          toast('Payment recorded')
          qc.invalidateQueries({ queryKey: [`${base}/statement`] })
          qc.invalidateQueries({ queryKey: [`${base}/unallocated-payments`] })
          qc.invalidateQueries({ queryKey: ['/reports/receivables-aging'] })
        }} />
    </Drawer>
  )
}
