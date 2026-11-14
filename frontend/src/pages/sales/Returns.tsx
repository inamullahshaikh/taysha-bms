import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { date, label, money, pct, qty } from '../../lib/format'
import { productLabel, useAction, useRefMap } from '../../lib/hooks'
import { BarList, ChartCard, StatTile } from '../../ui/charts'
import { DataTable } from '../../ui/DataTable'
import { LookupSelect, type FieldDef } from '../../ui/Form'
import { Button, Card, Confirm, ErrorNote, Facts, Field, Loading, Select, Status } from '../../ui/kit'
import { Attachments, History, RecordHeader, RecordLayout } from '../../ui/Record'
import { FormDrawer } from '../../ui/Resource'

export default function Returns() {
  const { data: s } = useQuery({ queryKey: ['/reports/returns', 'year'], queryFn: () => api.get('/reports/returns', { range: 'year' }) })
  const reasons = Object.entries(s?.reasons ?? {}).map(([k, v]) => ({ label: label(k), value: v as number }))
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="grid grid-cols-2 gap-3">
          <StatTile label="Returns this year" value={s?.returns ?? '—'} sub={s ? `of ${s.orders_shipped} orders shipped` : undefined} />
          <StatTile label="Return rate" value={s ? pct(s.return_rate_pct) : '—'} upIsGood={false} />
          <StatTile label="Refunds" value={s?.refunds ?? '—'} />
          <StatTile label="Refund rate" value={s ? pct(s.refund_rate_pct) : '—'} />
        </div>
        <ChartCard title="Why customers return" sub="This year">
          <BarList items={reasons} fmt={(v) => String(v)} empty="No returns this year" />
        </ChartCard>
      </div>
      <DataTable
        path="/returns"
        search="Search return number"
        rowTo={(r: any) => `/returns/${r.id}`}
        empty={{ title: 'No returns', body: 'Start a return from a dispatched or delivered order.' }}
        filters={[{ key: 'status', label: 'Status', options: ['requested', 'received', 'completed', 'rejected'] }]}
        columns={[
          { key: 'number', label: 'Return', render: (r: any) => <span className="font-medium">{r.number}</span> },
          { key: 'created_at', label: 'Opened', render: (r: any) => date(r.created_at) },
          { key: 'reason', label: 'Reason', render: (r: any) => label(r.reason) },
          { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} /> },
          { key: 'resolution', label: 'Outcome', render: (r: any) => (r.resolution ? label(r.resolution) : '—') },
          { key: 'refund_amount', label: 'Refund', align: 'right', render: (r: any) => (Number(r.refund_amount) ? money(r.refund_amount) : '—') },
        ]}
      />
    </div>
  )
}

const CONDITIONS = ['unopened', 'opened', 'damaged', 'expired', 'other']
const DISPOSITIONS = [{ value: 'restock', label: 'Back to stock' }, { value: 'damaged', label: 'Damaged stock' }, { value: 'dispose', label: 'Dispose' }]
const COMPLETE_FIELDS: FieldDef[] = [
  { name: 'resolution', label: 'Outcome', type: 'select', required: true, options: [
    { value: 'refund', label: 'Refund' }, { value: 'credit_note', label: 'Credit note' }, { value: 'replacement', label: 'Send a replacement' }, { value: 'none', label: 'No action' },
  ] },
  { name: 'refund_amount', label: 'Refund amount', type: 'money', show: (v) => v.resolution === 'refund', hint: 'Leave empty to refund the returned items in full' },
  { name: 'refund_method', label: 'Refund method', type: 'select', options: ['cash', 'card', 'bank_transfer', 'online', 'other'], show: (v) => v.resolution === 'refund' },
  { name: 'note', label: 'Note', type: 'textarea' },
]

