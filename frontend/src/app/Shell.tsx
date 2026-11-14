import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, ChevronsUpDown, KeyRound, LockKeyhole, LogOut, Menu as MenuIcon, X } from 'lucide-react'
import { Suspense, useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { ago } from '../lib/format'
import { cx, Empty, IconButton, Loading, Menu, MenuItem, PageHeader, Tabs } from '../ui/kit'
import { SECTIONS } from '../modules'
import { allowed, type Access, type Section } from './section'

const toRegex = (p: string) => new RegExp(`^${p.replace(/:[^/]+/g, '[^/]+')}(/.*)?$`)

/** The section that owns a URL (longest matching path wins). */
export function sectionFor(pathname: string): Section | undefined {
  let best: [Section, number] | undefined
  for (const s of SECTIONS)
    for (const p of [...s.pages, ...(s.routes ?? [])]) {
      if (p.path === '/' ? pathname === '/' : toRegex(p.path).test(pathname))
        if (!best || p.path.length > best[1]) best = [s, p.path.length]
    }
  return best?.[0]
}

export function useVisibleSections() {
  const { can } = useAuth()
  return SECTIONS.map((s) => ({ ...s, pages: s.pages.filter((p) => allowed(can, p.access)) })).filter((s) => s.pages.length)
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const sections = useVisibleSections()
  const { pathname } = useLocation()
  const current = sectionFor(pathname)
  let lastGroup = ''
  return (
    <nav className="flex h-full flex-col bg-wine-800 text-cream" aria-label="Main">
      <Link to="/" onClick={onNavigate} className="flex h-16 shrink-0 items-center px-5">
        <img src="/logo.png" alt="Taysha" className="h-8 w-auto" />
      </Link>
      <div className="scroll-quiet flex-1 overflow-y-auto px-3 pb-4 [scrollbar-color:rgb(255_255_255/0.15)_transparent]">
        {sections.map((s) => {
          const divider = lastGroup && s.group !== lastGroup
          lastGroup = s.group
          const active = current?.key === s.key
          const Icon = s.icon
          return (
            <div key={s.key}>
              {divider && <div className="mx-2 my-2.5 h-px bg-white/10" />}
              <NavLink to={s.pages[0].path} onClick={onNavigate}
                className={cx('group relative mb-0.5 flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13.5px] transition-colors',
                  active ? 'bg-white/12 font-medium text-white' : 'text-cream/75 hover:bg-white/6 hover:text-cream')}>
                {active && <span className="absolute top-2 bottom-2 -left-3 w-[3px] rounded-r-full bg-cream" />}
                <Icon className={cx('size-[18px] shrink-0', active ? 'text-cream' : 'text-cream/60 group-hover:text-cream/85')} strokeWidth={1.75} />
                {s.label}
              </NavLink>
            </div>
          )
        })}
      </div>
      <UserChip onNavigate={onNavigate} />
    </nav>
  )
}

function UserChip({ onNavigate }: { onNavigate?: () => void }) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const initials = user.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
  return (
    <div className="border-t border-white/10 p-3">
      <Menu align="left" up trigger={
        <button type="button" className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-white/6">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-cream text-[12px] font-semibold text-wine-800">{initials}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-cream">{user.name}</span>
            <span className="block truncate text-[11.5px] text-cream/55">{user.is_owner ? 'Owner' : user.email}</span>
          </span>
          <ChevronsUpDown className="size-4 text-cream/50" />
        </button>
      }>
        <MenuItem icon={<KeyRound />} onClick={() => { navigate('/account'); onNavigate?.() }}>Account & security</MenuItem>
        <MenuItem icon={<LockKeyhole />} onClick={() => { navigate('/account?tab=notifications'); onNavigate?.() }}>Notification settings</MenuItem>
        <MenuItem icon={<LogOut />} danger onClick={async () => {
          await api.post('/auth/logout').catch(() => {})
          qc.clear()
          navigate('/login')
        }}>Sign out</MenuItem>
      </Menu>
    </div>
  )
}

