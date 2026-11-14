import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, Pencil } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, ApiError } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { compactMoney, date, money } from '../../lib/format'
import { useLookupName, useLookups, useRefMap } from '../../lib/hooks'
import { Meter, StatTile } from '../../ui/charts'
import { LineItems, type FieldDef, type FormValues } from '../../ui/Form'
import { Badge, Button, Card, Drawer, Empty, ErrorNote, Loading } from '../../ui/kit'
import { RecordHeader } from '../../ui/Record'
import { ResourcePage } from '../../ui/Resource'
import { useToast } from '../../ui/toast'
import { ACCOUNTS } from './Accounting'

const FIELDS: FieldDef[] = [
  { name: 'name', label: 'Name', required: true, full: true, placeholder: 'FY 2026-27 operating budget' },
  { name: 'period_start', label: 'Starts', type: 'date', required: true, createOnly: true },
  { name: 'period_end', label: 'Ends', type: 'date', required: true, createOnly: true },
  { name: 'notes', label: 'Notes', type: 'textarea' },
]

export default function Budgets() {
  return (
    <ResourcePage path="/budgets" feature="accounting" noun="budget" fields={FIELDS} rowTo={(r: any) => `/budgets/${r.id}`}
      archive={false}
      columns={[
        { key: 'name', label: 'Budget', render: (r: any) => <span className="font-medium">{r.name}</span> },
        { key: 'period_start', label: 'Period', render: (r: any) => `${date(r.period_start)} – ${date(r.period_end)}` },
        { key: 'notes', label: 'Notes', className: 'max-w-80 truncate text-ink-2' },
      ]} />
  )
}

export function BudgetDetail() {
  const id = Number(useParams().id)
  const { can } = useAuth()
  const [editing, setEditing] = useState(false)
  const b = useQuery({ queryKey: [`/budgets/${id}`], queryFn: () => api.get(`/budgets/${id}`) })
  const va = useQuery({ queryKey: [`/budgets/${id}/vs-actual`], queryFn: () => api.get(`/budgets/${id}/vs-actual`) })
  const category = useLookupName('expense_categories')
  const centre = useLookupName('cost_centres')
  const account = useRefMap('/accounting/accounts', (r) => `${r.code} ${r.name}`)
  if (b.error) return <ErrorNote error={b.error} />
  if (!b.data || !va.data) return <Loading />
  const lineName = (l: any) => [l.category_id && category(l.category_id), l.cost_centre_id && centre(l.cost_centre_id), l.account_id && account(l.account_id)].filter(Boolean).join(' · ') || 'Whole budget'
  const lines: any[] = va.data.lines
  const over = lines.filter((l) => Number(l.used_pct) >= 100).length
  return (
    <>
      <RecordHeader back="/budgets" backLabel="Budgets" title={b.data.name} meta={`${date(b.data.period_start)} – ${date(b.data.period_end)}`}
        actions={can('accounting', 'create') && <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit lines</Button>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatTile label="Budget" value={compactMoney(va.data.total_budget)} />
        <StatTile label="Spent so far" value={compactMoney(va.data.total_actual)} />
        <StatTile label="Lines over budget" value={over} sub={`of ${lines.length}`} />
      </div>
      <Card title="Budget against actual spend">
        {!lines.length ? (
          <Empty title="No budget lines yet" action={can('accounting', 'create') && <Button variant="primary" onClick={() => setEditing(true)}>Add lines</Button>}>
            Set an amount per expense category, cost centre or account.
          </Empty>
        ) : (
          <ul className="flex flex-col gap-4">
            {lines.map((l) => {
              const pct = Number(l.used_pct ?? 0)
              return (
                <li key={l.id}>
                  <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
                    <span className="flex items-center gap-2 font-medium">{lineName(l)}{l.hard_limit && <Badge tone="brand"><Lock className="size-3" />Hard limit</Badge>}</span>
                    <span className="tabular text-ink-2"><span className="font-medium text-ink">{money(l.actual)}</span> of {money(l.budget)} · {pct.toFixed(0)}%</span>
                  </div>
                  <Meter value={Number(l.actual)} max={Number(l.budget)} tone={pct >= 100 ? 'bad' : pct >= 85 ? 'warn' : 'good'} />
                  {pct >= 100 && <p className="mt-1 text-[12px] text-bad">Over by {money(String(l.remaining).replace('-', ''))}{l.hard_limit ? '. New expenses here are blocked.' : ''}</p>}
                </li>
              )
            })}
          </ul>
        )}
      </Card>
      {editing && <LinesEditor id={id} initial={lines} onClose={() => setEditing(false)} />}
    </>
  )
}

function LinesEditor({ id, initial, onClose }: { id: number; initial: any[]; onClose: () => void }) {
  const { data: lk } = useLookups()
  const qc = useQueryClient()
  const toast = useToast()
  const blank = () => ({ category_id: '', cost_centre_id: '', account_id: '', amount: '', hard_limit: '' })
  const [rows, setRows] = useState<FormValues[]>(initial.length
    ? initial.map((l) => ({ category_id: l.category_id ?? '', cost_centre_id: l.cost_centre_id ?? '', account_id: l.account_id ?? '', amount: l.budget, hard_limit: l.hard_limit ? 'true' : '' }))
    : [blank()])
  const [error, setError] = useState<unknown>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true); setError(null)
    try {
      const body = rows.filter((r) => r.amount !== '').map((r) => ({
        category_id: r.category_id ? Number(r.category_id) : null,
        cost_centre_id: r.cost_centre_id ? Number(r.cost_centre_id) : null,
        account_id: r.account_id ? Number(r.account_id) : null,
        amount: r.amount,
        hard_limit: r.hard_limit === 'true',
      }))
      await api.put(`/budgets/${id}/lines`, body)
      toast('Budget lines saved')
      qc.invalidateQueries({ queryKey: [`/budgets/${id}/vs-actual`] })
      onClose()
    } catch (e) {
      setError(e)
      if (e instanceof ApiError) setFields(Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k.replace(/^(\d+)\./, 'lines.$1.'), v])))
    } finally { setBusy(false) }
  }
  return (
    <Drawer open onClose={onClose} title="Budget lines" wide
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save lines</Button></>}>
      <div className="flex flex-col gap-4">
        {error != null && <ErrorNote error={error} />}
        <p className="text-[13px] text-ink-2">Pick a category, a cost centre or an account for each line. A hard limit blocks expenses that would go over.</p>
        <LineItems value={rows} onChange={setRows} newRow={blank} errors={fields} columns={[
          { name: 'category_id', label: 'Expense category', type: 'select', options: [{ value: '', label: '—' }, ...(lk?.expense_categories ?? []).map((c) => ({ value: c.id, label: c.name! }))] },
          { name: 'cost_centre_id', label: 'Cost centre', type: 'select', options: [{ value: '', label: '—' }, ...(lk?.cost_centres ?? []).map((c) => ({ value: c.id, label: c.name! }))] },
          { name: 'account_id', label: 'Account', type: 'record', record: ACCOUNTS },
          { name: 'amount', label: 'Amount', type: 'money', width: '130px' },
          { name: 'hard_limit', label: 'Limit', type: 'select', width: '120px', options: [{ value: '', label: 'Soft' }, { value: 'true', label: 'Hard' }] },
        ]} />
      </div>
    </Drawer>
  )
}
