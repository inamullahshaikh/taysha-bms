import { useInfiniteQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, ScrollText } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { dateTime, label } from '../../lib/format'
import { useLookups, useRefMap, useUrlState } from '../../lib/hooks'
import { Button, cx, Empty, Input, Loading, Select } from '../../ui/kit'

type Entry = { id: number; at: string; user_id: number | null; action: string; entity_type: string | null; entity_id: number | null; before: any; after: any; source: string; note: string | null }
const PAGE = 100

/** Tables whose records have a page at the same path. */
const ROUTE: Record<string, string> = {
  orders: '/orders', customers: '/customers', products: '/products', suppliers: '/suppliers', expenses: '/expenses',
  sales_documents: '/documents', purchase_orders: '/purchase-orders', purchase_requests: '/purchase-requests',
  supplier_bills: '/supplier-bills', production_orders: '/production-orders', recipes: '/recipes', tasks: '/tasks',
  projects: '/projects', users: '/users', document_records: '/document-records', returns: '/returns',
  campaigns: '/campaigns', assets: '/assets', partners: '/partners', journal_entries: '/accounting/journal',
}
const ACTIONS = ['create', 'update', 'archive', 'restore', 'approve', 'reject', 'login', 'login_failed', 'export', 'status_change']

const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))

export default function Audit() {
  const userName = useRefMap('/users')
  const users = useRefMapList()
  const [entity, setEntity] = useUrlState('entity_type')
  const [userId, setUserId] = useUrlState('user_id')
  const [action, setAction] = useUrlState('action')
  const [open, setOpen] = useState<number | null>(null)
  const filters = { entity_type: entity, user_id: userId, action }
  const q = useInfiniteQuery({
    queryKey: ['/audit', 'log', filters],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api.get<Entry[]>('/audit', { ...filters, limit: PAGE, before_id: pageParam }),
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1].id : undefined),
  })
  const rows = q.data?.pages.flat() ?? []

  return (
    <div className="rounded-card bg-surface shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
        <div className="w-52"><Input aria-label="Record type" placeholder="Record type, e.g. orders" className="h-8 text-[13px]" defaultValue={entity}
          onKeyDown={(e) => e.key === 'Enter' && setEntity((e.target as HTMLInputElement).value.trim())} onBlur={(e) => setEntity(e.target.value.trim())} /></div>
        <div className="w-44"><Select aria-label="Person" className="h-8 text-[13px]" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="Anyone" options={users} /></div>
        <div className="w-44"><Select aria-label="Action" className="h-8 text-[13px]" value={action} onChange={(e) => setAction(e.target.value)} placeholder="Any action" options={ACTIONS} /></div>
      </div>
      {q.isLoading ? <Loading /> : !rows.length ? <Empty title="No entries" icon={<ScrollText />} /> : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead><tr className="border-b border-line text-left text-[12px] text-muted">
              <th className="w-8" /><th className="py-2 pr-3 font-medium">When</th><th className="py-2 pr-3 font-medium">Who</th><th className="py-2 pr-3 font-medium">Did</th><th className="py-2 pr-3 font-medium">Record</th><th className="py-2 pr-4 font-medium">Note</th>
            </tr></thead>
            <tbody>
              {rows.map((e) => {
                const diff = changes(e)
                const isOpen = open === e.id
                return (
                  <Fragment key={e.id}>
                    <tr className={cx('border-b border-line', diff.length > 0 && 'cursor-pointer hover:bg-wine-50/50')} onClick={() => diff.length && setOpen(isOpen ? null : e.id)}>
                      <td className="pl-3 text-muted">{diff.length > 0 && (isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />)}</td>
                      <td className="tabular py-2.5 pr-3 whitespace-nowrap text-ink-2">{dateTime(e.at)}</td>
                      <td className="py-2.5 pr-3 whitespace-nowrap">{e.user_id ? userName(e.user_id) : <span className="text-muted">{label(e.source)}</span>}</td>
                      <td className="py-2.5 pr-3">{label(e.action)}{!['web', 'manual'].includes(e.source) && e.user_id ? <span className="text-muted"> · {e.source}</span> : null}</td>
                      <td className="py-2.5 pr-3 whitespace-nowrap">
                        {e.entity_type ? (ROUTE[e.entity_type] && e.entity_id
                          ? <Link onClick={(ev) => ev.stopPropagation()} to={`${ROUTE[e.entity_type]}/${e.entity_id}`} className="text-wine-700 hover:underline">{label(e.entity_type)} #{e.entity_id}</Link>
                          : <span className="text-ink-2">{label(e.entity_type)}{e.entity_id ? ` #${e.entity_id}` : ''}</span>) : '—'}
                      </td>
                      <td className="max-w-xs truncate py-2.5 pr-4 text-ink-2">{e.note ?? (diff.length ? `${diff.length} field${diff.length > 1 ? 's' : ''} changed` : '')}</td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-line bg-page">
                        <td />
                        <td colSpan={5} className="py-3 pr-4">
                          <table className="w-full text-[12.5px]">
                            <thead><tr className="text-left text-muted"><th className="w-48 pb-1 font-medium">Field</th><th className="pb-1 font-medium">Before</th><th className="pb-1 font-medium">After</th></tr></thead>
                            <tbody>
                              {diff.map((k) => (
                                <tr key={k} className="align-top">
                                  <td className="py-1 pr-3 font-medium">{label(k)}</td>
                                  <td className="py-1 pr-3 break-all text-bad/80 line-through decoration-bad/30">{show(e.before?.[k])}</td>
                                  <td className="py-1 break-all text-good">{show(e.after?.[k])}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && (
        <div className="border-t border-line p-2 text-center">
          <Button variant="ghost" size="sm" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Load older entries</Button>
        </div>
      )}
    </div>
  )
}

function changes(e: Entry): string[] {
  const keys = new Set([...Object.keys(e.before ?? {}), ...Object.keys(e.after ?? {})])
  return [...keys].filter((k) => !['updated_at', 'password_hash'].includes(k) && JSON.stringify(e.before?.[k]) !== JSON.stringify(e.after?.[k]))
}

/** People for the filter (names come with the shared lookups, no extra request). */
function useRefMapList() {
  return (useLookups().data?.users ?? []).map((u) => ({ value: u.id, label: u.name ?? `#${u.id}` }))
}
