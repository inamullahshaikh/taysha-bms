import { useQuery } from '@tanstack/react-query'
import { ClipboardCheck, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { date, dateTime, label } from '../../lib/format'
import { useAction, useRefMap, useUrlState } from '../../lib/hooks'
import { DataTable } from '../../ui/DataTable'
import { cleanLines, LineItems, PRODUCTS, RecordSelect, type FormValues, type RecordSource } from '../../ui/Form'
import { Badge, Button, Card, Drawer, Empty, ErrorNote, Facts, Field, Input, Loading, Segmented, Select, Status, Textarea, cx } from '../../ui/kit'
import { History, RecordHeader, RecordLayout } from '../../ui/Record'
import { FormDrawer } from '../../ui/Resource'
import { SimpleTable, TableCard } from '../reports/shared'

const STAGES = ['incoming', 'production', 'finished']
export const BATCHES: RecordSource = { path: '/stock/batches', label: (b) => `${b.number}${b.expiry_date ? ` · best before ${date(b.expiry_date)}` : ''}` }

/** Batch search. There is no GET /stock/batches/{id}, so the picked batch's label is kept here, not refetched. */
export function BatchPicker({ value, label: picked, onChange, params, placeholder = 'Search batch number' }: {
  value: string; label?: string; onChange: (id: string, label: string) => void; params?: Record<string, any>; placeholder?: string
}) {
  if (value) return (
    <div className="flex h-9 items-center justify-between gap-2 rounded-lg border border-line-strong bg-surface px-3 text-[13.5px]">
      <span className="truncate">{picked || `Batch #${value}`}</span>
      <button type="button" className="text-[12.5px] text-wine-700 hover:underline" onClick={() => onChange('', '')}>Change</button>
    </div>
  )
  return <RecordSelect source={{ ...BATCHES, params }} value="" placeholder={placeholder} onChange={(id, row) => onChange(id, row ? BATCHES.label!(row) : '')} />
}

export default function Quality() {
  const [view, setView] = useUrlState('view', 'checks')
  return (
    <>
      <div className="mb-4"><Segmented options={[{ value: 'checks', label: 'Checks' }, { value: 'templates', label: 'Checklists' }]} value={view} onChange={setView} /></div>
      {view === 'checks' ? <Checks /> : <Templates />}
    </>
  )
}

function Checks() {
  const can = useCan()
  const product = useRefMap('/products')
  const [recording, setRecording] = useState(false)
  return (
    <div className="flex flex-col gap-4">
      <OnHold />
      <DataTable
        path="/qc/checks"
        search={false}
        rowTo={(r: any) => `/qc/checks/${r.id}`}
        filters={[{ key: 'stage', label: 'Stage', options: STAGES }, { key: 'result', label: 'Result', options: ['pass', 'fail'] }]}
        empty={{ title: 'No checks recorded yet', icon: <ClipboardCheck /> }}
        toolbar={can('quality', 'create') && <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setRecording(true)}>Record check</Button>}
        columns={[
          { key: 'created_at', label: 'When', render: (r: any) => dateTime(r.created_at) },
          { key: 'stage', label: 'Stage', render: (r: any) => label(r.stage) },
          { key: 'product', label: 'Product', render: (r: any) => product(r.product_id) },
          { key: 'batch', label: 'Batch', render: (r: any) => (r.batch_id ? `#${r.batch_id}` : '—') },
          { key: 'result', label: 'Result', render: (r: any) => <Status value={r.result} /> },
          { key: 'defects', label: 'Defects', render: (r: any) => <span className="line-clamp-1 text-ink-2">{r.defects ?? ''}</span> },
        ]}
      />
      <RecordCheck open={recording} onClose={() => setRecording(false)} />
    </div>
  )
}

