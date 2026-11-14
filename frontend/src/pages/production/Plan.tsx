import { useQuery } from '@tanstack/react-query'
import { CalendarDays } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { date, label, qty } from '../../lib/format'
import { useAction } from '../../lib/hooks'
import { Badge, Button, Card, Checkbox, Empty, ErrorNote, Input, Loading, Status } from '../../ui/kit'
import { SimpleTable, TableCard } from '../reports/shared'

export default function Plan() {
  return (
    <div className="flex flex-col gap-4">
      <Suggestions />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Schedule />
        <FromForecast />
      </div>
    </div>
  )
}

function Suggestions() {
  const can = useCan()
  const { data = [], isLoading, error } = useQuery({ queryKey: ['/production/suggestions'], queryFn: () => api.get<any[]>('/production/suggestions') })
  const [picked, setPicked] = useState<Record<number, boolean>>({})
  const [start, setStart] = useState('')
  const create = useAction((rows: any[]) => api.post('/production/suggestions/create', rows), {
    success: 'Production orders created', onSuccess: () => setPicked({}),
  })
  const chosen = data.filter((r) => picked[r.product_id])
  if (error) return <ErrorNote error={error} />
  return (
    <TableCard title="Make now" action={can('production', 'create') && data.length > 0 && (
      <div className="flex items-center gap-2">
        <Input type="date" aria-label="Planned start" className="h-8 w-auto" value={start} onChange={(e) => setStart(e.target.value)} />
        <Button variant="primary" size="sm" disabled={!chosen.length} loading={create.isPending}
          onClick={() => create.mutate(chosen.map((r) => ({ product_id: r.product_id, quantity: r.suggested_quantity, planned_start: start || null })))}>
          {chosen.length > 1 ? `Create ${chosen.length} orders` : 'Create order'}
        </Button>
      </div>
    )}>
      {isLoading ? <Loading /> : data.length === 0 ? (
        <Empty title="Nothing needs making right now">No backorders, and stock is above every reorder point.</Empty>
      ) : (
        <SimpleTable rows={data} cols={[
          { key: 'pick', label: '', render: (r: any) => <Checkbox aria-label={`Pick ${r.name}`} checked={!!picked[r.product_id]} onChange={(e) => setPicked((p) => ({ ...p, [r.product_id]: e.target.checked }))} /> },
          { key: 'name', label: 'Product', render: (r: any) => <span className="font-medium">{r.name}</span> },
          { key: 'reason', label: 'Why', render: (r: any) => <Badge tone={r.reason === 'backorders' ? 'bad' : 'warn'}>{label(r.reason)}</Badge> },
          { key: 'available', label: 'Available', align: 'right', render: (r: any) => qty(r.available) },
          { key: 'backordered', label: 'Backordered', align: 'right', render: (r: any) => qty(r.backordered) },
          { key: 'in_production', label: 'In production', align: 'right', render: (r: any) => qty(r.in_production) },
          { key: 'suggested_quantity', label: 'Make', align: 'right', render: (r: any) => <span className="font-semibold">{qty(r.suggested_quantity)}</span> },
          { key: 'batches', label: 'Batches', align: 'right', render: (r: any) => qty(r.batches) },
        ]} />
      )}
    </TableCard>
  )
}

function Schedule() {
  const { data = [], isLoading, error } = useQuery({ queryKey: ['/production/schedule'], queryFn: () => api.get<any[]>('/production/schedule', { days: 14 }) })
  if (error) return <ErrorNote error={error} />
  const days = new Map<string, any[]>()
  for (const r of data) {
    const k = r.planned_start ?? ''
    days.set(k, [...(days.get(k) ?? []), r])
  }
  return (
    <Card title="Next 14 days" pad={false}>
      {isLoading ? <Loading /> : data.length === 0 ? <Empty title="Nothing scheduled" icon={<CalendarDays />} /> : (
        <ol className="divide-y divide-line">
          {[...days.entries()].map(([day, rows]) => (
            <li key={day} className="flex gap-4 px-4 py-3">
              <div className="w-24 shrink-0 pt-0.5 text-[12.5px] font-medium text-ink-2">{day ? date(day) : 'No date'}</div>
              <ul className="flex min-w-0 flex-1 flex-col gap-2">
                {rows.map((r) => (
                  <li key={r.id}>
                    <Link to={`/production-orders/${r.id}`} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 hover:border-wine-200 hover:bg-wine-50/60">
                      <span className="min-w-0">
                        <span className="block truncate text-[13.5px] font-medium">{r.product_name}</span>
                        <span className="text-[12px] text-muted">{r.number} · {qty(r.planned_quantity)} units{r.due_date ? ` · due ${date(r.due_date)}` : ''}</span>
                      </span>
                      <Status value={r.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}

function FromForecast() {
  const can = useCan()
  const { data = [], isLoading, error } = useQuery({ queryKey: ['/forecast/production'], queryFn: () => api.get<any[]>('/forecast/production', { months: 1 }) })
  const create = useAction((row: any) => api.post('/production/suggestions/create', [{ product_id: row.product_id, quantity: row.suggested_quantity }]), { success: 'Production order created' })
  if (error) return <ErrorNote error={error} />
  return (
    <TableCard title="For next month's forecast">
      {isLoading ? <Loading /> : (
        <SimpleTable rows={data} empty="No products with an active recipe" cols={[
          { key: 'name', label: 'Product' },
          { key: 'forecast', label: 'Forecast', align: 'right', render: (r: any) => qty(Math.round(Number(r.forecast))) },
          { key: 'available', label: 'Available', align: 'right', render: (r: any) => qty(r.available) },
          { key: 'suggested_quantity', label: 'Make', align: 'right', render: (r: any) => Number(r.suggested_quantity) > 0 ? <span className="font-semibold">{qty(r.suggested_quantity)}</span> : <span className="text-muted">Covered</span> },
          { key: 'go', label: '', align: 'right', render: (r: any) => can('production', 'create') && Number(r.suggested_quantity) > 0 && <Button size="sm" onClick={() => create.mutate(r)}>Plan</Button> },
        ]} />
      )}
    </TableCard>
  )
}
