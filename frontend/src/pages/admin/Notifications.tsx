import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Settings2 } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { ago, dateTime } from '../../lib/format'
import { useUrlState } from '../../lib/hooks'
import { Button, cx, Empty, Loading, PageHeader, Segmented } from '../../ui/kit'

type N = { id: number; kind: string; title: string; body: string | null; link: string | null; created_at: string; read_at: string | null }
const PAGE = 30

export default function Notifications() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [show, setShow] = useUrlState('show', 'all')
  const q = useInfiniteQuery({
    queryKey: ['/notifications', 'page', show],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api.get<{ unread: number; items: N[] }>('/notifications', { limit: PAGE, before_id: pageParam, unread_only: show === 'unread' }),
    getNextPageParam: (last) => (last.items.length === PAGE ? last.items[last.items.length - 1].id : undefined),
  })
  const items = q.data?.pages.flatMap((p) => p.items) ?? []
  const unread = q.data?.pages[0]?.unread ?? 0
  const refresh = () => qc.invalidateQueries({ queryKey: ['/notifications'] })

  const open = async (n: N) => {
    if (!n.read_at) await api.post(`/notifications/${n.id}/read`)
    refresh()
    if (n.link) navigate(n.link)
  }

  return (
    <>
      <PageHeader title="Notifications" subtitle={unread ? `${unread} unread` : 'All caught up'}
        actions={<>
          <Link to="/account?tab=notifications"><Button icon={<Settings2 className="size-4" />}>Choose alerts</Button></Link>
          {unread > 0 && <Button variant="primary" onClick={async () => { await api.post('/notifications/read-all'); refresh() }}>Mark all read</Button>}
        </>} />
      <div className="mb-3"><Segmented value={show} onChange={setShow} options={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }]} /></div>
      <div className="max-w-3xl rounded-card bg-surface shadow-card">
        {q.isLoading ? <Loading /> : !items.length ? <Empty title={show === 'unread' ? 'No unread notifications' : 'No notifications yet'} icon={<Bell />} /> : (
          <ul className="divide-y divide-line">
            {items.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => open(n)} className="flex w-full gap-3 px-4 py-3 text-left transition hover:bg-wine-50/60">
                  <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : 'bg-wine-600')} aria-label={n.read_at ? undefined : 'Unread'} />
                  <span className="min-w-0 flex-1">
                    <span className={cx('block text-[13.5px]', n.read_at ? 'text-ink-2' : 'font-medium text-ink')}>{n.title}</span>
                    {n.body && <span className="mt-0.5 block text-[12.5px] text-ink-2">{n.body}</span>}
                  </span>
                  <span className="shrink-0 text-[12px] text-muted" title={dateTime(n.created_at)}>{ago(n.created_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {q.hasNextPage && (
          <div className="border-t border-line p-2 text-center">
            <Button variant="ghost" size="sm" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Load older</Button>
          </div>
        )}
      </div>
    </>
  )
}
