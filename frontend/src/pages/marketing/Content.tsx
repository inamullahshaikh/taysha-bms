import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, asPage } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { date, dateTime, label } from '../../lib/format'
import { useAction, useRefMap, useUrlState } from '../../lib/hooks'
import { USERS, type FieldDef } from '../../ui/Form'
import { Badge, Button, cx, Empty, Loading, Segmented, Status } from '../../ui/kit'
import { FormDrawer } from '../../ui/Resource'
import { useToast } from '../../ui/toast'

const STAGES = ['idea', 'planned', 'in_production', 'approved', 'scheduled', 'published']

const FIELDS: FieldDef[] = [
  { name: 'title', label: 'Title', required: true, full: true },
  { name: 'status', label: 'Stage', type: 'select', options: STAGES },
  { name: 'platform', label: 'Platform', placeholder: 'instagram, tiktok…' },
  { name: 'scheduled_for', label: 'Goes out', type: 'datetime' },
  { name: 'campaign_id', label: 'Campaign', type: 'record', record: { path: '/campaigns' } },
  { name: 'owner_id', label: 'Owner', type: 'record', record: USERS },
  { name: 'link', label: 'Link', full: true },
  { name: 'caption', label: 'Caption', type: 'textarea' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
]

export default function Content() {
  const [view, setView] = useUrlState('view', 'board')
  const { can } = useAuth()
  const [editing, setEditing] = useState<any>(null)
  const qc = useQueryClient()
  const toast = useToast()
  const refresh = () => qc.invalidateQueries({ queryKey: ['/content'] })
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented value={view as 'board' | 'calendar'} onChange={setView} options={[{ value: 'board', label: 'Pipeline' }, { value: 'calendar', label: 'Calendar' }]} />
        {can('marketing', 'edit') && <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing({ status: 'idea' })}>New post</Button>}
      </div>
      {view === 'calendar' ? <Calendar /> : <Board onOpen={setEditing} />}
      {editing && (
        <FormDrawer open onClose={() => setEditing(null)} title={editing.id ? 'Edit post' : 'New post'} mode={editing.id ? 'edit' : 'create'} fields={FIELDS} initial={editing}
          footerExtra={editing.id && can('marketing', 'edit') && (
            <Button variant="ghost" className="text-bad" onClick={async () => { await api.post(`/content/${editing.id}/archive`); toast('Archived'); refresh(); setEditing(null) }}>Archive</Button>
          )}
          submit={async (body) => {
            if (editing.id) await api.patch(`/content/${editing.id}`, body)
            else await api.post('/content', body)
            toast('Saved'); refresh()
          }} />
      )}
    </div>
  )
}

function Board({ onOpen }: { onOpen: (r: any) => void }) {
  const { can } = useAuth()
  const owner = useRefMap('/users')
  // everything in the pipeline, but only the latest published posts (those pile up forever)
  const { data } = useQuery({
    queryKey: ['/content', 'board'],
    queryFn: async () => {
      const [open, published] = await Promise.all([
        api.get('/content', { status: STAGES.filter((s) => s !== 'published').join(','), page_size: 500 }),
        api.get('/content', { status: 'published', sort: '-scheduled_for', page_size: 30 }),
      ])
      return [...asPage<any>(open).items, ...asPage<any>(published).items]
    },
  })
  const move = useAction((v: { id: number; status: string }) => api.patch(`/content/${v.id}`, { status: v.status }), { invalidate: [['/content']] })
  if (!data) return <Loading />
  return (
    <div className="scroll-quiet -mx-1 grid auto-cols-[minmax(176px,1fr)] grid-flow-col gap-3 overflow-x-auto px-1 pb-2">
      {STAGES.map((s) => {
        const items = data.filter((c) => c.status === s)
        return (
          <section key={s} className="flex flex-col rounded-card bg-sunken/70 p-2">
            <header className="flex items-center justify-between px-1.5 pt-1 pb-2">
              <h2 className="text-[12.5px] font-semibold text-ink-2">{label(s)}</h2>
              <span className="tabular text-[12px] text-muted">{items.length}</span>
            </header>
            <ul className="flex flex-col gap-2">
              {items.map((c) => (
                <li key={c.id} className="rounded-lg bg-surface p-3 shadow-card transition hover:-translate-y-px">
                  <button type="button" className="block w-full text-left" onClick={() => onOpen(c)}>
                    <p className="text-[13px] font-medium text-ink">{c.title}</p>
                    <p className="mt-1 text-[12px] text-muted">{[c.platform && label(c.platform), c.scheduled_for && dateTime(c.scheduled_for), c.owner_id && owner(c.owner_id)].filter(Boolean).join(' · ')}</p>
                  </button>
                  {can('marketing', 'edit') && (
                    <select aria-label={`Move ${c.title}`} value={c.status} onChange={(e) => move.mutate({ id: c.id, status: e.target.value })}
                      className="mt-2 h-7 w-full rounded-md border border-line bg-page px-1.5 text-[12px] text-ink-2 focus:border-wine-600 focus:outline-none">
                      {STAGES.map((x) => <option key={x} value={x}>{label(x)}</option>)}
                    </select>
                  )}
                </li>
              ))}
              {!items.length && <li className="px-1.5 py-4 text-center text-[12px] text-muted">Nothing here</li>}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

function Calendar() {
  const start = new Date()
  start.setDate(start.getDate() - 7)
  const end = new Date(start)
  end.setDate(end.getDate() + 56)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const { data } = useQuery({ queryKey: ['/marketing/calendar', iso(start)], queryFn: () => api.get<any[]>('/marketing/calendar', { date_from: iso(start), date_to: iso(end) }) })
  if (!data) return <Loading />
  if (!data.length) return <Empty title="Nothing scheduled" icon={<CalendarDays />} />
  const byDay = new Map<string, any[]>()
  for (const e of [...data].sort((a, b) => String(a.start).localeCompare(String(b.start)))) {
    const d = String(e.start).slice(0, 10)
    byDay.set(d, [...(byDay.get(d) ?? []), e])
  }
  const link = (e: any) => (e.type === 'campaign' ? `/campaigns/${e.id}` : e.type === 'promotion' ? '/discount-codes' : undefined)
  return (
    <ol className="flex flex-col gap-2">
      {[...byDay].map(([d, events]) => (
        <li key={d} className="grid gap-3 rounded-card bg-surface p-4 shadow-card sm:grid-cols-[120px_1fr]">
          <p className="text-[13px] font-semibold text-ink">{date(d)}</p>
          <ul className="flex flex-col gap-2">
            {events.map((e) => {
              const body = (
                <span className="flex flex-wrap items-center gap-2 text-[13px]">
                  <Badge tone={e.type === 'campaign' ? 'brand' : e.type === 'promotion' ? 'warn' : 'info'}>{label(e.type)}</Badge>
                  <span className={cx('font-medium', link(e) && 'hover:text-wine-800')}>{e.title}</span>
                  {e.end && String(e.end).slice(0, 10) !== d && <span className="text-muted">until {date(e.end)}</span>}
                  {e.platform && <span className="text-muted">{label(e.platform)}</span>}
                  {e.status && <Status value={e.status} />}
                </span>
              )
              return <li key={`${e.type}-${e.id}`}>{link(e) ? <Link to={link(e)!}>{body}</Link> : body}</li>
            })}
          </ul>
        </li>
      ))}
    </ol>
  )
}
