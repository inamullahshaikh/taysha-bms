import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CopyPlus, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { dateTime, label, money, pct, qty } from '../../lib/format'
import { useAction } from '../../lib/hooks'
import { SegmentBar } from '../../ui/charts'
import { cleanLines, LineItems, type FormValues } from '../../ui/Form'
import { Badge, Button, Card, Confirm, cx, Empty, ErrorNote, Facts, Field, Input, Loading, Select, Status, Textarea } from '../../ui/kit'
import { History, RecordHeader, RecordLayout } from '../../ui/Record'
import { SimpleTable } from '../reports/shared'

export default function Recipe() {
  const id = Number(useParams().id)
  const can = useCan()
  const navigate = useNavigate()
  const { data: r, isLoading, error } = useQuery({ queryKey: [`/recipes/${id}`], queryFn: () => api.get(`/recipes/${id}`) })
  const { data: product } = useQuery({ queryKey: [`/products/${r?.product_id}`], queryFn: () => api.get(`/products/${r.product_id}`), enabled: !!r })
  const { data: versions } = useQuery({
    queryKey: ['/recipes', { product_id: r?.product_id }],
    queryFn: () => api.get('/recipes', { product_id: r.product_id, page_size: 100 }),
    enabled: !!r,
  })
  const [activating, setActivating] = useState(false)
  const activate = useAction(() => api.post(`/recipes/${id}/activate`), { success: 'Version is now active' })
  const newVersion = useAction(() => api.post(`/recipes/${id}/new-version`), { onSuccess: (n: any) => navigate(`/recipes/${n.id}`) })

  if (error) return <ErrorNote error={error} />
  if (isLoading || !r) return <Loading />
  const draft = r.status === 'draft'
  const editable = draft && can('recipes', 'edit')

  return (
    <>
      <RecordHeader back="/recipes" backLabel="Recipes" title={`${product?.name ?? 'Recipe'} · v${r.version}`} status={<Status value={r.status} />}
        meta={r.approved_at ? `Approved ${dateTime(r.approved_at)}` : draft ? 'Draft: not used by production until approved' : undefined}
        actions={<>
          {can('recipes', 'edit') && <Button icon={<CopyPlus className="size-4" />} loading={newVersion.isPending} onClick={() => newVersion.mutate(undefined)}>New version from this</Button>}
          {draft && can('recipes', 'approve') && <Button variant="primary" icon={<ShieldCheck className="size-4" />} onClick={() => setActivating(true)}>Approve for production</Button>}
        </>} />
      <RecordLayout
        main={<>
          {editable ? <Editor recipe={r} /> : <ReadOnly recipe={r} />}
          {can('product_costs') && <Cost id={id} batch={r.yield_quantity} />}
          {(versions?.items?.length ?? 0) > 1 && <Compare recipe={r} versions={versions.items} />}
        </>}
        side={<>
          <Card title="Versions" pad={false}>
            <ul className="divide-y divide-line">
              {(versions?.items ?? []).map((v: any) => (
                <li key={v.id}>
                  <Link to={`/recipes/${v.id}`} className={cx('flex items-center justify-between px-4 py-2.5 text-[13px] hover:bg-wine-50/60', v.id === id && 'bg-wine-50')}>
                    <span className="font-medium">v{v.version}</span>
                    <Status value={v.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
          <History entity="recipes" id={id} />
        </>}
      />
      <Confirm open={activating} onClose={() => setActivating(false)} title={`Approve v${r.version}?`} confirmLabel="Approve" loading={activate.isPending}
        body="New production orders will use this version. The current active version is kept as history."
        onConfirm={() => activate.mutate(undefined, { onSettled: () => setActivating(false) })} />
    </>
  )
}

function ReadOnly({ recipe: r }: { recipe: any }) {
  return (
    <Card title="Ingredients and packaging" pad={false}>
      <div className="border-b border-line p-4">
        <Facts cols={3} items={[
          ['Batch yield', qty(r.yield_quantity)],
          ['Expected wastage', pct(r.expected_wastage_pct)],
          ['Labour per batch', r.labour_minutes ? `${r.labour_minutes} min` : '—'],
        ]} />
      </div>
      <SimpleTable rows={r.lines} empty="No ingredients" cols={[
        { key: 'name', label: 'Item', render: (l: any) => <Link to={`/products/${l.product_id}`} className="hover:text-wine-800">{l.name}</Link> },
        { key: 'type', label: 'Type', render: (l: any) => <Badge tone={l.type === 'packaging' ? 'info' : 'neutral'}>{label(l.type)}</Badge> },
        { key: 'quantity', label: 'Per batch', align: 'right', render: (l: any) => qty(l.quantity, l.unit) },
        { key: 'wastage_pct', label: 'Wastage', align: 'right', render: (l: any) => pct(l.wastage_pct) },
        { key: 'note', label: 'Note', render: (l: any) => <span className="text-ink-2">{l.note ?? ''}</span> },
      ]} />
      {(r.instructions || r.notes) && (
        <div className="space-y-3 border-t border-line p-4 text-[13.5px] whitespace-pre-line">
          {r.instructions && <div><p className="mb-1 text-[12px] text-muted">Method</p>{r.instructions}</div>}
          {r.notes && <div><p className="mb-1 text-[12px] text-muted">Notes</p>{r.notes}</div>}
        </div>
      )}
    </Card>
  )
}

function Editor({ recipe: r }: { recipe: any }) {
  const qc = useQueryClient()
  const [v, setV] = useState<FormValues>({})
  const [lines, setLines] = useState<FormValues[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [err, setErr] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setV({ yield_quantity: r.yield_quantity, expected_wastage_pct: r.expected_wastage_pct, labour_minutes: r.labour_minutes ?? '', instructions: r.instructions ?? '', notes: r.notes ?? '' })
    setLines(r.lines.map((l: any) => ({ product_id: String(l.product_id), quantity: l.quantity, wastage_pct: l.wastage_pct, note: l.note ?? '' })))
  }, [r])
  const set = (k: string) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }))
  const save = async () => {
    setBusy(true); setErrors({}); setErr(null)
    try {
      await api.put(`/recipes/${r.id}`, {
        product_id: r.product_id, yield_quantity: v.yield_quantity, expected_wastage_pct: v.expected_wastage_pct || 0,
        labour_minutes: v.labour_minutes === '' ? null : Number(v.labour_minutes), instructions: v.instructions || null, notes: v.notes || null,
        lines: cleanLines(lines),
      })
      qc.invalidateQueries({ queryKey: [`/recipes/${r.id}`] })
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fields)
      setErr(e)
    } finally { setBusy(false) }
  }
  return (
    <Card title="Ingredients and packaging" action={<Button variant="primary" size="sm" loading={busy} onClick={save}>Save draft</Button>}>
      <div className="flex flex-col gap-4">
        {err != null && <ErrorNote error={err} />}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Units per batch" error={errors.yield_quantity}><Input type="number" step="any" value={v.yield_quantity ?? ''} onChange={set('yield_quantity')} /></Field>
          <Field label="Expected wastage %" error={errors.expected_wastage_pct}><Input type="number" step="any" value={v.expected_wastage_pct ?? ''} onChange={set('expected_wastage_pct')} /></Field>
          <Field label="Labour minutes per batch" error={errors.labour_minutes}><Input type="number" value={v.labour_minutes ?? ''} onChange={set('labour_minutes')} /></Field>
        </div>
        <LineItems value={lines} onChange={setLines} errors={errors} addLabel="Add ingredient or packaging"
          columns={[
            { name: 'product_id', label: 'Item', type: 'product' },
            { name: 'quantity', label: 'Per batch', type: 'number', width: '120px' },
            { name: 'wastage_pct', label: 'Wastage %', type: 'number', width: '110px' },
            { name: 'note', label: 'Note', type: 'text' },
          ]} />
        <Field label="Method"><Textarea value={v.instructions ?? ''} onChange={set('instructions')} /></Field>
        <Field label="Notes"><Textarea value={v.notes ?? ''} onChange={set('notes')} /></Field>
      </div>
    </Card>
  )
}