/** Batches waiting for a QC decision (production output goes on hold until a passing check). */
function OnHold() {
  const can = useCan()
  const product = useRefMap('/products')
  const { data } = useQuery({ queryKey: ['/stock/batches', { status: 'hold' }], queryFn: () => api.get('/stock/batches', { status: 'hold', page_size: 50 }) })
  const decide = useAction(({ id, status }: { id: number; status: string }) => api.patch(`/stock/batches/${id}`, { status }), { success: 'Batch updated' })
  const items = data?.items ?? []
  if (!items.length) return null
  return (
    <TableCard title={`On hold · ${items.length}`}>
      <SimpleTable rows={items} cols={[
        { key: 'number', label: 'Batch', render: (b: any) => <Link to={`/stock/batches/${b.id}`} className="font-medium hover:text-wine-800">{b.number}</Link> },
        { key: 'product', label: 'Product', render: (b: any) => product(b.product_id) },
        { key: 'mfg_date', label: 'Made', render: (b: any) => date(b.mfg_date) },
        { key: 'expiry_date', label: 'Best before', render: (b: any) => date(b.expiry_date) },
        { key: 'act', label: '', align: 'right', render: (b: any) => can('inventory', 'edit') && (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" className="text-bad" onClick={() => decide.mutate({ id: b.id, status: 'rejected' })}>Reject</Button>
            <Button size="sm" onClick={() => decide.mutate({ id: b.id, status: 'available' })}>Release</Button>
          </div>
        ) },
      ]} />
    </TableCard>
  )
}

type Def = { name: string; type?: 'pass_fail' | 'number' | 'text'; min?: number | null; max?: number | null; unit?: string | null }
type Result = { name: string; value: string; passed: boolean | null }

export function RecordCheck({ open, onClose, preset }: { open: boolean; onClose: () => void; preset?: { stage?: string; product_id?: number; batch_id?: number; production_order_id?: number } }) {
  const navigate = useNavigate()
  const [stage, setStage] = useState(preset?.stage ?? 'finished')
  const [templateId, setTemplateId] = useState('')
  const [productId, setProductId] = useState(preset?.product_id ? String(preset.product_id) : '')
  const [batchId, setBatchId] = useState(preset?.batch_id ? String(preset.batch_id) : '')
  const [batchLabel, setBatchLabel] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [defects, setDefects] = useState('')
  const [action, setAction] = useState('')
  const [err, setErr] = useState<unknown>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const { data: templates } = useQuery({ queryKey: ['/qc/templates', stage], queryFn: () => api.get('/qc/templates', { stage, page_size: 100 }), enabled: open })
  const tpl = templates?.items?.find((t: any) => String(t.id) === templateId)
  const defs: Def[] = tpl?.checks ?? []
  useEffect(() => { setResults(defs.length ? defs.map((d) => ({ name: d.name, value: '', passed: d.type === 'number' ? null : null })) : [{ name: '', value: '', passed: null }]) }, [templateId, open]) // eslint-disable-line react-hooks/exhaustive-deps
  const anyFail = results.some((r, i) => r.passed === false || (defs[i]?.type === 'number' && r.value !== '' && !inRange(defs[i], r.value)))

  const save = async () => {
    setBusy(true); setErr(null); setFields({})
    try {
      const c = await api.post('/qc/checks', {
        stage, template_id: templateId ? Number(templateId) : null,
        product_id: productId ? Number(productId) : null, batch_id: batchId ? Number(batchId) : null,
        production_order_id: preset?.production_order_id ?? null,
        results: results.filter((r) => r.name.trim()).map((r, i) => {
          const t = defs[i]?.type
          return t === 'number' ? { name: r.name, value: r.value } : t === 'text' ? { name: r.name, value: r.value, passed: r.passed ?? true } : { name: r.name, value: r.passed, passed: r.passed }
        }),
        defects: defects || null, corrective_action: action || null,
      })
      onClose()
      navigate(`/qc/checks/${c.id}`)
    } catch (e) {
      if (e instanceof ApiError) setFields(e.fields)
      setErr(e)
    } finally { setBusy(false) }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Record a quality check" wide
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save check</Button></>}>
      <div className="flex flex-col gap-5">
        {err != null && <ErrorNote error={err} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Stage"><Select value={stage} onChange={(e) => { setStage(e.target.value); setTemplateId('') }} options={STAGES} /></Field>
          <Field label="Checklist" hint={!templates?.items?.length ? 'No checklists for this stage yet' : undefined}>
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} placeholder="Free-form check"
              options={(templates?.items ?? []).map((t: any) => ({ value: t.id, label: t.name }))} />
          </Field>
          <Field label="Product"><RecordSelect source={PRODUCTS} value={productId} onChange={(v) => setProductId(v)} /></Field>
          <Field label="Batch" hint="A pass releases a held batch; a fail rejects it">
            <BatchPicker value={batchId} label={batchLabel} params={productId ? { product_id: productId } : undefined} onChange={(v, l) => { setBatchId(v); setBatchLabel(l) }} />
          </Field>
        </div>

        <div>
          <p className="mb-2 text-[13px] font-medium">Results</p>
          <ul className="flex flex-col gap-2">
            {results.map((r, i) => {
              const d = defs[i]
              const set = (p: Partial<Result>) => setResults((rs) => rs.map((x, j) => (j === i ? { ...x, ...p } : x)))
              return (
                <li key={i} className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-3 py-2.5">
                  {d ? <span className="min-w-40 flex-1 text-[13.5px]">{d.name}{d.type === 'number' && <span className="ml-1.5 text-[12px] text-muted">{rangeText(d)}</span>}</span>
                    : <Input className="min-w-40 flex-1" placeholder="What was checked" aria-label="Check name" value={r.name} onChange={(e) => set({ name: e.target.value })} />}
                  {d?.type === 'number' ? (
                    <Input type="number" step="any" className={cx('w-32', r.value !== '' && !inRange(d, r.value) && 'border-bad')} aria-label={`${d.name} value`} value={r.value} onChange={(e) => set({ value: e.target.value })} />
                  ) : (
                    <>
                      {d?.type === 'text' && <Input className="w-48" aria-label={`${d.name} note`} value={r.value} onChange={(e) => set({ value: e.target.value })} />}
                      <PassFail value={r.passed} onChange={(passed) => set({ passed })} />
                    </>
                  )}
                </li>
              )
            })}
          </ul>
          {!defs.length && <Button variant="ghost" size="sm" className="mt-2" icon={<Plus className="size-4" />} onClick={() => setResults((rs) => [...rs, { name: '', value: '', passed: null }])}>Add a result</Button>}
        </div>

        <Field label={anyFail ? 'Defects found *' : 'Defects'} error={fields.defects}><Textarea value={defects} onChange={(e) => setDefects(e.target.value)} /></Field>
        <Field label="Corrective action"><Textarea value={action} onChange={(e) => setAction(e.target.value)} /></Field>
      </div>
    </Drawer>
  )
}

