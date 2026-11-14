import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check, FileText, Play, Printer } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, openFile } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { dateTime, date, money, pct, qty, today } from '../../lib/format'
import { useAction, useLookupName, useRefMap } from '../../lib/hooks'
import { Meter } from '../../ui/charts'
import type { FieldDef } from '../../ui/Form'
import { Button, Card, Confirm, cx, ErrorNote, Facts, Input, Loading, Menu, MenuItem, Status } from '../../ui/kit'
import { Attachments, History, RecordHeader, RecordLayout } from '../../ui/Record'
import { FormDrawer } from '../../ui/Resource'
import { SimpleTable } from '../reports/shared'

export default function ProductionOrder() {
  const id = Number(useParams().id)
  const can = useCan()
  const warehouse = useLookupName('warehouses')
  const userName = useRefMap('/users')
  const { data: po, isLoading, error } = useQuery({ queryKey: [`/production-orders/${id}`], queryFn: () => api.get(`/production-orders/${id}`) })
  const [completing, setCompleting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const release = useAction(() => api.post(`/production-orders/${id}/release`), { success: 'Materials reserved' })
  const start = useAction(() => api.post(`/production-orders/${id}/start`), { success: 'Production started and materials issued' })
  const cancel = useAction((body: { reason: string }) => api.post(`/production-orders/${id}/cancel`, body), { success: 'Production order cancelled' })

  if (error) return <ErrorNote error={error} />
  if (isLoading || !po) return <Loading />
  const edit = can('production', 'edit')
  const short = po.materials.filter((m: any) => Number(m.shortage) > 0)
  const open = po.status === 'draft' || po.status === 'released'

  return (
    <>
      <RecordHeader back="/production-orders" backLabel="Production orders" title={po.number} status={<Status value={po.status} />}
        meta={<>{po.product_name} · {qty(po.planned_quantity)} units · <Link className="hover:text-wine-800" to={`/recipes/${po.recipe_id}`}>recipe v{po.recipe_version}</Link></>}
        actions={<>
          <Menu trigger={<Button icon={<Printer className="size-4" />}>Print</Button>}>
            <MenuItem icon={<FileText />} onClick={() => openFile(`/production-orders/${id}/pdf`, { doc: 'batch_sheet' })}>Batch sheet</MenuItem>
            <MenuItem icon={<FileText />} onClick={() => openFile(`/production-orders/${id}/pdf`, { doc: 'pick_list' })}>Ingredient pick list</MenuItem>
          </Menu>
          {edit && open && <Button variant="ghost" onClick={() => setCancelling(true)}>Cancel order</Button>}
          {edit && po.status === 'draft' && <Button loading={release.isPending} onClick={() => release.mutate(undefined)}>Reserve materials</Button>}
          {edit && open && <Button variant="primary" icon={<Play className="size-4" />} disabled={short.length > 0} loading={start.isPending}
            title={short.length ? 'Some materials are short' : undefined} onClick={() => start.mutate(undefined)}>Start production</Button>}
          {edit && po.status === 'in_progress' && <Button variant="primary" icon={<Check className="size-4" />} onClick={() => setCompleting(true)}>Record output</Button>}
        </>} />

      <RecordLayout
        main={<>
          {open && short.length > 0 && (
            <div className="flex items-start gap-2.5 rounded-card border border-warn/25 bg-warn-bg px-4 py-3 text-[13.5px] text-warn">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div><p className="font-medium">{short.length === 1 ? '1 material is short' : `${short.length} materials are short`}</p>
                <p className="text-ink-2">Production can't start until {short.map((m: any) => m.name).join(', ')} {short.length === 1 ? 'is' : 'are'} in stock. Raise a purchase or transfer.</p></div>
            </div>
          )}
          {po.stages.length > 0 && <Stages po={po} canEdit={edit} userName={userName} />}
          <Card title="Materials" pad={false}>
            <SimpleTable rows={po.materials} cols={[
              { key: 'name', label: 'Item', render: (m: any) => <Link to={`/products/${m.product_id}`} className="hover:text-wine-800">{m.name}</Link> },
              { key: 'required', label: 'Needed', align: 'right', render: (m: any) => qty(m.required) },
              { key: 'reserved', label: 'Reserved', align: 'right', render: (m: any) => qty(m.reserved) },
              { key: 'issued', label: 'Issued', align: 'right', render: (m: any) => qty(m.issued) },
              ...(po.status === 'completed'
                ? [{ key: 'actual', label: 'Used', align: 'right' as const, render: (m: any) => qty(m.actual) }]
                : [
                  { key: 'free_in_stock', label: 'Free stock', align: 'right' as const, render: (m: any) => qty(m.free_in_stock) },
                  { key: 'shortage', label: 'Short', align: 'right' as const, render: (m: any) => Number(m.shortage) > 0 ? <span className="font-semibold text-bad">{qty(m.shortage)}</span> : <span className="text-muted">—</span> },
                ]),
            ]} />
          </Card>
          {po.status === 'completed' && <Outcome po={po} />}
          {po.planned_cost != null && <Costs po={po} />}
        </>}
        side={<>
          <Card title="Details">
            <Facts cols={1} items={[
              ['Warehouse', warehouse(po.warehouse_id)],
              ['Planned start', date(po.planned_start)],
              ['Due', date(po.due_date)],
              ['Assigned to', po.assigned_to_id ? userName(po.assigned_to_id) : '—'],
              ['Started', dateTime(po.started_at)],
              ['Completed', dateTime(po.completed_at)],
              ['Source', po.source ?? '—'],
              ...(po.notes ? [['Notes', <span className="whitespace-pre-line">{po.notes}</span>] as [string, ReactNode]] : []),
            ]} />
          </Card>
          <Attachments entity="production_orders" id={id} canEdit={edit} />
          <History entity="production_orders" id={id} />
        </>}
      />

      <Complete open={completing} onClose={() => setCompleting(false)} po={po} />
      <Confirm open={cancelling} onClose={() => setCancelling(false)} danger title={`Cancel ${po.number}?`} confirmLabel="Cancel order"
        body="Reserved materials are released back to stock." note={{ label: 'Reason', required: true }} loading={cancel.isPending}
        onConfirm={(reason) => cancel.mutate({ reason }, { onSettled: () => setCancelling(false) })} />
    </>
  )
}

/** Big tap targets: this is used on a tablet at the production table. */
function Stages({ po, canEdit, userName }: { po: any; canEdit: boolean; userName: (id?: number | null) => string }) {
  const update = useAction(({ stage, status }: { stage: number; status: string }) =>
    api.patch(`/production-orders/${po.id}/stages/${stage}`, { status }))
  const live = po.status === 'in_progress' && canEdit
  const done = po.stages.filter((s: any) => s.status === 'done').length
  return (
    <Card title="Stages" action={<span className="text-[12.5px] text-muted">{done} of {po.stages.length} done</span>}>
      <div className="mb-4"><Meter value={done} max={po.stages.length} tone={done === po.stages.length ? 'good' : 'brand'} /></div>
      <ol className="flex flex-col gap-2">
        {po.stages.map((s: any) => (
          <li key={s.id} className={cx('flex flex-wrap items-center gap-3 rounded-lg border px-3.5 py-3',
            s.status === 'in_progress' ? 'border-wine-200 bg-wine-50' : 'border-line')}>
            <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold',
              s.status === 'done' ? 'bg-good-bg text-good' : s.status === 'in_progress' ? 'bg-wine-800 text-cream' : 'bg-sunken text-ink-2')}>
              {s.status === 'done' ? <Check className="size-4" /> : s.seq}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium">{s.name}</p>
              <p className="text-[12px] text-muted">
                {s.status === 'pending' ? 'Not started' : `${s.assigned_to_id ? userName(s.assigned_to_id) + ' · ' : ''}${s.finished_at ? `done ${dateTime(s.finished_at)}` : `started ${dateTime(s.started_at)}`}`}
              </p>
            </div>
            {live && s.status === 'pending' && <Button className="h-11 min-w-28" onClick={() => update.mutate({ stage: s.id, status: 'in_progress' })}>Start</Button>}
            {live && s.status === 'in_progress' && <Button variant="primary" className="h-11 min-w-28" onClick={() => update.mutate({ stage: s.id, status: 'done' })}>Mark done</Button>}
          </li>
        ))}
      </ol>
    </Card>
  )
}

