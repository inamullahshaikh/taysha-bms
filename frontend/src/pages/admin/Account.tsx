import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { api, ApiError, url } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { useUrlState } from '../../lib/hooks'
import { Badge, Button, Card, ErrorNote, Facts, Field, Input, Loading, PageHeader, Tabs } from '../../ui/kit'
import { useToast } from '../../ui/toast'

export default function Account() {
  const { user } = useAuth()
  const [tab, setTab] = useUrlState('tab', 'security')
  return (
    <>
      <PageHeader title="Your account" subtitle={user.email}>
        <div className="mt-4">
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'security', label: 'Sign-in & security' }, { value: 'notifications', label: 'Notifications' }]} />
        </div>
      </PageHeader>
      <div className="anim-rise max-w-3xl">
        {tab === 'notifications' ? <NotificationPrefs /> : (
          <div className="flex flex-col gap-4">
            <Card title="Profile">
              <Facts items={[['Name', user.name], ['Email', user.email], ['Role', user.is_owner ? 'Owner' : 'Staff']]} />
              <p className="mt-3 text-[12.5px] text-muted">To change your name or email, ask someone who manages users.</p>
            </Card>
            <TwoFactor />
            <ChangePassword />
          </div>
        )}
      </div>
    </>
  )
}

function ChangePassword() {
  const toast = useToast()
  const [v, setV] = useState({ current: '', next: '', repeat: '' })
  const [err, setErr] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (v.next !== v.repeat) return setErr({ repeat: 'Passwords do not match' })
    setBusy(true); setErr({})
    try {
      await api.post('/auth/change-password', { current_password: v.current, new_password: v.next })
      toast('Password changed. Other devices were signed out.')
      setV({ current: '', next: '', repeat: '' })
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Could not change password'
      setErr(e instanceof ApiError && e.fields.current_password ? { current: msg } : { next: (e instanceof ApiError && e.fields.new_password) || msg })
    } finally { setBusy(false) }
  }
  return (
    <Card title="Password">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-3">
        <Field label="Current password" htmlFor="cur" error={err.current}>
          <Input id="cur" type="password" autoComplete="current-password" required value={v.current} onChange={(e) => setV({ ...v, current: e.target.value })} />
        </Field>
        <Field label="New password" htmlFor="new" error={err.next}>
          <Input id="new" type="password" autoComplete="new-password" required value={v.next} onChange={(e) => setV({ ...v, next: e.target.value })} />
        </Field>
        <Field label="Repeat new password" htmlFor="rep" error={err.repeat}>
          <Input id="rep" type="password" autoComplete="new-password" required value={v.repeat} onChange={(e) => setV({ ...v, repeat: e.target.value })} />
        </Field>
        <div className="sm:col-span-3"><Button type="submit" variant="primary" loading={busy}>Change password</Button></div>
      </form>
    </Card>
  )
}

