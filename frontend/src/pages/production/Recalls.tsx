import { useQuery } from '@tanstack/react-query'
import { ArrowDownRight, Factory, PackageCheck, ShoppingBag, Truck } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { date, dateTime, qty } from '../../lib/format'
import { useAction, useUrlState } from '../../lib/hooks'
import { StatTile } from '../../ui/charts'
import { DataTable } from '../../ui/DataTable'
import { Button, Card, Confirm, ErrorNote, Facts, Field, Loading, Segmented, Status } from '../../ui/kit'
import { History, RecordHeader, RecordLayout } from '../../ui/Record'
import { SimpleTable, TableCard } from '../reports/shared'
import { BatchPicker } from './Quality'

export default function Recalls() {
  return (
    <div className="flex flex-col gap-4">
      <Trace />
      <DataTable
        path="/recalls"
        search={false}
        rowTo={(r: any) => `/recalls/${r.id}`}
        empty={{ title: 'No recalls', body: 'Trace a batch above to see where it went before starting one.' }}
        columns={[
          { key: 'number', label: 'Recall', className: 'font-medium' },
          { key: 'reason', label: 'Reason', render: (r: any) => <span className="line-clamp-1">{r.reason}</span> },
          { key: 'affected', label: 'Orders affected', align: 'right', render: (r: any) => r.affected?.orders?.length ?? 0 },
          { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} /> },
          { key: 'created_at', label: 'Started', render: (r: any) => date(r.created_at) },
        ]}
      />
    </div>
  )
}

function Trace() {
  const can = useCan()
  const navigate = useNavigate()
  const [batch, setBatch] = useUrlState('batch')
  const [batchLabel, setBatchLabel] = useState('')
  const [dir, setDir] = useUrlState('direction', 'forward')
  const [recalling, setRecalling] = useState(false)
  const { data, isLoading, error } = useQuery({
    queryKey: ['/trace', batch, dir], queryFn: () => api.get(`/trace/batches/${batch}`, { direction: dir }), enabled: !!batch,
  })
  const start = useAction((reason: string) => api.post('/recalls', { batch_id: Number(batch), reason }), {
    success: 'Recall started; affected batches are on hold', onSuccess: (r: any) => navigate(`/recalls/${r.id}`),
  })
  const tree = dir === 'forward' ? data?.tree : data
  return (
    <Card title="Trace a batch" action={
      <Segmented options={[{ value: 'forward', label: 'Where it went' }, { value: 'backward', label: 'Where it came from' }]} value={dir} onChange={setDir} />
    }>
      <div className="flex flex-col gap-4">
        <Field label="Batch" className="max-w-md"><BatchPicker value={batch} label={batchLabel || (data && (dir === 'forward' ? data.tree?.batch : data.batch))} onChange={(v, l) => { setBatch(v); setBatchLabel(l) }} /></Field>
        {!batch ? null : error ? <ErrorNote error={error} /> : isLoading || !tree ? <Loading /> : (
          <>
            {dir === 'forward' && (
              <div className="flex flex-wrap items-stretch gap-3">
                <div className="grid flex-1 grid-cols-3 gap-3">
                  <StatTile label="Batches involved" value={data.affected_batches.length} />
                  <StatTile label="Orders" value={data.affected_orders.length} />
                  <StatTile label="Customers" value={data.affected_customers} />
                </div>
                {can('quality', 'edit') && <Button variant="danger" className="self-center" onClick={() => setRecalling(true)}>Start recall</Button>}
              </div>
            )}
            <div className="rounded-lg border border-line p-3">
              {dir === 'forward' ? <Forward node={tree} /> : <Backward node={tree} />}
            </div>
          </>
        )}
      </div>
      <Confirm open={recalling} onClose={() => setRecalling(false)} danger confirmLabel="Start recall" title="Start a recall?" loading={start.isPending}
        body="Every batch made from this one is put on hold, and the affected orders are listed for follow-up."
        note={{ label: 'Reason', required: true }} onConfirm={(reason) => start.mutate(reason, { onSettled: () => setRecalling(false) })} />
    </Card>
  )
}

function Row({ icon, children, sub }: { icon: ReactNode; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-wine-50 text-wine-700 [&_svg]:size-3.5">{icon}</span>
      <div className="min-w-0 text-[13.5px]">{children}{sub && <p className="text-[12px] text-muted">{sub}</p>}</div>
    </div>
  )
}

const Branch = ({ children }: { children: ReactNode }) => <div className="ml-3 border-l border-line pl-4">{children}</div>

const BatchHead = ({ n }: { n: any }) => (
  <Row icon={<PackageCheck />} sub={[n.mfg_date && `made ${date(n.mfg_date)}`, n.expiry_date && `best before ${date(n.expiry_date)}`, n.supplier && `from ${n.supplier}`].filter(Boolean).join(' · ')}>
    <Link to={`/stock/batches/${n.batch_id}`} className="font-medium hover:text-wine-800">{n.batch}</Link>
    <span className="text-ink-2"> · {n.product}</span> <Status value={n.status} />
  </Row>
)