function Outcome({ po }: { po: any }) {
  return (
    <Card title="Output">
      <Facts cols={4} items={[
        ['Made', qty(po.output_quantity)],
        ['Rejected', qty(po.rejected_quantity)],
        ['Wasted', qty(po.wastage_quantity)],
        ['Yield', pct(po.yield_pct)],
        ['Loss', pct(po.wastage_pct)],
        ['Labour', po.labour_minutes ? `${po.labour_minutes} min` : '—'],
        ['Batch', po.batch_id ? <Link to={`/stock/batches/${po.batch_id}`} className="text-wine-700 hover:underline">View batch</Link> : '—'],
      ]} />
    </Card>
  )
}

function Costs({ po }: { po: any }) {
  const actual = po.actual_cost != null
  const over = actual && Number(po.cost_variance) > 0
  return (
    <Card title="Cost">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-[12px] text-muted">Planned</p>
          <p className="text-[22px] font-semibold">{money(po.planned_cost)}</p>
        </div>
        <div>
          <p className="text-[12px] text-muted">Actual</p>
          <p className="text-[22px] font-semibold">{actual ? money(po.actual_cost) : '—'}</p>
          {actual && <p className={cx('text-[12.5px]', over ? 'text-bad' : 'text-good')}>{over ? 'Over plan by ' : 'Under plan by '}{money(String(po.cost_variance).replace('-', ''))}</p>}
        </div>
      </div>
      {actual && (
        <div className="mt-4 border-t border-line pt-4">
          <Facts cols={4} items={[
            ['Materials', money(po.material_cost)],
            ['Labour', money(po.labour_cost)],
            ['Overhead', money(po.overhead_cost)],
            ['Per unit', money(po.unit_cost, { paisa: true })],
          ]} />
        </div>
      )}
    </Card>
  )
}