const inRange = (d: Def, v: string) => (d.min == null || Number(v) >= Number(d.min)) && (d.max == null || Number(v) <= Number(d.max))
const rangeText = (d: Def) => [d.min != null && d.max != null ? `${d.min}–${d.max}` : d.min != null ? `≥ ${d.min}` : d.max != null ? `≤ ${d.max}` : '', d.unit].filter(Boolean).join(' ')

function PassFail({ value, onChange }: { value: boolean | null; onChange: (v: boolean) => void }) {
  return (
    <div className="inline-flex rounded-lg bg-sunken p-0.5" role="radiogroup">
      {([true, false] as const).map((v) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={cx('h-9 min-w-16 rounded-md px-3 text-[13px] font-medium transition',
            value === v ? (v ? 'bg-good text-white' : 'bg-bad text-white') : 'text-ink-2 hover:text-ink')}>
          {v ? 'Pass' : 'Fail'}
        </button>
      ))}
    </div>
  )
}

function Templates() {
  const can = useCan()
  const [editing, setEditing] = useState<any | null>(null)
  return (
    <>
      <DataTable
        path="/qc/templates"
        onRowClick={can('quality', 'edit') ? setEditing : undefined}
        filters={[{ key: 'stage', label: 'Stage', options: STAGES }]}
        empty={{ title: 'No checklists yet', body: 'A checklist lists what to check at a stage, with limits for measured values.' }}
        toolbar={can('quality', 'create') && <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing({})}>New checklist</Button>}
        columns={[
          { key: 'name', label: 'Checklist', className: 'font-medium' },
          { key: 'stage', label: 'Stage', render: (r: any) => label(r.stage) },
          { key: 'checks', label: 'Checks', render: (r: any) => <span className="text-ink-2">{r.checks.map((c: any) => c.name).join(', ')}</span> },
        ]}
      />
      {editing && <TemplateDrawer tpl={editing} onClose={() => setEditing(null)} />}
    </>
  )
}