function Forward({ node }: { node: any }) {
  return (
    <div>
      <BatchHead n={node} />
      <Branch>
        {node.used_in.map((u: any) => (
          <div key={u.production_order_id}>
            <Row icon={<Factory />} sub={`used ${qty(u.quantity_used)}`}>
              Made into <Link to={`/production-orders/${u.production_order_id}`} className="font-medium hover:text-wine-800">{u.number}</Link>
            </Row>
            {u.output_batch && <Branch><Forward node={u.output_batch} /></Branch>}
          </div>
        ))}
        {node.sales.map((s: any, i: number) => (
          <Row key={i} icon={<ShoppingBag />} sub={`${qty(s.quantity)} units · shipped ${dateTime(s.date)}${s.phone ? ` · ${s.phone}` : ''}`}>
            <Link to={`/orders/${s.order_id}`} className="font-medium hover:text-wine-800">{s.order}</Link>
            <span className="text-ink-2"> · {s.customer ?? 'Walk-in'}</span>
          </Row>
        ))}
        {!node.used_in.length && !node.sales.length && <p className="py-1.5 text-[12.5px] text-muted">Not used or sold yet</p>}
      </Branch>
    </div>
  )
}

function Backward({ node }: { node: any }) {
  if (!node.batch) return <Row icon={<ArrowDownRight />} sub={`used ${qty(node.quantity_used)} · no batch recorded`}>{node.product}</Row>
  return (
    <div>
      <BatchHead n={node} />
      <Branch>
        {node.received.map((g: any, i: number) => (
          <Row key={i} icon={<Truck />} sub={`${qty(g.quantity)} received ${date(g.date)}${g.qc_result ? ` · QC ${g.qc_result}` : ''}`}>
            Goods receipt <span className="font-medium">{g.goods_receipt}</span><span className="text-ink-2"> · {g.supplier}</span>
          </Row>
        ))}
        {node.made_by && (
          <>
            <Row icon={<Factory />} sub={`completed ${dateTime(node.made_by.completed_at)}`}>
              Made by <Link to={`/production-orders/${node.made_by.production_order_id}`} className="font-medium hover:text-wine-800">{node.made_by.number}</Link>
            </Row>
            <Branch>{node.made_by.inputs.map((n: any, i: number) => <Backward key={i} node={n} />)}</Branch>
          </>
        )}
      </Branch>
    </div>
  )
}

export function Recall() {
  const id = Number(useParams().id)
  const can = useCan()
  const [closing, setClosing] = useState(false)
  const { data: r, isLoading, error } = useQuery({ queryKey: [`/recalls/${id}`], queryFn: () => api.get(`/recalls/${id}`) })
  const close = useAction((disposal_decision: string) => api.post(`/recalls/${id}/close`, { disposal_decision }), { success: 'Recall closed' })
  if (error) return <ErrorNote error={error} />
  if (isLoading || !r) return <Loading />
  const orders = r.affected?.orders ?? []
  return (
    <>
      <RecordHeader back="/recalls" backLabel="Recalls & trace" title={r.number} status={<Status value={r.status} />} meta={`Started ${dateTime(r.created_at)}`}
        actions={r.status !== 'closed' && can('quality', 'edit') && <Button variant="primary" onClick={() => setClosing(true)}>Close recall</Button>} />
      <RecordLayout
        main={<>
          <TableCard title={`Orders to contact · ${orders.length}`}>
            <SimpleTable rows={orders} empty="No orders shipped from these batches" cols={[
              { key: 'order', label: 'Order', render: (o: any) => <Link to={`/orders/${o.order_id}`} className="font-medium hover:text-wine-800">{o.order}</Link> },
              { key: 'customer', label: 'Customer', render: (o: any) => o.customer ?? 'Walk-in' },
              { key: 'phone', label: 'Phone', render: (o: any) => o.phone ?? '—' },
              { key: 'quantity', label: 'Units', align: 'right', render: (o: any) => qty(o.quantity) },
              { key: 'date', label: 'Shipped', render: (o: any) => date(o.date) },
            ]} />
          </TableCard>
          <TableCard title="Batches held">
            <SimpleTable rows={r.affected?.batches ?? []} cols={[
              { key: 'batch', label: 'Batch', render: (b: any) => <Link to={`/stock/batches/${b.batch_id}`} className="font-medium hover:text-wine-800">{b.batch}</Link> },
              { key: 'product', label: 'Product' },
              { key: 'status', label: 'Status at recall', render: (b: any) => <Status value={b.status} /> },
            ]} />
          </TableCard>
        </>}
        side={<>
          <Card title="Recall">
            <Facts cols={1} items={[
              ['Reason', <span className="whitespace-pre-line">{r.reason}</span>],
              ['Disposal decision', r.disposal_decision ?? '—'],
              ['Closed', dateTime(r.closed_at)],
            ]} />
          </Card>
          <History entity="recalls" id={id} />
        </>}
      />
      <Confirm open={closing} onClose={() => setClosing(false)} title="Close this recall?" confirmLabel="Close recall" loading={close.isPending}
        note={{ label: 'What happened to the stock', required: true }} onConfirm={(d) => close.mutate(d, { onSettled: () => setClosing(false) })} />
    </>
  )
}
