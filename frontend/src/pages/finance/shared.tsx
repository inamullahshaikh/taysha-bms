import { Download } from 'lucide-react'
import { url } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { useUrlState } from '../../lib/hooks'
import { Button, Menu, MenuItem, Segmented } from '../../ui/kit'

export type Range = 'today' | 'week' | 'month' | 'year' | 'custom'
const RANGES: { value: Range; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'custom', label: 'Custom' },
]

/** Period kept in the URL: { range, date_from, date_to } ready to send to report endpoints. */
export function usePeriod(fallback: Range = 'month') {
  const [range, setRange] = useUrlState('range', fallback)
  const [from, setFrom] = useUrlState('from')
  const [to, setTo] = useUrlState('to')
  const params = { range, date_from: range === 'custom' ? from : undefined, date_to: range === 'custom' ? to : undefined }
  const control = (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented options={RANGES} value={range as Range} onChange={setRange} />
      {range === 'custom' && (
        <>
          <input type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)}
            className="h-8 rounded-lg border border-line bg-surface px-2 text-[13px] focus:border-wine-600 focus:outline-none" />
          <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)}
            className="h-8 rounded-lg border border-line bg-surface px-2 text-[13px] focus:border-wine-600 focus:outline-none" />
        </>
      )}
    </div>
  )
  return { params, control }
}

/** Excel/CSV download menu for report endpoints that take ?format=. Shown only with export access. */
export function ExportMenu({ feature, path, params, formats = ['xlsx', 'csv'] }: {
  feature: string; path: string; params?: Record<string, any>; formats?: string[]
}) {
  if (!useCan()(feature, 'export')) return null
  const names: Record<string, string> = { xlsx: 'Excel (.xlsx)', csv: 'CSV', pdf: 'PDF' }
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

/** Signed amount for statements: negatives in brackets, never coloured alone. */
export function Amount({ v, strong }: { v: string | number | null | undefined; strong?: boolean }) {
  if (v === null || v === undefined || v === '') return <span className="text-muted">—</span>
  const n = Number(v)
  const s = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 }).format(Math.abs(n))
  return <span className={`tabular ${strong ? 'font-semibold' : ''} ${n < 0 ? 'text-bad' : ''}`}>{n < 0 ? `(${s})` : s}</span>
}
