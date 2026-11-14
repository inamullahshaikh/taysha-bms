import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Search, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, asPage, url } from '../lib/api'
import { useCan } from '../lib/auth'
import { Button, cx, Empty, ErrorNote, Menu, MenuItem, Select, Spinner } from './kit'

export type Column<T = any> = {
  key: string
  label: ReactNode
  render?: (row: T) => ReactNode
  align?: 'right' | 'center'
  /** server sort key (enables header sorting) */
  sort?: string
  className?: string
}

export type Filter = {
  key: string
  label: string
  type?: 'select' | 'date' | 'bool'
  options?: (string | { value: string | number; label: string })[]
}

type Props<T> = {
  path: string
  columns: Column<T>[]
  filters?: Filter[]
  /** fixed query params always sent */
  params?: Record<string, any>
  search?: string | false
  rowTo?: (row: T) => string
  onRowClick?: (row: T) => void
  /** export link shown with `export` access on this feature */
  exportFeature?: string
  exportPath?: string
  toolbar?: ReactNode
  empty?: { title: string; body?: ReactNode; icon?: ReactNode; action?: ReactNode }
  /** keep table state in the URL (default) or locally (for tables embedded in record pages) */
  persist?: boolean
  pageSize?: number
  dense?: boolean
}

function useTableState(persist: boolean) {
  const [sp, setSp] = useSearchParams()
  const [local, setLocal] = useState<Record<string, string>>({})
  const get = (k: string) => (persist ? (sp.get(k) ?? '') : (local[k] ?? ''))
  const set = (k: string, v: string) => {
    if (!persist) return setLocal((s) => ({ ...s, [k]: v, ...(k === 'page' ? {} : { page: '' }) }))
    setSp((prev) => {
      const n = new URLSearchParams(prev)
      if (v) n.set(k, v)
      else n.delete(k)
      if (k !== 'page') n.delete('page')
      return n
    }, { replace: true })
  }
  return { get, set }
}

