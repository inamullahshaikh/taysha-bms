import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Upload } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, url } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { ago, date, dateTime, label } from '../../lib/format'
import { useAction, useLookupName } from '../../lib/hooks'
import { DataTable } from '../../ui/DataTable'
import { FormFields, fromForm, toForm, type FieldDef, type FormValues } from '../../ui/Form'
import { Badge, Button, Card, cx, ErrorNote, Loading, Select, Status } from '../../ui/kit'
import { FormDrawer, ResourcePage } from '../../ui/Resource'
import { useToast } from '../../ui/toast'
import { ApiError } from '../../lib/api'

const TABS: { value: string; label: string; group: string }[] = [
  { value: 'company', label: 'Company profile', group: 'Business' },
  { value: 'approvals', label: 'Limits & rules', group: 'Business' },
  { value: 'branches', label: 'Branches', group: 'Business' },
  { value: 'departments', label: 'Departments', group: 'Business' },
  { value: 'channels', label: 'Sales channels', group: 'Selling' },
  { value: 'price-lists', label: 'Price lists', group: 'Selling' },
  { value: 'tax', label: 'Tax rates', group: 'Selling' },
  { value: 'units', label: 'Units', group: 'Selling' },
  { value: 'expense-categories', label: 'Expense categories', group: 'Money' },
  { value: 'cost-centres', label: 'Cost centres', group: 'Money' },
  { value: 'periods', label: 'Financial periods', group: 'Money' },
  { value: 'numbering', label: 'Document numbers', group: 'Money' },
  { value: 'system', label: 'Backups & jobs', group: 'System' },
]