export function ReturnDetail() {
  const id = Number(useParams().id)
  const can = useCan()
  const key = [`/returns/${id}`]
  const qc = useQueryClient()
  const product = useRefMap('/products', productLabel)
  const { data: r, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/returns/${id}`) })
  const [inspect, setInspect] = useState<Record<number, { condition: string; disposition: string }>>({})
  const [warehouse, setWarehouse] = useState('')
  const [completing, setCompleting] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const opts = { invalidate: [key, ['/returns']] }
  const receive = useAction(() => api.post(`/returns/${id}/receive`, {
    warehouse_id: warehouse ? Number(warehouse) : undefined,
    lines: r.lines.map((l: any) => ({ line_id: l.id, condition: inspect[l.id]?.condition ?? 'unopened', disposition: inspect[l.id]?.disposition ?? 'restock' })),
  }), { ...opts, success: 'Items received and inspected' })
  const reject = useAction((note: string) => api.post(`/returns/${id}/reject`, { resolution: 'none', note }), { ...opts, success: 'Return rejected', onSuccess: () => setRejecting(false) })

  if (isLoading) return <Loading />
  if (error) return <ErrorNote error={error} />
  const edit = can('returns', 'edit')
  const setLine = (lid: number, k: 'condition' | 'disposition', v: string) =>
    setInspect((s) => ({ ...s, [lid]: { ...(s[lid] ?? { condition: 'unopened', disposition: 'restock' }), [k]: v } }))

  return (
    <>
      <RecordHeader back="/returns" backLabel="Returns" title={r.number} status={<Status value={r.status} />}
        meta={`${label(r.reason)} · opened ${date(r.created_at)}`}
        actions={edit && <>
          {['requested', 'received'].includes(r.status) && <Button onClick={() => setRejecting(true)}>Reject</Button>}
          {r.status === 'requested' && <Button variant="primary" loading={receive.isPending} onClick={() => receive.mutate(undefined)}>Receive items</Button>}
          {r.status === 'received' && <Button variant="primary" onClick={() => setCompleting(true)}>Resolve</Button>}
        </>} />
      <RecordLayout
        main={<>
          <Card title={r.status === 'requested' ? 'Inspect items' : 'Items'} pad={false}>
            <div className="scroll-quiet overflow-x-auto">
              <table className="w-full text-[13.5px]">
                <thead><tr className="border-b border-line text-left text-[12px] text-muted">
                  <th className="px-4 py-2 font-medium">Product</th><th className="px-3 py-2 text-right font-medium">Qty</th>
                  <th className="px-3 py-2 font-medium">Condition</th><th className="px-4 py-2 font-medium">Goes to</th>
                </tr></thead>
                <tbody>
                  {r.lines.map((l: any) => (
                    <tr key={l.id} className="border-b border-line last:border-0">
                      <td className="px-4 py-2.5">{product(l.product_id)}</td>
                      <td className="tabular px-3 py-2.5 text-right">{qty(l.quantity)}</td>
                      {r.status === 'requested' && edit ? <>
                        <td className="px-2 py-1.5"><Select aria-label="Condition" value={inspect[l.id]?.condition ?? 'unopened'} onChange={(e) => setLine(l.id, 'condition', e.target.value)} options={CONDITIONS} /></td>
                        <td className="px-2 py-1.5 pr-4"><Select aria-label="Goes to" value={inspect[l.id]?.disposition ?? 'restock'} onChange={(e) => setLine(l.id, 'disposition', e.target.value)} options={DISPOSITIONS} /></td>
                      </> : <>
                        <td className="px-3 py-2.5">{l.condition ? label(l.condition) : '—'}</td>
                        <td className="px-4 py-2.5">{l.disposition ? DISPOSITIONS.find((d) => d.value === l.disposition)?.label : '—'}</td>
                      </>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {r.status === 'requested' && edit && (
              <div className="border-t border-line p-4">
                <Field label="Receive into" hint="Leave empty for the order's warehouse" className="max-w-xs">
                  <LookupSelect kind="warehouses" value={warehouse} onChange={setWarehouse} />
                </Field>
              </div>
            )}
          </Card>
        </>}
        side={<>
          <Card title="Details">
            <Facts cols={1} items={[
              ['Order', <Link to={`/orders/${r.order_id}`} className="text-wine-700 hover:underline">View order</Link>],
              ['Customer', r.customer_id ? <Link to={`/customers/${r.customer_id}`} className="text-wine-700 hover:underline">View customer</Link> : undefined],
              ['Reason', r.reason_note ?? label(r.reason)],
              ['Outcome', r.resolution ? label(r.resolution) : undefined],
              ['Refund', Number(r.refund_amount) ? money(r.refund_amount) : undefined],
              ['Credit note', r.credit_note_id ? <Link to={`/documents/${r.credit_note_id}`} className="text-wine-700 hover:underline">View credit note</Link> : undefined],
              ['Replacement', r.replacement_order_id ? <Link to={`/orders/${r.replacement_order_id}`} className="text-wine-700 hover:underline">View replacement order</Link> : undefined],
              ['Decision note', r.decision_note ?? undefined],
            ]} />
          </Card>
          <Attachments entity="returns" id={id} canEdit={edit} />
          <History entity="returns" id={id} />
        </>} />
      <FormDrawer open={completing} onClose={() => setCompleting(false)} title="Resolve return" fields={COMPLETE_FIELDS} initial={{ resolution: 'refund', refund_method: 'cash' }}
        submitLabel="Resolve" submit={async (b) => { await api.post(`/returns/${id}/complete`, b); qc.invalidateQueries({ queryKey: key }) }} />
      <Confirm open={rejecting} onClose={() => setRejecting(false)} danger title="Reject this return?" confirmLabel="Reject"
        note={{ label: 'Reason', required: true }} loading={reject.isPending} onConfirm={(n) => reject.mutate(n)} />
    </>
  )
}