function Cost({ id, batch }: { id: number; batch: string }) {
  const [q, setQ] = useState('')
  const quantity = q || batch
  const { data, error } = useQuery({ queryKey: [`/recipes/${id}/cost`, quantity], queryFn: () => api.get(`/recipes/${id}/cost`, { quantity }), enabled: Number(quantity) > 0 })
  return (
    <Card title="Standard cost" action={
      <label className="flex items-center gap-2 text-[12.5px] text-muted">
        For
        <Input type="number" step="any" className="h-8 w-28" placeholder={qty(batch)} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Quantity" />
        units
      </label>
    }>
      {error ? <ErrorNote error={error} /> : !data ? <Loading /> : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-x-10 gap-y-2">
            <div><p className="text-[12px] text-muted">Total</p><p className="text-[22px] font-semibold">{money(data.total)}</p></div>
            <div><p className="text-[12px] text-muted">Per unit</p><p className="text-[22px] font-semibold">{money(data.per_unit, { paisa: true })}</p></div>
          </div>
          <SegmentBar fmt={(v) => money(v)} parts={[
            { label: 'Materials', value: data.materials },
            { label: 'Labour', value: data.labour },
            { label: 'Overhead', value: data.overhead },
          ]} />
          <p className="text-[12px] text-muted">At today's weighted-average material costs, the company labour rate and overhead.</p>
        </div>
      )}
    </Card>
  )
}

function Compare({ recipe, versions }: { recipe: any; versions: any[] }) {
  const others = versions.filter((v) => v.id !== recipe.id)
  const [other, setOther] = useState(String(others[0]?.id ?? ''))
  const { data } = useQuery({ queryKey: [`/recipes/${recipe.id}/compare/${other}`], queryFn: () => api.get(`/recipes/${other}/compare/${recipe.id}`), enabled: !!other })
  const tone = { added: 'good', removed: 'bad', changed: 'warn', same: 'neutral' } as const
  return (
    <Card title="Compare versions" pad={false} action={
      <Select aria-label="Compare with" className="h-8 w-auto max-w-56 text-[13px]" value={other} onChange={(e) => setOther(e.target.value)}
        options={others.map((v) => ({ value: v.id, label: `v${v.version} → v${recipe.version}` }))} />
    }>
      {!data ? <Empty title="Choose a version" /> : (
        <SimpleTable rows={data.lines} cols={[
          { key: 'name', label: 'Item' },
          { key: 'a', label: `v${data.a.version} per unit`, align: 'right', render: (l: any) => (l.a_per_unit == null ? '—' : qty(Number(l.a_per_unit).toFixed(4))) },
          { key: 'b', label: `v${data.b.version} per unit`, align: 'right', render: (l: any) => (l.b_per_unit == null ? '—' : qty(Number(l.b_per_unit).toFixed(4))) },
          { key: 'change', label: '', align: 'right', render: (l: any) => <Badge tone={tone[l.change as keyof typeof tone]}>{label(l.change)}</Badge> },
        ]} />
      )}
    </Card>
  )
}