export default function Settings() {
  const [sp, setSp] = useSearchParams()
  const tab = sp.get('tab') ?? 'company'
  // switching tabs drops the previous tab's search/filter/page
  const go = (v: string) => setSp({ tab: v }, { replace: true })
  const groups = [...new Set(TABS.map((t) => t.group))]
  return (
    <div className="grid gap-5 lg:grid-cols-[200px_minmax(0,1fr)]">
      <nav aria-label="Settings" className="hidden lg:block">
        {groups.map((g) => (
          <div key={g} className="mb-4">
            <p className="mb-1 px-2.5 text-[11.5px] font-semibold tracking-wide text-muted uppercase">{g}</p>
            {TABS.filter((t) => t.group === g).map((t) => (
              <button key={t.value} type="button" onClick={() => go(t.value)} aria-current={tab === t.value ? 'page' : undefined}
                className={cx('block w-full rounded-lg px-2.5 py-1.5 text-left text-[13.5px] transition',
                  tab === t.value ? 'bg-wine-100 font-medium text-wine-800' : 'text-ink-2 hover:bg-sunken hover:text-ink')}>
                {t.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="lg:hidden">
        <Select aria-label="Settings page" value={tab} onChange={(e) => go(e.target.value)} options={TABS.map((t) => ({ value: t.value, label: t.label }))} />
      </div>
      <div key={tab} className="anim-rise min-w-0">{PAGES[tab] ?? PAGES.company}</div>
    </div>
  )
}

/* ---------- company profile & rules (one record, two forms) ---------- */

const companyFields: FieldDef[] = [
  { name: 'name', label: 'Trading name', required: true },
  { name: 'legal_name', label: 'Legal name' },
  { name: 'phone', label: 'Phone' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'website', label: 'Website' },
  { name: 'brand_color', label: 'Brand colour', hint: 'Used on printed documents, e.g. #581C28' },
  { name: 'ntn', label: 'NTN' },
  { name: 'strn', label: 'STRN' },
  { name: 'address', label: 'Address', type: 'textarea' },
  { name: 'bank_details', label: 'Bank details (printed on invoices)', type: 'textarea' },
  { name: 'invoice_terms', label: 'Invoice terms', type: 'textarea' },
]

const ruleFields: FieldDef[] = [
  { name: 'approvals_required', label: 'Use approval steps', type: 'bool', full: true,
    hint: 'Off: expenses, purchases, stock counts and journal entries go through as soon as they are saved. On: someone else approves them first, and the limits below apply.' },
  { name: 'expense_approval_limit', label: 'Expense approval limit', type: 'money', hint: 'Above this, only an owner can approve. Empty: no limit.' },
  { name: 'purchase_approval_limit', label: 'Purchase approval limit', type: 'money', hint: 'Above this, only an owner can approve a PO.' },
  { name: 'discount_approval_pct', label: 'Discounts above (%) need approval', type: 'number' },
  { name: 'refund_approval_amount', label: 'Refunds above need approval', type: 'money' },
  { name: 'default_warehouse_id', label: 'Default warehouse', type: 'lookup', lookup: 'warehouses' },
  { name: 'labour_rate_per_hour', label: 'Labour rate per hour', type: 'money', hint: 'Used in production costing' },
  { name: 'overhead_pct', label: 'Production overhead (%)', type: 'number' },
  { name: 'production_requires_qc', label: 'Finished batches stay on hold until they pass QC', type: 'bool', full: true },
  { name: 'loyalty_points_per_100', label: 'Loyalty points per Rs 100 spent', type: 'number' },
  { name: 'loyalty_point_value', label: 'Value of one point', type: 'money' },
  { name: 'referral_bonus_points', label: 'Referral bonus points', type: 'number' },
]

function CompanyForm({ fields, title, children }: { fields: FieldDef[]; title: string; children?: ReactNode }) {
  const { can } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: ['/settings/company'], queryFn: () => api.get('/settings/company') })
  const [values, setValues] = useState<FormValues | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  if (isLoading) return <Loading />
  if (error) return <ErrorNote error={error} />
  const v = values ?? toForm(fields, data)
  const editable = can('settings', 'edit')
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setErrors({})
    try {
      await api.patch('/settings/company', fromForm(fields, v, 'edit'))
      toast('Saved'); setValues(null)
      qc.invalidateQueries({ queryKey: ['/settings/company'] })
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields)
      toast(err instanceof Error ? err.message : 'Could not save', 'error')
    } finally { setBusy(false) }
  }
  return (
    <div className="flex flex-col gap-4">
      {children}
      <Card title={title}>
        <form onSubmit={save}>
          <fieldset disabled={!editable}>
            <FormFields fields={fields} values={v} errors={errors} mode="edit" onChange={(k, x) => setValues({ ...v, [k]: x })} />
          </fieldset>
          {editable && (
            <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
              <Button disabled={!values} onClick={() => setValues(null)}>Discard</Button>
              <Button type="submit" variant="primary" disabled={!values} loading={busy}>Save changes</Button>
            </div>
          )}
        </form>
      </Card>
    </div>
  )
}

function Logo() {
  const { can } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [v, setV] = useState(0)
  const { data } = useQuery({ queryKey: ['/settings/company'], queryFn: () => api.get('/settings/company') })
  const upload = async (f?: File) => {
    if (!f) return
    const fd = new FormData()
    fd.append('file', f)
    try {
      await api.put('/settings/company/logo', fd)
      toast('Logo updated'); setV((x) => x + 1)
      qc.invalidateQueries({ queryKey: ['/settings/company'] })
    } catch (e) { toast(e instanceof Error ? e.message : 'Upload failed', 'error') }
  }
  return (
    <Card title="Logo on documents">
      <div className="flex items-center gap-4">
        <div className="flex h-16 w-40 items-center justify-center rounded-lg border border-line bg-page p-2">
          {data?.has_logo ? <img src={`${url('/settings/company/logo')}?v=${v}`} alt="Company logo" className="max-h-full max-w-full object-contain" />
            : <span className="text-[12px] text-muted">No logo yet</span>}
        </div>
        {can('settings', 'edit') && (
          <>
            <Button icon={<Upload className="size-4" />} onClick={() => input.current?.click()}>{data?.has_logo ? 'Replace logo' : 'Upload logo'}</Button>
            <input ref={input} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = '' }} />
          </>
        )}
      </div>
      <p className="mt-2 text-[12px] text-muted">Printed on invoices, POs and labels. PNG or SVG on a transparent background works best.</p>
    </Card>
  )
}

/* ---------- simple lists ---------- */

const codeName = (): FieldDef[] => [
  { name: 'code', label: 'Code', required: true, createOnly: true, hint: 'Short and permanent, used by integrations' },
  { name: 'name', label: 'Name', required: true },
]

function TaxRates() {
  const { can } = useAuth()
  const makeDefault = useAction((id: number) => api.post(`/settings/tax-rates/${id}/make-default`), { success: 'Default tax rate changed', invalidate: [['/settings/tax-rates'], ['lookups']] })
  return (
    <ResourcePage path="/settings/tax-rates" feature="settings" noun="tax rate" exportable={false}
      fields={[{ name: 'name', label: 'Name', required: true }, { name: 'rate', label: 'Rate (%)', type: 'number', required: true }]}
      columns={[
        { key: 'name', label: 'Name', render: (r: any) => <span className="font-medium">{r.name}</span> },
        { key: 'rate', label: 'Rate', align: 'right', render: (r: any) => `${Number(r.rate)}%` },
        { key: 'is_default', label: '', render: (r: any) => (r.is_default ? <Badge tone="brand">Default</Badge> : null) },
      ]}
      rowActions={(r: any, close) => !r.is_default && can('settings', 'edit') && (
        <Button variant="ghost" onClick={() => { makeDefault.mutate(r.id); close() }}>Make default</Button>
      )}
    />
  )
}

function Periods() {
  return (
    <ResourcePage path="/settings/periods" feature="settings" noun="financial period" exportable={false}
      fields={[
        { name: 'name', label: 'Name', required: true, full: true, placeholder: 'FY 2026-27' },
        { name: 'start_date', label: 'Starts', type: 'date', required: true },
        { name: 'end_date', label: 'Ends', type: 'date', required: true },
        { name: 'is_closed', label: 'Closed (no postings or edits dated inside it)', type: 'bool', full: true, editOnly: true },
      ]}
      columns={[
        { key: 'name', label: 'Period', render: (r: any) => <span className="font-medium">{r.name}</span> },
        { key: 'start_date', label: 'Starts', render: (r: any) => date(r.start_date) },
        { key: 'end_date', label: 'Ends', render: (r: any) => date(r.end_date) },
        { key: 'is_closed', label: 'Status', render: (r: any) => <Status value={r.is_closed ? 'closed' : 'open'} tone={r.is_closed ? 'neutral' : 'good'} /> },
      ]}
    />
  )
}

function ExpenseCategories() {
  const parentName = useLookupName('expense_categories')
  return (
    <ResourcePage path="/expense-categories" feature="settings" noun="expense category" exportable={false}
      fields={[
        { name: 'name', label: 'Name', required: true },
        { name: 'parent_id', label: 'Parent category', type: 'lookup', lookup: 'expense_categories' },
        { name: 'account_id', label: 'Ledger account', type: 'record', record: { path: '/accounting/accounts', label: (r) => `${r.code} · ${r.name}`, params: { type: 'expense' } }, full: true, hint: 'Where approved expenses in this category post' },
      ]}
      columns={[
        { key: 'name', label: 'Category', render: (r: any) => <span className="font-medium">{r.name}</span> },
        { key: 'parent_id', label: 'Parent', render: (r: any) => (r.parent_id ? parentName(r.parent_id) : '—') },
      ]}
    />
  )
}

function CostCentres() {
  const dept = useLookupName('departments')
  return (
    <ResourcePage path="/cost-centres" feature="settings" noun="cost centre" exportable={false}
      fields={[...codeName(), { name: 'department_id', label: 'Department', type: 'lookup', lookup: 'departments' }]}
      columns={[
        { key: 'code', label: 'Code', render: (r: any) => <span className="font-medium">{r.code}</span> },
        { key: 'name', label: 'Name' },
        { key: 'department_id', label: 'Department', render: (r: any) => (r.department_id ? dept(r.department_id) : '—') },
      ]}
    />
  )
}

/* ---------- numbering ---------- */

function Numbering() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<any>(null)
  return (
    <>
      <DataTable path="/settings/numbering" search={false} persist={false}
        onRowClick={can('settings', 'edit') ? setEditing : undefined}
        columns={[
          { key: 'label', label: 'Document', render: (r: any) => <span className="font-medium">{r.label}</span> },
          { key: 'prefix', label: 'Prefix' },
          { key: 'yearly_reset', label: 'Restarts yearly', render: (r: any) => (r.yearly_reset ? 'Yes' : 'No') },
          { key: 'next_value', label: 'Next number', align: 'right' },
          { key: 'preview', label: 'Next looks like', render: (r: any) => <span className="font-mono text-[12.5px]">{r.preview}</span> },
        ]} />
      {editing && (
        <FormDrawer open onClose={() => setEditing(null)} title={`${editing.label} numbers`} mode="edit" initial={editing}
          fields={[
            { name: 'prefix', label: 'Prefix', required: true },
            { name: 'padding', label: 'Digits', type: 'number', required: true },
            { name: 'next_value', label: 'Next number', type: 'number', required: true, hint: "Can't go below a number already used" },
            { name: 'yearly_reset', label: 'Restart at 1 each year (adds the year)', type: 'bool', full: true },
          ]}
          submit={async (body) => { await api.patch(`/settings/numbering/${editing.doc_type}`, body); qc.invalidateQueries({ queryKey: ['/settings/numbering'] }) }} />
      )}
    </>
  )
}

