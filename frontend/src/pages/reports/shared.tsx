import { Download } from 'lucide-react'
import type { ReactNode } from 'react'
import { url } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { date } from '../../lib/format'
import { useUrlState } from '../../lib/hooks'
import { Button, cx, Empty, Input, Menu, MenuItem, Segmented } from '../../ui/kit'

export type Range = 'today' | 'week' | 'month' | 'year' | 'custom'
const RANGES: { value: Range; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'year', label: 'This year' },
  { value: 'custom', label: 'Custom' },
]

/** Period kept in the URL; returns the params the API's `period()` understands. */
export function useRange(fallback: Range = 'month') {
  const [range, setRange] = useUrlState('range', fallback)
  const [from, setFrom] = useUrlState('from')
  const [to, setTo] = useUrlState('to')
  const params: Record<string, string> = range === 'custom' && from && to ? { range, date_from: from, date_to: to } : { range: range === 'custom' ? fallback : range }
  const control = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="scroll-quiet max-w-full overflow-x-auto"><Segmented options={RANGES} value={range as Range} onChange={setRange} /></div>
      {range === 'custom' && (
        <div className="flex items-center gap-1.5 text-[12.5px] text-muted">
          <Input type="date" aria-label="From" className="h-8 w-auto" value={from} onChange={(e) => setFrom(e.target.value)} />
          to
          <Input type="date" aria-label="To" className="h-8 w-auto" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      )}
    </div>
  )
  return { params, control }
}

export const periodLabel = (d?: { from?: string; to?: string }) => (d?.from ? `${date(d.from)} – ${date(d.to)}` : '')

/** Excel/CSV/PDF links for a report endpoint, shown only with export access. */
export function ExportMenu({ feature, path, params, formats = ['xlsx', 'csv', 'pdf'] }: {
  feature: string; path: string; params: Record<string, any>; formats?: ('xlsx' | 'csv' | 'pdf')[]
}) {
  const can = useCan()
  if (!can(feature, 'export')) return null
  const names = { xlsx: 'Excel (.xlsx)', csv: 'CSV', pdf: 'PDF' }
  return (
    <Menu trigger={<Button size="sm" icon={<Download className="size-3.5" />}>Export</Button>}>
      {formats.map((f) => (
        <a key={f} href={url(path, { ...params, format: f })} target={f === 'pdf' ? '_blank' : undefined} rel="noopener">
          <MenuItem>{names[f]}</MenuItem>
        </a>
      ))}
    </Menu>
  )
}

export type Col<T = any> = { key: string; label: ReactNode; render?: (r: T) => ReactNode; align?: 'right' }

/** Client-side table for already-aggregated report rows. */
export function SimpleTable<T = any>({ rows, cols, empty = 'No data for this period', onRow, className }: {
  rows: T[]; cols: Col<T>[]; empty?: string; onRow?: (r: T) => void; className?: string
}) {
  if (!rows.length) return <Empty title={empty} />
  return (
    <div className={cx('scroll-quiet overflow-x-auto', className)}>
      <table className="w-full border-collapse text-[13.5px]">
        <thead>
          <tr className="border-b border-line text-left">
            {cols.map((c) => (
              <th key={c.key} scope="col" className={cx('h-9 px-3 text-[12px] font-medium whitespace-nowrap text-muted first:pl-4 last:pr-4', c.align === 'right' && 'text-right')}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} onClick={onRow ? () => onRow(r) : undefined}
              className={cx('border-b border-line last:border-0', onRow && 'cursor-pointer hover:bg-wine-50/60')}>
              {cols.map((c) => (
                <td key={c.key} className={cx('h-11 px-3 first:min-w-44 first:pl-4 last:pr-4', c.align === 'right' && 'tabular text-right whitespace-nowrap')}>
                  {c.render ? c.render(r) : ((r as any)[c.key] ?? <span className="text-muted">—</span>)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A card that holds a table (no inner padding). */
export function TableCard({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-card bg-surface shadow-card">
      <header className="flex min-h-12 items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <h2 className="text-[13.5px] font-semibold">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  )
}

export const Toolbar = ({ children }: { children: ReactNode }) => (
  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">{children}</div>
)
