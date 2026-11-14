import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, Check, Phone, Plus, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { date, dateTime, money } from '../../lib/format'
import { useAction, useUrlState } from '../../lib/hooks'
import { DataTable } from '../../ui/DataTable'
import { USERS, type FieldDef } from '../../ui/Form'
import { Badge, Button, Card, Checkbox, Confirm, Empty, ErrorNote, Field, Input, Loading, Segmented, Status, cx } from '../../ui/kit'
import { History, RecordHeader } from '../../ui/Record'
import { FormDrawer, ResourcePage } from '../../ui/Resource'
import { useToast } from '../../ui/toast'
import { Address } from './common'

const ROUTE_FIELDS: FieldDef[] = [
  { name: 'route_date', label: 'Date', type: 'date' },
  { name: 'vehicle', label: 'Vehicle', placeholder: 'Bike LEA-1234' },
  { name: 'driver_name', label: 'Rider / driver' },
  { name: 'driver_user_id', label: 'Rider login', type: 'record', record: USERS, hint: 'Lets them update stops from their phone' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
]

export default function Deliveries() {
  const [view, setView] = useUrlState('view', 'routes')
  return (
    <div className="flex flex-col gap-4">
      <div><Segmented value={view as 'routes' | 'territories'} onChange={setView}
        options={[{ value: 'routes', label: 'Delivery runs' }, { value: 'territories', label: 'Territories' }]} /></div>
      {view === 'territories' ? (
        <ResourcePage path="/territories" feature="distribution" noun="territory" search="Search territories"
          fields={[{ name: 'name', label: 'Name', required: true, full: true }, { name: 'description', label: 'Areas covered', type: 'textarea' }]}
          columns={[{ key: 'name', label: 'Territory', render: (r: any) => <span className="font-medium">{r.name}</span> }, { key: 'description', label: 'Areas covered' }]} />
      ) : <Routes />}
    </div>
  )
}

function Routes() {
  const can = useCan()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [picked, setPicked] = useState<number[]>([])
  const ready = useQuery({
    queryKey: ['/orders', 'deliverable'],
    queryFn: () => api.get('/orders', { open_only: true, page_size: 200, sort: 'order_date' }),
    enabled: creating,
  })
  const orders = (ready.data?.items ?? []).filter((o: any) => ['confirmed', 'processing', 'packed', 'dispatched'].includes(o.status))
  return (
    <>
      <DataTable path="/routes" search="Search run or rider" rowTo={(r: any) => `/routes/${r.id}`}
        filters={[{ key: 'status', label: 'Status', options: [{ value: 'planned', label: 'Planned' }, { value: 'out', label: 'Out for delivery' }, { value: 'completed', label: 'Completed' }] }, { key: 'route_date', label: 'Date', type: 'date' }]}
        empty={{ title: 'No delivery runs', body: 'Group packed orders into a run for a rider, then mark each stop delivered.' }}
        toolbar={can('distribution', 'edit') && <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => { setPicked([]); setCreating(true) }}>New run</Button>}
        columns={[
          { key: 'number', label: 'Run', render: (r: any) => <span className="font-medium">{r.number}</span> },
          { key: 'route_date', label: 'Date', render: (r: any) => date(r.route_date) },
          { key: 'driver_name', label: 'Rider', render: (r: any) => r.driver_name ?? '—' },
          { key: 'stops', label: 'Stops', render: (r: any) => {
            const done = r.stops.filter((s: any) => s.status !== 'pending').length
            return <span className="tabular">{done}/{r.stops.length}</span>
          } },
          { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status === 'out' ? 'in_transit' : r.status} /> },
          { key: 'cod_total', label: 'Cash collected', align: 'right', render: (r: any) => money(r.cod_total) },
        ]} />
      <FormDrawer open={creating} onClose={() => setCreating(false)} title="New delivery run" fields={ROUTE_FIELDS} wide submitLabel="Create run"
        submit={async (b) => { const r = await api.post('/routes', { ...b, order_ids: picked }); navigate(`/routes/${r.id}`) }}>
        <div>
          <p className="mb-1.5 text-[12.5px] font-medium text-ink-2">Orders on this run, in stop order ({picked.length})</p>
          <div className="scroll-quiet max-h-80 overflow-y-auto rounded-lg border border-line">
            {ready.isLoading ? <Loading /> : !orders.length ? <Empty title="No orders ready to deliver" /> : (
              <ul className="divide-y divide-line">
                {orders.map((o: any) => (
                  <li key={o.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                    <Checkbox checked={picked.includes(o.id)} onChange={() => setPicked((p) => (p.includes(o.id) ? p.filter((x) => x !== o.id) : [...p, o.id]))}
                      label={<span><span className="font-medium">{o.number}</span> · {o.customer_name ?? 'Walk-in'}</span>} />
                    <span className="ml-auto flex items-center gap-2">
                      {picked.includes(o.id) && <Badge tone="brand">Stop {picked.indexOf(o.id) + 1}</Badge>}
                      <Status value={o.status} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </FormDrawer>
    </>
  )
}

export function RouteDetail() {
  const id = Number(useParams().id)
  const can = useCan()
  const key = [`/routes/${id}`]
  const { data: r, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/routes/${id}`) })
  const opts = { invalidate: [key, ['/routes']] }
  const start = useAction(() => api.post(`/routes/${id}/start`), { ...opts, success: 'Run started' })
  const complete = useAction(() => api.post(`/routes/${id}/complete`), { ...opts, success: 'Run completed' })
  if (isLoading) return <Loading />
  if (error) return <ErrorNote error={error} />
  const edit = can('distribution', 'edit')
  const done = r.stops.filter((s: any) => s.status !== 'pending').length
  return (
    <>
      <RecordHeader back="/routes" backLabel="Deliveries" title={r.number} status={<Status value={r.status === 'out' ? 'in_transit' : r.status} />}
        meta={[date(r.route_date), r.driver_name, r.vehicle, `${done} of ${r.stops.length} stops done`, `${money(r.cod_total)} collected`].filter(Boolean).join(' · ')}
        actions={edit && <>
          {r.status === 'planned' && <Button variant="primary" loading={start.isPending} onClick={() => start.mutate(undefined)}>Start run</Button>}
          {r.status === 'out' && <Button variant="primary" disabled={done < r.stops.length} loading={complete.isPending} onClick={() => complete.mutate(undefined)}>Finish run</Button>}
        </>} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <ol className="flex flex-col gap-3">
          {r.stops.map((s: any) => <Stop key={s.id} routeId={id} s={s} canEdit={edit && r.status === 'out'} />)}
        </ol>
        <aside className="flex flex-col gap-4">
          {r.notes && <Card title="Notes"><p className="text-[13px] whitespace-pre-wrap">{r.notes}</p></Card>}
          <History entity="delivery_routes" id={id} />
        </aside>
      </div>
    </>
  )
}

function Stop({ routeId, s, canEdit }: { routeId: number; s: any; canEdit: boolean }) {
  const qc = useQueryClient()
  const toast = useToast()
  const file = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [failing, setFailing] = useState(false)
  const [recipient, setRecipient] = useState('')
  const [cod, setCod] = useState(Number(s.cod_due) ? s.cod_due : '')
  const [photo, setPhoto] = useState<string>()
  const refresh = () => qc.invalidateQueries({ queryKey: [`/routes/${routeId}`] })
  const deliver = useAction(() => api.post(`/routes/${routeId}/stops/${s.id}/deliver`, { recipient_name: recipient || undefined, cod_collected: cod || 0 }),
    { success: 'Delivered', onSuccess: () => { setOpen(false); refresh() } })
  const fail = useAction((reason: string) => api.post(`/routes/${routeId}/stops/${s.id}/fail`, { reason }), { success: 'Marked as not delivered', onSuccess: () => { setFailing(false); refresh() } })
  const upload = async (f?: File) => {
    if (!f) return
    const fd = new FormData()
    fd.append('file', f)
    try {
      await api.post('/attachments', fd, { entity_type: 'route_stops', entity_id: s.id, category: 'proof_of_delivery' })
      setPhoto(f.name)
    } catch (e) { toast(e instanceof Error ? e.message : 'Upload failed', 'error') }
  }
  return (
    <li className={cx('rounded-card bg-surface p-4 shadow-card', s.status !== 'pending' && 'opacity-80')}>
      <div className="flex items-start gap-3">
        <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold',
          s.status === 'delivered' ? 'bg-good-bg text-good' : s.status === 'failed' ? 'bg-bad-bg text-bad' : 'bg-wine-100 text-wine-800')}>
          {s.status === 'delivered' ? <Check className="size-4" /> : s.status === 'failed' ? <X className="size-4" /> : s.seq}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{s.customer ?? 'Walk-in'}</p>
            <Link to={`/orders/${s.order_id}`} className="text-[12.5px] text-wine-700 hover:underline">{s.order}</Link>
            {Number(s.cod_due) > 0 && s.status === 'pending' && <Badge tone="warn">Collect {money(s.cod_due)}</Badge>}
          </div>
          <div className="mt-1 text-[13px] text-ink-2"><Address a={s.address} /></div>
          {s.status === 'delivered' && <p className="mt-1 text-[12.5px] text-good">Delivered {dateTime(s.delivered_at)}{s.recipient_name ? ` to ${s.recipient_name}` : ''}{Number(s.cod_collected) ? ` · ${money(s.cod_collected)} collected` : ''}</p>}
          {s.status === 'failed' && <p className="mt-1 text-[12.5px] text-bad">Not delivered: {s.failure_reason}</p>}
        </div>
        {s.phone && <a href={`tel:${s.phone}`} aria-label={`Call ${s.customer}`} className="inline-flex size-10 items-center justify-center rounded-lg border border-line-strong text-ink-2 hover:bg-wine-50"><Phone className="size-4" /></a>}
      </div>
      {canEdit && s.status === 'pending' && (
        open ? (
          <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
            <Field label="Received by"><Input value={recipient} onChange={(e) => setRecipient(e.target.value)} /></Field>
            <Field label="Cash collected"><Input type="number" inputMode="decimal" value={cod} onChange={(e) => setCod(e.target.value)} /></Field>
            <div className="sm:col-span-2">
              <Button icon={<Camera className="size-4" />} onClick={() => file.current?.click()}>{photo ? 'Photo added' : 'Add photo or signature'}</Button>
              <input ref={file} type="file" accept="image/*" capture="environment" hidden onChange={(e) => upload(e.target.files?.[0])} />
            </div>
            <div className="flex gap-2 sm:col-span-2">
              <Button className="h-11 flex-1" onClick={() => setOpen(false)}>Back</Button>
              <Button variant="primary" className="h-11 flex-1" loading={deliver.isPending} onClick={() => deliver.mutate(undefined)}>Confirm delivered</Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex gap-2">
            <Button className="h-11 flex-1" onClick={() => setFailing(true)}>Couldn't deliver</Button>
            <Button variant="primary" className="h-11 flex-1" onClick={() => setOpen(true)}>Delivered</Button>
          </div>
        )
      )}
      <Confirm open={failing} onClose={() => setFailing(false)} title="Why couldn't it be delivered?" confirmLabel="Save"
        note={{ label: 'Reason', required: true }} loading={fail.isPending} onConfirm={(r) => fail.mutate(r)} />
    </li>
  )
}
