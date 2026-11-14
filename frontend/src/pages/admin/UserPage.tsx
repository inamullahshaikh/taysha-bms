import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Pencil, ShieldOff, UserCheck, UserX } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { ago, dateTime } from '../../lib/format'
import { Badge, Button, Card, Confirm, ErrorNote, Facts, Loading, Status } from '../../ui/kit'
import { History, RecordHeader, RecordLayout } from '../../ui/Record'
import { FormDrawer } from '../../ui/Resource'
import { useToast } from '../../ui/toast'
import { AccessMatrix } from './AccessMatrix'
import { userFields } from './Users'

export default function UserPage() {
  const id = Number(useParams().id)
  const { user: me, can, refresh } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [confirm, setConfirm] = useState<'deactivate' | 'reactivate' | 'reset-2fa' | null>(null)
  const key = [`/users/${id}`]
  const { data: u, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/users/${id}`) })
  if (isLoading) return <Loading />
  if (error || !u) return <ErrorNote error={error} />
  const edit = can('access_management', 'edit')
  const self = u.id === me.id
  const reload = () => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['/users'] }) }

  const run = async (action: string) => {
    try {
      await api.post(`/users/${id}/${action}`)
      toast(action === 'deactivate' ? 'User deactivated and signed out everywhere' : action === 'reactivate' ? 'User reactivated' : 'Two-factor reset')
      reload()
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not save', 'error') }
    setConfirm(null)
  }

  return (
    <>
      <RecordHeader back="/users" backLabel="Users & access" title={u.name}
        status={<>{u.is_owner && <Badge tone="brand">Owner</Badge>}<Status value={u.is_active ? 'active' : 'deactivated'} tone={u.is_active ? 'good' : 'neutral'} /></>}
        meta={u.email}
        actions={edit && <>
          <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>
          <Button icon={<KeyRound className="size-4" />} onClick={() => setResetting(true)}>Reset password</Button>
          {u.totp_enabled && <Button icon={<ShieldOff className="size-4" />} onClick={() => setConfirm('reset-2fa')}>Reset 2FA</Button>}
          {!self && (u.is_active
            ? <Button variant="ghost" className="text-bad hover:text-bad" icon={<UserX className="size-4" />} onClick={() => setConfirm('deactivate')}>Deactivate</Button>
            : <Button icon={<UserCheck className="size-4" />} onClick={() => setConfirm('reactivate')}>Reactivate</Button>)}
        </>} />
      <RecordLayout
        main={<AccessMatrix userId={id} isOwner={u.is_owner} />}
        side={<>
          <Card title="Account">
            <Facts cols={1} items={[
              ['Role', u.is_owner ? 'Owner' : 'Staff'],
              ['Two-factor', u.totp_enabled ? 'On' : 'Off'],
              ['Last sign-in', u.last_login_at ? <span title={dateTime(u.last_login_at)}>{ago(u.last_login_at)}</span> : 'Never'],
            ]} />
          </Card>
          <History entity="users" id={id} />
        </>}
      />
      <FormDrawer open={editing} onClose={() => setEditing(false)} title="Edit user" mode="edit" fields={userFields} initial={u}
        submit={async (body) => { await api.patch(`/users/${id}`, body); reload(); if (self) await refresh() }} />
      <FormDrawer open={resetting} onClose={() => setResetting(false)} title={`New password for ${u.name}`} submitLabel="Set password"
        fields={[{ name: 'new_password', label: 'New password', type: 'password', required: true, full: true, hint: 'They will be signed out everywhere and use this to sign in.' }]}
        submit={async (body) => { await api.post(`/users/${id}/reset-password`, body); toast('Password changed') }} />
      <Confirm open={!!confirm} onClose={() => setConfirm(null)} danger={confirm === 'deactivate'}
        confirmLabel={confirm === 'deactivate' ? 'Deactivate' : confirm === 'reactivate' ? 'Reactivate' : 'Reset 2FA'}
        title={confirm === 'deactivate' ? `Deactivate ${u.name}?` : confirm === 'reactivate' ? `Reactivate ${u.name}?` : 'Reset two-factor sign-in?'}
        body={confirm === 'deactivate' ? 'They are signed out at once and can no longer sign in. Their history stays.'
          : confirm === 'reset-2fa' ? 'They will sign in with just their password until they set up two-factor again.' : 'They can sign in again with their current password.'}
        onConfirm={() => run(confirm!)} />
    </>
  )
}