function TemplateDrawer({ tpl, onClose }: { tpl: any; onClose: () => void }) {
  const [checks, setChecks] = useState<FormValues[]>((tpl.checks ?? []).map((c: any) => ({ name: c.name, type: c.type ?? 'pass_fail', min: c.min ?? '', max: c.max ?? '', unit: c.unit ?? '' })))
  const save = useAction((body: any) => (tpl.id ? api.patch(`/qc/templates/${tpl.id}`, body) : api.post('/qc/templates', body)), { success: 'Checklist saved' })
  return (
    <FormDrawer open onClose={onClose} wide title={tpl.id ? 'Edit checklist' : 'New checklist'} mode={tpl.id ? 'edit' : 'create'} initial={tpl}
      fields={[
        { name: 'name', label: 'Name', required: true },
        { name: 'stage', label: 'Stage', type: 'select', options: STAGES, required: true, createOnly: true },
      ]}
      submit={(body) => save.mutateAsync({ ...body, checks: cleanLines(checks) })}>
      <div>
        <p className="mb-2 text-[13px] font-medium">Checks</p>
        <LineItems value={checks} onChange={setChecks} addLabel="Add check" newRow={() => ({ name: '', type: 'pass_fail', min: '', max: '', unit: '' })}
          columns={[
            { name: 'name', label: 'Check', type: 'text', placeholder: 'Seal integrity' },
            { name: 'type', label: 'Kind', type: 'select', options: [{ value: 'pass_fail', label: 'Pass / fail' }, { value: 'number', label: 'Measured' }, { value: 'text', label: 'Note' }], width: '140px' },
            { name: 'min', label: 'Min', type: 'number', width: '90px' },
            { name: 'max', label: 'Max', type: 'number', width: '90px' },
            { name: 'unit', label: 'Unit', type: 'text', width: '80px' },
          ]} />
      </div>
    </FormDrawer>
  )
}

export function QCCheck() {
  const id = Number(useParams().id)
  const product = useRefMap('/products')
  const { data: c, isLoading, error } = useQuery({ queryKey: [`/qc/checks/${id}`], queryFn: () => api.get(`/qc/checks/${id}`) })
  if (error) return <ErrorNote error={error} />
  if (isLoading || !c) return <Loading />
  return (
    <>
      <RecordHeader back="/qc/checks" backLabel="Quality" title={`Check #${c.id}`} status={<Status value={c.result} />}
        meta={`${label(c.stage)} check · ${dateTime(c.created_at)}`} />
      <RecordLayout
        main={<>
          <Card title="Results" pad={false}>
            {c.results.length ? (
              <SimpleTable rows={c.results} cols={[
                { key: 'name', label: 'Check' },
                { key: 'value', label: 'Value', render: (r: any) => (r.value == null ? '—' : `${r.value}${r.unit ? ` ${r.unit}` : ''}`) },
                { key: 'passed', label: '', align: 'right', render: (r: any) => <Badge tone={r.passed ? 'good' : 'bad'}>{r.passed ? 'Pass' : 'Fail'}</Badge> },
              ]} />
            ) : <Empty title="No results" />}
          </Card>
          {(c.defects || c.corrective_action) && (
            <Card title="Defects and action">
              <Facts cols={1} items={[['Defects', c.defects ?? '—'], ['Corrective action', c.corrective_action ?? '—']]} />
            </Card>
          )}
        </>}
        side={<>
          <Card title="Linked to">
            <Facts cols={1} items={[
              ['Product', c.product_id ? <Link className="hover:text-wine-800" to={`/products/${c.product_id}`}>{product(c.product_id)}</Link> : '—'],
              ['Batch', c.batch_id ? <Link className="hover:text-wine-800" to={`/stock/batches/${c.batch_id}`}>Batch #{c.batch_id}</Link> : '—'],
              ['Production order', c.production_order_id ? <Link className="hover:text-wine-800" to={`/production-orders/${c.production_order_id}`}>Order #{c.production_order_id}</Link> : '—'],
              ['Goods receipt', c.goods_receipt_id ? <Link className="hover:text-wine-800" to={`/goods-receipts/${c.goods_receipt_id}`}>Receipt #{c.goods_receipt_id}</Link> : '—'],
            ]} />
          </Card>
          <History entity="qc_checks" id={id} />
        </>}
      />
    </>
  )
}
