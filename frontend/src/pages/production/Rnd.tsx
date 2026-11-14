import { useQuery } from '@tanstack/react-query'
import { FlaskConical, Plus, Star } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { date, label, money, qty } from '../../lib/format'
import { useAction, useRefMap } from '../../lib/hooks'
import { PRODUCTS, type FieldDef } from '../../ui/Form'
import { Badge, Button, Card, Confirm, cx, Empty, ErrorNote, Facts, Input, Loading, Status } from '../../ui/kit'
import { Attachments, History, RecordHeader, RecordLayout } from '../../ui/Record'
import { FormDrawer, ResourcePage } from '../../ui/Resource'
import { SimpleTable, TableCard } from '../reports/shared'

const STATUSES = ['idea', 'testing', 'approved', 'rejected', 'launched']
const ideaFields: FieldDef[] = [
  { name: 'title', label: 'Idea', required: true, full: true, placeholder: 'Salted caramel mug cake' },
  { name: 'description', label: 'What and why', type: 'textarea' },
  { name: 'status', label: 'Stage', type: 'select', options: STATUSES },
  { name: 'product_id', label: 'Product', type: 'record', record: PRODUCTS, hint: 'Once it has one' },
  { name: 'target_cost', label: 'Target cost per unit', type: 'money' },
  { name: 'target_price', label: 'Target price', type: 'money' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
]

export default function Ideas() {
  return (
    <ResourcePage
      path="/rnd/ideas" feature="rnd" noun="idea" fields={ideaFields} defaults={{ status: 'idea' }}
      rowTo={(r: any) => `/rnd/ideas/${r.id}`}
      empty="No product ideas yet"
      filters={[{ key: 'status', label: 'Stage', options: STATUSES }]}
      columns={[
        { key: 'title', label: 'Idea', className: 'font-medium' },
        { key: 'status', label: 'Stage', render: (r: any) => <Status value={r.status} /> },
        { key: 'target_cost', label: 'Target cost', align: 'right', render: (r: any) => money(r.target_cost, { paisa: true }) },
        { key: 'target_price', label: 'Target price', align: 'right', render: (r: any) => money(r.target_price) },
        { key: 'created_at', label: 'Added', render: (r: any) => date(r.created_at) },
      ]}
    />
  )
}

const KINDS = ['recipe', 'packaging', 'shelf_life', 'storage']

export function Idea() {
  const id = Number(useParams().id)
  const can = useCan()
  const product = useRefMap('/products')
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const { data: idea, isLoading, error } = useQuery({ queryKey: [`/rnd/ideas/${id}`], queryFn: () => api.get(`/rnd/ideas/${id}`) })
  const { data: trials } = useQuery({ queryKey: ['/rnd/trials', id], queryFn: () => api.get('/rnd/trials', { idea_id: id, page_size: 100 }) })
  const { data: compare = [] } = useQuery({ queryKey: [`/rnd/ideas/${id}/compare`], queryFn: () => api.get<any[]>(`/rnd/ideas/${id}/compare`) })
  const save = useAction((body: any) => api.patch(`/rnd/ideas/${id}`, body), { success: 'Saved' })
  const addTrial = useAction((body: any) => api.post('/rnd/trials', { ...body, idea_id: id }), { success: 'Trial added' })
  if (error) return <ErrorNote error={error} />
  if (isLoading || !idea) return <Loading />
  const edit = can('rnd', 'edit')
  const recipeSource = { path: '/recipes', label: (r: any) => `${product(r.product_id)} · v${r.version} (${r.status})`, params: idea.product_id ? { product_id: idea.product_id } : undefined }

  return (
    <>
      <RecordHeader back="/rnd/ideas" backLabel="R&D" title={idea.title} status={<Status value={idea.status} />}
        meta={idea.product_id ? <>For <Link className="hover:text-wine-800" to={`/products/${idea.product_id}`}>{product(idea.product_id)}</Link></> : 'No product yet'}
        actions={<>
          {edit && <Button onClick={() => setEditing(true)}>Edit</Button>}
          {can('rnd', 'create') && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Add trial</Button>}
        </>} />
      <RecordLayout
        main={<>
          {compare.length > 1 && (
            <TableCard title="Trials side by side">
              <SimpleTable rows={compare} cols={[
                { key: 'trial', label: 'Trial', render: (t: any) => `#${t.trial_id} · ${label(t.kind)}` },
                { key: 'trial_date', label: 'Date', render: (t: any) => date(t.trial_date) },
                { key: 'recipe_version', label: 'Recipe', render: (t: any) => (t.recipe_version ? `v${t.recipe_version}` : '—') },
                ...(compare.some((t) => t.cost_per_unit != null) ? [{ key: 'cost_per_unit', label: 'Cost / unit', align: 'right' as const, render: (t: any) => money(t.cost_per_unit, { paisa: true }) }] : []),
                { key: 'rating', label: 'Team rating', align: 'right', render: (t: any) => (t.rating ? `${t.rating}/5` : '—') },
                { key: 'avg_feedback', label: 'Tasters', align: 'right', render: (t: any) => (t.avg_feedback ? `${t.avg_feedback}/5 · ${t.feedback_count}` : '—') },
              ]} />
            </TableCard>
          )}
          {!trials?.items?.length ? (
            <Card title="Trials"><Empty title="No trials yet" icon={<FlaskConical />}>Add a recipe, packaging, shelf-life or storage trial to start testing.</Empty></Card>
          ) : trials.items.map((t: any) => <Trial key={t.id} t={t} canEdit={edit} />)}
        </>}
        side={<>
          <Card title="Idea">
            <Facts cols={1} items={[
              ['Target cost per unit', money(idea.target_cost, { paisa: true })],
              ['Target price', money(idea.target_price)],
              ['Description', <span className="whitespace-pre-line">{idea.description ?? '—'}</span>],
              ['Notes', <span className="whitespace-pre-line">{idea.notes ?? '—'}</span>],
            ]} />
          </Card>
          <Attachments entity="rd_ideas" id={id} canEdit={edit} />
          <History entity="rd_ideas" id={id} />
        </>}
      />
      <FormDrawer open={editing} onClose={() => setEditing(false)} title="Edit idea" mode="edit" fields={ideaFields} initial={idea} submit={(b) => save.mutateAsync(b)} />
      <FormDrawer open={adding} onClose={() => setAdding(false)} title="New trial" initial={{ kind: 'recipe', status: 'planned' }}
        fields={[
          { name: 'kind', label: 'Testing', type: 'select', options: KINDS, required: true },
          { name: 'status', label: 'Status', type: 'select', options: ['planned', 'running', 'done'] },
          { name: 'recipe_id', label: 'Recipe version', type: 'record', record: recipeSource, full: true, hint: 'Create a draft recipe first to test a formulation' },
          { name: 'trial_date', label: 'Date', type: 'date' },
          { name: 'quantity_made', label: 'Quantity made', type: 'number' },
          { name: 'packaging_spec', label: 'Packaging', show: (v) => v.kind === 'packaging', full: true },
          { name: 'storage_conditions', label: 'Storage conditions', show: (v) => v.kind === 'shelf_life' || v.kind === 'storage', full: true },
        ]}
        submit={(b) => addTrial.mutateAsync(b)} />
    </>
  )
}

function Trial({ t, canEdit }: { t: any; canEdit: boolean }) {
  const can = useCan()
  const [who, setWho] = useState('')
  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')
  const [day, setDay] = useState('')
  const [note, setNote] = useState('')
  const [approving, setApproving] = useState(false)
  const [editing, setEditing] = useState(false)
  const feedback = useAction((b: any) => api.post(`/rnd/trials/${t.id}/feedback`, b), { onSuccess: () => { setWho(''); setRating(0); setComment('') } })
  const observe = useAction((b: any) => api.post(`/rnd/trials/${t.id}/observations`, b), { onSuccess: () => { setDay(''); setNote('') } })
  const approve = useAction(() => api.post(`/rnd/trials/${t.id}/approve-recipe`), { success: 'Recipe approved for production' })
  const update = useAction((b: any) => api.patch(`/rnd/trials/${t.id}`, b), { success: 'Trial saved' })
  const timed = t.kind === 'shelf_life' || t.kind === 'storage'

  return (
    <Card title={<span className="flex items-center gap-2">Trial #{t.id} · {label(t.kind)} <Status value={t.status} /></span>}
      action={<div className="flex gap-2">
        {canEdit && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Update</Button>}
        {t.recipe_id && can('recipes', 'approve') && <Button size="sm" variant="primary" onClick={() => setApproving(true)}>Use this recipe</Button>}
      </div>}>
      <div className="flex flex-col gap-4">
        <Facts cols={4} items={[
          ['Date', date(t.trial_date)],
          ['Made', qty(t.quantity_made)],
          ['Recipe', t.recipe_id ? <Link className="text-wine-700 hover:underline" to={`/recipes/${t.recipe_id}`}>Open recipe</Link> : '—'],
          ['Team rating', t.rating ? <Stars n={t.rating} /> : '—'],
        ]} />
        {(t.packaging_spec || t.storage_conditions) && (
          <p className="text-[13px] text-ink-2">{t.packaging_spec && <>Packaging: {t.packaging_spec}. </>}{t.storage_conditions && <>Stored: {t.storage_conditions}.</>}</p>
        )}
        {t.results && <p className="text-[13.5px] whitespace-pre-line text-ink-2">{t.results}</p>}

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <p className="mb-2 text-[12.5px] font-medium text-ink-2">Tasting feedback</p>
            {t.feedback.length ? (
              <ul className="mb-2 flex flex-col gap-1.5">
                {t.feedback.map((f: any, i: number) => (
                  <li key={i} className="rounded-lg bg-page px-3 py-2 text-[13px]">
                    <span className="flex items-center justify-between gap-2"><span className="font-medium">{f.who}</span><Stars n={f.rating} /></span>
                    {f.comment && <span className="text-ink-2">{f.comment}</span>}
                  </li>
                ))}
              </ul>
            ) : <p className="mb-2 text-[12.5px] text-muted">None yet</p>}
            {canEdit && (
              <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); feedback.mutate({ who, rating, comment: comment || null }) }}>
                <Input className="h-8 w-32" placeholder="Who" aria-label="Taster" value={who} onChange={(e) => setWho(e.target.value)} />
                <StarInput value={rating} onChange={setRating} />
                <Input className="h-8 min-w-32 flex-1" placeholder="Comment" aria-label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} />
                <Button type="submit" size="sm" disabled={!who.trim() || !rating} loading={feedback.isPending}>Add</Button>
              </form>
            )}
          </div>
          {timed && (
            <div>
              <p className="mb-2 text-[12.5px] font-medium text-ink-2">Observations by day</p>
              {t.observations.length ? (
                <ol className="mb-2 border-l border-line pl-4">
                  {t.observations.map((o: any, i: number) => (
                    <li key={i} className="relative pb-2 text-[13px]">
                      <span className="absolute top-1.5 -left-[20.5px] size-2 rounded-full bg-wine-200 ring-2 ring-surface" />
                      <Badge className="mr-2">Day {o.day}</Badge>{o.note}
                    </li>
                  ))}
                </ol>
              ) : <p className="mb-2 text-[12.5px] text-muted">None yet</p>}
              {canEdit && (
                <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); observe.mutate({ day: Number(day), note }) }}>
                  <Input type="number" min={0} className="h-8 w-20" placeholder="Day" aria-label="Day" value={day} onChange={(e) => setDay(e.target.value)} />
                  <Input className="h-8 min-w-32 flex-1" placeholder="Texture, smell, colour…" aria-label="Observation" value={note} onChange={(e) => setNote(e.target.value)} />
                  <Button type="submit" size="sm" disabled={day === '' || !note.trim()} loading={observe.isPending}>Add</Button>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
      <Confirm open={approving} onClose={() => setApproving(false)} title="Use this recipe in production?" confirmLabel="Approve recipe" loading={approve.isPending}
        body="The tested recipe becomes the active version for production, and the idea is marked approved."
        onConfirm={() => approve.mutate(undefined, { onSettled: () => setApproving(false) })} />
      <FormDrawer open={editing} onClose={() => setEditing(false)} title={`Update trial #${t.id}`} mode="edit" initial={t}
        fields={[
          { name: 'status', label: 'Status', type: 'select', options: ['planned', 'running', 'done'] },
          { name: 'trial_date', label: 'Date', type: 'date' },
          { name: 'quantity_made', label: 'Quantity made', type: 'number' },
          { name: 'rating', label: 'Team rating (1–5)', type: 'select', options: ['1', '2', '3', '4', '5'] },
          { name: 'results', label: 'Results', type: 'textarea' },
        ]}
        submit={(b) => update.mutateAsync({ ...b, rating: b.rating ? Number(b.rating) : null })} />
    </Card>
  )
}

const Stars = ({ n }: { n: number }) => (
  <span className="inline-flex items-center gap-0.5" aria-label={`${n} of 5`}>
    {[1, 2, 3, 4, 5].map((i) => <Star key={i} className={cx('size-3.5', i <= n ? 'fill-[#e0a526] text-[#e0a526]' : 'text-line-strong')} />)}
  </span>
)

function StarInput({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <span className="inline-flex" role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((i) => (
        <button key={i} type="button" role="radio" aria-checked={value === i} aria-label={`${i} star${i > 1 ? 's' : ''}`} onClick={() => onChange(i)}
          className="p-0.5"><Star className={cx('size-4', i <= value ? 'fill-[#e0a526] text-[#e0a526]' : 'text-line-strong hover:text-[#e0a526]')} /></button>
      ))}
    </span>
  )
}