function Notifications() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data } = useQuery({
    queryKey: ['/notifications', 'bell'],
    queryFn: () => api.get<{ unread: number; items: any[] }>('/notifications', { limit: 12 }),
    refetchInterval: 60_000,
  })
  const open = async (n: any) => {
    if (!n.read_at) await api.post(`/notifications/${n.id}/read`)
    qc.invalidateQueries({ queryKey: ['/notifications'] })
    if (n.link) navigate(n.link)
  }
  return (
    <Menu trigger={
      <IconButton label={`Notifications${data?.unread ? `, ${data.unread} unread` : ''}`} className="relative">
        <Bell className="size-[18px]" />
        {!!data?.unread && <span className="absolute -top-0.5 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-wine-800 px-1 text-[10px] leading-none font-semibold text-cream ring-2 ring-page">{data.unread > 99 ? '99+' : data.unread}</span>}
      </IconButton>
    }>
      <div className="w-[min(360px,calc(100vw-2rem))]">
        <div className="flex items-center justify-between px-2.5 pt-1.5 pb-2">
          <p className="text-[13px] font-semibold">Notifications</p>
          {!!data?.unread && (
            <button type="button" className="text-[12px] text-wine-700 hover:underline"
              onClick={async (e) => { e.stopPropagation(); await api.post('/notifications/read-all'); qc.invalidateQueries({ queryKey: ['/notifications'] }) }}>
              Mark all read
            </button>
          )}
        </div>
        {!data?.items.length ? <Empty title="You're all caught up" /> : (
          <ul className="scroll-quiet max-h-96 overflow-y-auto">
            {data.items.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => open(n)} className="flex w-full gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-sunken">
                  <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : 'bg-wine-600')} />
                  <span className="min-w-0">
                    <span className={cx('block text-[13px]', n.read_at ? 'text-ink-2' : 'font-medium text-ink')}>{n.title}</span>
                    {n.body && <span className="block truncate text-[12px] text-muted">{n.body}</span>}
                    <span className="block text-[11.5px] text-muted">{ago(n.created_at)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <Link to="/notifications" className="mt-1 block border-t border-line px-2.5 pt-2 pb-1 text-center text-[12.5px] text-wine-700 hover:underline">See all</Link>
      </div>
    </Menu>
  )
}

export function Shell() {
  const [open, setOpen] = useState(false)
  const { pathname } = useLocation()
  useEffect(() => setOpen(false), [pathname])
  return (
    <div className="min-h-dvh lg:pl-[236px]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:shadow-pop">Skip to content</a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[236px] lg:block"><Sidebar /></aside>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-wine-950/40" onClick={() => setOpen(false)} />
          <div className="anim-slide absolute inset-y-0 left-0 w-[272px] max-w-[85vw]"><Sidebar onNavigate={() => setOpen(false)} /></div>
          <IconButton label="Close menu" onClick={() => setOpen(false)} className="absolute top-3 right-3 bg-surface"><X className="size-4" /></IconButton>
        </div>
      )}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-page/85 px-4 backdrop-blur-md lg:px-8">
        <IconButton label="Open menu" aria-expanded={open} className="lg:hidden" onClick={() => setOpen(true)}><MenuIcon className="size-5" /></IconButton>
        <Link to="/" className="flex h-9 items-center rounded-lg bg-wine-800 px-2.5 lg:hidden"><img src="/logo.png" alt="Taysha" className="h-5" /></Link>
        <div className="ml-auto flex items-center gap-1"><Notifications /></div>
      </header>
      <main id="main" className="mx-auto max-w-[1440px] px-4 py-6 lg:px-8 lg:py-7">
        <Suspense fallback={<Loading />}><Outlet /></Suspense>
      </main>
    </div>
  )
}

/** Header + tabs for a section's pages. */
export function SectionLayout({ section }: { section: Section }) {
  const { can } = useAuth()
  const pages = section.pages.filter((p) => allowed(can, p.access))
  return (
    <>
      <PageHeader title={section.label} subtitle={section.subtitle}>
        {pages.length > 1 && <div className="mt-4"><Tabs tabs={pages.map((p) => ({ value: p.path, label: p.label, to: p.path }))} /></div>}
      </PageHeader>
      <div className="anim-rise"><Outlet /></div>
    </>
  )
}

export function Guard({ access, children }: { access: Access; children: ReactNode }) {
  const { can } = useAuth()
  return allowed(can, access) ? <>{children}</> : <NoAccess />
}

export function NoAccess() {
  return (
    <Empty title="You don't have access to this" icon={<LockKeyhole />}
      action={<Link to="/" className="text-[13px] text-wine-700 hover:underline">Back to dashboard</Link>}>
      Ask an owner or manager to grant it in Users & access.
    </Empty>
  )
}

export function NotFound() {
  return (
    <Empty title="Page not found" action={<Link to="/" className="text-[13px] text-wine-700 hover:underline">Back to dashboard</Link>}>
      The link may be old, or the record was moved.
    </Empty>
  )
}