/* ---------- system (read-only) ---------- */

function System() {
  const jobs = useQuery({ queryKey: ['/settings/jobs'], queryFn: () => api.get<any[]>('/settings/jobs') })
  const backups = useQuery({ queryKey: ['/settings/backups'], queryFn: () => api.get<any[]>('/settings/backups') })
  return (
    <div className="flex flex-col gap-4">
      <Card title="Background jobs" pad={false}>
        {jobs.isLoading ? <Loading /> : (
          <table className="w-full text-[13px]">
            <thead><tr className="border-b border-line text-left text-[12px] text-muted">
              <th className="px-4 py-2 font-medium">Job</th><th className="py-2 font-medium">Runs every</th><th className="py-2 font-medium">Last run</th><th className="px-4 py-2 font-medium">Result</th>
            </tr></thead>
            <tbody>
              {(jobs.data ?? []).map((j) => (
                <tr key={j.name} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5 font-medium">{label(j.name)}</td>
                  <td className="py-2.5 text-ink-2">{j.interval_minutes >= 1440 ? `${j.interval_minutes / 1440} day` : j.interval_minutes >= 60 ? `${j.interval_minutes / 60} h` : `${j.interval_minutes} min`}</td>
                  <td className="py-2.5 text-ink-2" title={dateTime(j.last_started_at)}>{j.last_started_at ? ago(j.last_started_at) : 'Never'}</td>
                  <td className="px-4 py-2.5"><span className="flex items-center gap-2"><Status value={j.last_status ?? 'pending'} tone={j.last_status === 'ok' ? 'good' : j.last_status ? 'bad' : 'neutral'} /><span className="truncate text-[12px] text-muted">{j.last_message}</span></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Backups" pad={false}>
        <p className="px-4 pt-3 text-[12.5px] text-ink-2">A database dump and a copy of uploaded files are made daily and kept 14 days. A weekly job restores the newest dump to check it works. Copy them off the server too.</p>
        {backups.isLoading ? <Loading /> : (
          <ul className="mt-2 divide-y divide-line">
            {(backups.data ?? []).map((b) => (
              <li key={b.file} className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                <span className="font-mono text-[12.5px]">{b.file}</span>
                <span className="text-ink-2">{b.size_kb >= 1024 ? `${(b.size_kb / 1024).toFixed(1)} MB` : `${b.size_kb} KB`} · {ago(b.created_at)}</span>
              </li>
            ))}
            {!backups.data?.length && <li className="px-4 py-3 text-[13px] text-muted">No backups yet.</li>}
          </ul>
        )}
      </Card>
    </div>
  )
}

const PAGES: Record<string, ReactNode> = {
  company: <CompanyForm fields={companyFields} title="Company profile"><Logo /></CompanyForm>,
  approvals: <CompanyForm fields={ruleFields} title="Approval limits, production and loyalty" />,
  branches: (
    <ResourcePage path="/settings/branches" feature="settings" noun="branch" exportable={false}
      fields={[{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'phone', label: 'Phone' }, { name: 'address', label: 'Address', type: 'textarea' }]}
      columns={[{ key: 'code', label: 'Code', render: (r: any) => <span className="font-medium">{r.code}</span> }, { key: 'name', label: 'Name' }, { key: 'phone', label: 'Phone' }, { key: 'address', label: 'Address', className: 'max-w-xs truncate' }]} />
  ),
  departments: (
    <ResourcePage path="/settings/departments" feature="settings" noun="department" exportable={false}
      fields={[{ name: 'name', label: 'Name', required: true, full: true }]}
      columns={[{ key: 'name', label: 'Department', render: (r: any) => <span className="font-medium">{r.name}</span> }]} />
  ),
  channels: (
    <ResourcePage path="/settings/sales-channels" feature="settings" noun="sales channel" exportable={false}
      fields={codeName()} editFields={[{ name: 'name', label: 'Name', required: true, full: true }]}
      columns={[{ key: 'code', label: 'Code', render: (r: any) => <span className="font-mono text-[12.5px]">{r.code}</span> }, { key: 'name', label: 'Name' }]} />
  ),
  'price-lists': (
    <ResourcePage path="/settings/price-lists" feature="settings" noun="price list" exportable={false}
      fields={codeName()} editFields={[{ name: 'name', label: 'Name', required: true, full: true }]}
      columns={[{ key: 'code', label: 'Code', render: (r: any) => <span className="font-mono text-[12.5px]">{r.code}</span> }, { key: 'name', label: 'Name' }]} />
  ),
  tax: <TaxRates />,
  units: (
    <ResourcePage path="/settings/units" feature="settings" noun="unit" exportable={false}
      fields={[
        { name: 'code', label: 'Code', required: true, createOnly: true, placeholder: 'kg' },
        { name: 'name', label: 'Name', required: true },
        { name: 'dimension', label: 'Measures', type: 'select', options: ['mass', 'volume', 'count'], required: true, createOnly: true },
        { name: 'factor', label: 'Size in base unit (g, ml or pcs)', type: 'number', required: true, hint: 'kg = 1000, dozen = 12' },
      ]}
      columns={[
        { key: 'code', label: 'Code', render: (r: any) => <span className="font-mono text-[12.5px]">{r.code}</span> },
        { key: 'name', label: 'Name' },
        { key: 'dimension', label: 'Measures', render: (r: any) => label(r.dimension) },
        { key: 'factor', label: 'Base units', align: 'right', render: (r: any) => Number(r.factor).toLocaleString() },
      ]} />
  ),
  'expense-categories': <ExpenseCategories />,
  'cost-centres': <CostCentres />,
  periods: <Periods />,
  numbering: <Numbering />,
  system: <System />,
}