const completeFields: FieldDef[] = [
  { name: 'output_quantity', label: 'Good units made', type: 'number', required: true },
  { name: 'rejected_quantity', label: 'Rejected', type: 'number' },
  { name: 'wastage_quantity', label: 'Wasted', type: 'number' },
  { name: 'labour_minutes', label: 'Labour minutes', type: 'number' },
  { name: 'batch_number', label: 'Batch number', hint: 'Generated if empty' },
  { name: 'mfg_date', label: 'Made on', type: 'date' },
  { name: 'expiry_date', label: 'Best before', type: 'date', hint: 'From shelf life if empty' },
]

function Complete({ open, onClose, po }: { open: boolean; onClose: () => void; po: any }) {
  const [used, setUsed] = useState<Record<number, string>>({})
  const done = useAction((body: any) => api.post(`/production-orders/${po.id}/complete`, body), { success: 'Output recorded' })
  return (
    <FormDrawer open={open} onClose={onClose} title={`Record output · ${po.number}`} submitLabel="Complete production" fields={completeFields}
      initial={{ output_quantity: po.planned_quantity, mfg_date: today() }}
      submit={(body) => done.mutateAsync({
        ...body,
        materials: Object.entries(used).filter(([, v]) => v !== '').map(([product_id, quantity]) => ({ product_id: Number(product_id), quantity })),
      })}>
      <div>
        <p className="mb-1 text-[13px] font-medium">Materials actually used</p>
        <p className="mb-3 text-[12px] text-muted">Leave blank where usage matched what was issued.</p>
        <div className="flex flex-col gap-2">
          {po.materials.map((m: any) => (
            <label key={m.product_id} className="flex items-center gap-3 text-[13px]">
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              <span className="tabular text-[12px] text-muted">issued {qty(m.issued)}</span>
              <Input type="number" step="any" className="w-28" placeholder={qty(m.issued)} aria-label={`${m.name} used`}
                value={used[m.product_id] ?? ''} onChange={(e) => setUsed((s) => ({ ...s, [m.product_id]: e.target.value }))} />
            </label>
          ))}
        </div>
      </div>
    </FormDrawer>
  )
}