function TwoFactor() {
  const { user, refresh } = useAuth()
  const toast = useToast()
  const [setup, setSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null)
  const [codes, setCodes] = useState<string[] | null>(null)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [disabling, setDisabling] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const step = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError(e) } finally { setBusy(false) }
  }

  if (codes)
    return (
      <Card title="Save your recovery codes">
        <p className="text-[13.5px] text-ink-2">Two-factor sign-in is on. If you lose your phone, each of these codes works once instead of an app code. They are shown only now.</p>
        <ul className="tabular my-4 grid grid-cols-2 gap-2 rounded-lg bg-sunken p-4 font-mono text-[13.5px] sm:grid-cols-5">
          {codes.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <div className="flex gap-2">
          <Button icon={<Copy className="size-4" />} onClick={() => { navigator.clipboard?.writeText(codes.join('\n')); toast('Codes copied') }}>Copy codes</Button>
          <Button variant="primary" onClick={() => setCodes(null)}>I have saved them</Button>
        </div>
      </Card>
    )

  if (user.totp_enabled)
    return (
      <Card title="Two-factor sign-in" action={<Badge tone="good"><ShieldCheck className="size-3.5" />On</Badge>}>
        <p className="text-[13.5px] text-ink-2">You enter a code from your authenticator app after your password.</p>
        {disabling ? (
          <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={(e) => {
            e.preventDefault()
            step(async () => { await api.post('/auth/2fa/disable', { password }); await refresh(); setDisabling(false); setPassword(''); toast('Two-factor sign-in turned off') })
          }}>
            <Field label="Your password" htmlFor="pw" className="w-64"><Input id="pw" type="password" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            <Button type="submit" variant="danger" loading={busy}>Turn off</Button>
            <Button onClick={() => setDisabling(false)}>Cancel</Button>
          </form>
        ) : <Button className="mt-4" onClick={() => setDisabling(true)}>Turn off two-factor</Button>}
        {error != null && <div className="mt-3"><ErrorNote error={error} /></div>}
      </Card>
    )

  return (
    <Card title="Two-factor sign-in" action={<Badge>Off</Badge>}>
      {!setup ? (
        <>
          <p className="text-[13.5px] text-ink-2">Add a second step at sign-in using an authenticator app such as Google Authenticator or Microsoft Authenticator.</p>
          <Button className="mt-4" variant="primary" loading={busy}
            onClick={() => step(async () => setSetup(await api.post('/auth/2fa/setup')))}>Set up two-factor</Button>
        </>
      ) : (
        <div className="flex flex-col gap-5 sm:flex-row">
          <img src={url('/barcodes/image', { value: setup.otpauth_uri, symbology: 'qr' })} alt="QR code for your authenticator app"
            className="size-44 shrink-0 rounded-lg border border-line bg-white p-2" />
          <form className="flex flex-1 flex-col gap-3" onSubmit={(e) => {
            e.preventDefault()
            step(async () => {
              const r = await api.post<{ recovery_codes: string[] }>('/auth/2fa/enable', { code: code.replace(/\s/g, '') })
              setCodes(r.recovery_codes); setSetup(null); setCode(''); await refresh()
            })
          }}>
            <p className="text-[13.5px] text-ink-2">1. Scan the code with your authenticator app. Can't scan? Enter this key: <span className="font-mono text-ink break-all">{setup.secret}</span></p>
            <p className="text-[13.5px] text-ink-2">2. Type the 6-digit code it shows.</p>
            <Field label="Code" htmlFor="totp">
              <Input id="totp" inputMode="numeric" autoComplete="one-time-code" required className="w-40 tracking-[0.25em]" value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            {error != null && <ErrorNote error={error} />}
            <div className="flex gap-2">
              <Button type="submit" variant="primary" loading={busy}>Turn on</Button>
              <Button onClick={() => { setSetup(null); setError(null) }}>Cancel</Button>
            </div>
          </form>
        </div>
      )}
    </Card>
  )
}

type Pref = { kind: string; label: string; in_app: boolean; email: boolean }

function NotificationPrefs() {
  const qc = useQueryClient()
  const toast = useToast()
  const key = ['/notifications/preferences']
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<Pref[]>('/notifications/preferences') })
  if (isLoading) return <Loading />
  const set = async (p: Pref, field: 'in_app' | 'email', value: boolean) => {
    const next = { in_app: p.in_app, email: p.email, [field]: value }
    qc.setQueryData<Pref[]>(key, (old) => old?.map((x) => (x.kind === p.kind ? { ...x, ...next } : x)))
    try { await api.put('/notifications/preferences', { [p.kind]: next }) } catch {
      toast('Could not save', 'error'); qc.invalidateQueries({ queryKey: key })
    }
  }
  return (
    <Card title="Alerts you receive" pad={false}>
      <p className="px-4 pt-3 text-[12.5px] text-muted">Only alerts for areas you have access to are listed.</p>
      <table className="mt-2 w-full text-[13.5px]">
        <thead>
          <tr className="border-b border-line text-left text-[12px] text-muted">
            <th className="px-4 py-2 font-medium">Alert</th>
            <th className="w-24 py-2 text-center font-medium">In the app</th>
            <th className="w-24 py-2 pr-4 text-center font-medium">Email</th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((p) => (
            <tr key={p.kind} className="border-b border-line last:border-0">
              <td className="px-4 py-2.5">{p.label}</td>
              <td className="text-center"><input type="checkbox" aria-label={`${p.label} in the app`} className="size-4 accent-wine-800" checked={p.in_app} onChange={(e) => set(p, 'in_app', e.target.checked)} /></td>
              <td className="pr-4 text-center"><input type="checkbox" aria-label={`${p.label} by email`} className="size-4 accent-wine-800" checked={p.email} onChange={(e) => set(p, 'email', e.target.checked)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}
