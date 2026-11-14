import { ShieldCheck } from 'lucide-react'
import { ago } from '../../lib/format'
import type { FieldDef } from '../../ui/Form'
import { Badge, Status } from '../../ui/kit'
import { ResourcePage } from '../../ui/Resource'

export const userFields: FieldDef[] = [
  { name: 'name', label: 'Full name', required: true },
  { name: 'email', label: 'Email', type: 'email', required: true },
  { name: 'password', label: 'Temporary password', type: 'password', required: true, createOnly: true, hint: 'At least 8 characters. Ask them to change it after signing in.' },
  { name: 'is_owner', label: 'Owner (full access to everything, can approve above limits)', type: 'bool', full: true },
]

export default function Users() {
  return (
    <ResourcePage
      path="/users" feature="access_management" noun="user" fields={userFields} archive={false}
      rowTo={(r: any) => `/users/${r.id}`} search="Search name or email"
      filters={[{ key: 'active', label: 'Status', options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Deactivated' }] }]}
      columns={[
        { key: 'name', label: 'Name', sort: 'name', render: (r: any) => <span className="font-medium">{r.name}</span> },
        { key: 'email', label: 'Email', sort: 'email' },
        { key: 'role', label: 'Role', render: (r: any) => (r.is_owner ? <Badge tone="brand">Owner</Badge> : <span className="text-ink-2">Staff</span>) },
        { key: 'totp_enabled', label: '2FA', render: (r: any) => (r.totp_enabled ? <span className="inline-flex items-center gap-1 text-good"><ShieldCheck className="size-4" />On</span> : <span className="text-muted">Off</span>) },
        { key: 'is_active', label: 'Status', render: (r: any) => <Status value={r.is_active ? 'active' : 'deactivated'} tone={r.is_active ? 'good' : 'neutral'} /> },
        { key: 'last_login_at', label: 'Last sign-in', sort: 'last_login_at', render: (r: any) => (r.last_login_at ? ago(r.last_login_at) : <span className="text-muted">Never</span>) },
      ]}
    />
  )
}