export function DataTable<T extends { id?: number }>({
  path, columns, filters = [], params = {}, search = 'Search', rowTo, onRowClick, exportFeature, exportPath,
  toolbar, empty, persist = true, pageSize = 50, dense,
}: Props<T>) {
  const st = useTableState(persist)
  const navigate = useNavigate()
  const can = useCan()
  const page = Number(st.get('page') || 1)
  const sort = st.get('sort')
  const q = st.get('q')
  const filterValues = Object.fromEntries(filters.map((f) => [f.key, st.get(f.key)]))
  const query = { ...params, ...filterValues, q, sort, page, page_size: pageSize }

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: [path, query],
    queryFn: () => api.get(path, query),
    placeholderData: keepPreviousData,
  })
  const pg = asPage<T>(data)
  const from = pg.total ? (pg.page - 1) * pg.page_size + 1 : 0
  const to = Math.min(pg.page * pg.page_size, pg.total)
  const activeFilters = filters.some((f) => filterValues[f.key]) || !!q
  const clickable = !!(rowTo || onRowClick)

  const exportUrl = (format: string) =>
    url(exportPath ?? `${path}/export`, { ...params, ...filterValues, q, sort, format })

  return (
    <div className="rounded-card bg-surface shadow-card">
      {(search !== false || filters.length > 0 || toolbar || exportFeature) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
          {search !== false && <SearchBox value={q} onChange={(v) => st.set('q', v)} placeholder={search} />}
          {filters.map((f) => (
            <FilterControl key={f.key} f={f} value={filterValues[f.key]} onChange={(v) => st.set(f.key, v)} />
          ))}
          {activeFilters && (
            <Button variant="ghost" size="sm" icon={<X className="size-3.5" />}
              onClick={() => { st.set('q', ''); filters.forEach((f) => st.set(f.key, '')) }}>Clear</Button>
          )}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {isFetching && !isLoading && <Spinner className="size-4" />}
            {toolbar}
            {exportFeature && can(exportFeature, 'export') && (
              <Menu trigger={<Button size="sm" icon={<Download className="size-3.5" />}>Export</Button>}>
                <a href={exportUrl('xlsx')}><MenuItem>Excel (.xlsx)</MenuItem></a>
                <a href={exportUrl('csv')}><MenuItem>CSV</MenuItem></a>
              </Menu>
            )}
          </div>
        </div>
      )}

      {error ? (
        <div className="p-4"><ErrorNote error={error} /></div>
      ) : isLoading ? (
        <div className="flex h-48 items-center justify-center"><Spinner /></div>
      ) : pg.items.length === 0 ? (
        activeFilters
          ? <Empty title="Nothing matches" icon={<Search />}>Try a different search or clear the filters.</Empty>
          : <Empty title={empty?.title ?? 'Nothing here yet'} icon={empty?.icon} action={empty?.action}>{empty?.body}</Empty>
      ) : (
        <div className="scroll-quiet overflow-x-auto">
          <table className="w-full border-collapse text-[13.5px]">
            <thead>
              <tr className="border-b border-line text-left">
                {columns.map((c) => (
                  <th key={c.key} scope="col"
                    className={cx('h-9 px-3 text-[12px] font-medium whitespace-nowrap text-muted first:pl-4 last:pr-4',
                      c.align === 'right' && 'text-right', c.align === 'center' && 'text-center')}>
                    {c.sort ? (
                      <button type="button" className="inline-flex items-center gap-1 hover:text-ink"
                        onClick={() => st.set('sort', sort === c.sort ? `-${c.sort}` : sort === `-${c.sort}` ? '' : c.sort!)}>
                        {c.label}
                        {sort === c.sort && <ArrowUp className="size-3" />}
                        {sort === `-${c.sort}` && <ArrowDown className="size-3" />}
                      </button>
                    ) : c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pg.items.map((row, i) => (
                <tr key={row.id ?? i}
                  onClick={clickable ? () => (onRowClick ? onRowClick(row) : navigate(rowTo!(row))) : undefined}
                  className={cx('border-b border-line last:border-0', clickable && 'cursor-pointer transition-colors hover:bg-wine-50/60')}>
                  {columns.map((c) => (
                    <td key={c.key}
                      className={cx(dense ? 'h-10' : 'h-12', 'px-3 first:pl-4 last:pr-4',
                        c.align === 'right' && 'tabular text-right whitespace-nowrap', c.align === 'center' && 'text-center', c.className)}>
                      {c.render ? c.render(row) : ((row as any)[c.key] ?? <span className="text-muted">—</span>)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pg.total > pg.page_size && (
        <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[12.5px] text-ink-2">
          <span className="tabular">{from}–{to} of {pg.total.toLocaleString()}</span>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" aria-label="Previous page" disabled={page <= 1}
              onClick={() => st.set('page', String(page - 1))}><ChevronLeft className="size-4" /></Button>
            <Button size="sm" variant="ghost" aria-label="Next page" disabled={to >= pg.total}
              onClick={() => st.set('page', String(page + 1))}><ChevronRight className="size-4" /></Button>
          </div>
        </div>
      )}
    </div>
  )
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const [text, setText] = useState(value)
  const [timer, setTimer] = useState<number>()
  return (
    <div className="relative w-full sm:w-64">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
      <input
        value={text}
        aria-label={placeholder}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value)
          clearTimeout(timer)
          setTimer(window.setTimeout(() => onChange(e.target.value.trim()), 300))
        }}
        className="h-8 w-full rounded-lg border border-line bg-page pr-3 pl-8 text-[13px] placeholder:text-muted focus:border-wine-600 focus:bg-surface focus:outline-none"
      />
    </div>
  )
}

function FilterControl({ f, value, onChange }: { f: Filter; value: string; onChange: (v: string) => void }) {
  const base = 'h-8 w-auto text-[13px]'
  if (f.type === 'date')
    return (
      <label className="flex items-center gap-1.5 text-[12.5px] text-muted">
        {f.label}
        <input type="date" value={value} onChange={(e) => onChange(e.target.value)}
          className="h-8 rounded-lg border border-line bg-page px-2 text-[13px] text-ink focus:border-wine-600 focus:outline-none" />
      </label>
    )
  if (f.type === 'bool')
    return (
      <button type="button" onClick={() => onChange(value ? '' : 'true')} aria-pressed={!!value}
        className={cx('h-8 rounded-lg border px-2.5 text-[13px] transition',
          value ? 'border-wine-600 bg-wine-50 text-wine-800' : 'border-line bg-page text-ink-2 hover:text-ink')}>
        {f.label}
      </button>
    )
  return (
    <Select aria-label={f.label} className={cx(base, value ? 'border-wine-600 bg-wine-50' : 'border-line bg-page')}
      value={value} onChange={(e) => onChange(e.target.value)} options={f.options ?? []} placeholder={f.label} />
  )
}
