import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, Paperclip, Plus, Receipt } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { compactMoney, date, money, month } from '../../lib/format'
import { useLookupName, useLookups, useUrlState } from '../../lib/hooks'
import { BarList, ChartCard, StatTile, TrendChart } from '../../ui/charts'
import { DataTable } from '../../ui/DataTable'
import type { FieldDef } from '../../ui/Form'
import { Button, Segmented, Status } from '../../ui/kit'
import { FormDrawer } from '../../ui/Resource'
import { useToast } from '../../ui/toast'

const METHODS = ['cash', 'card', 'bank_transfer', 'cheque', 'online', 'other']

export const EXPENSE_FIELDS: FieldDef[] = [
  { name: 'description', label: 'What was it for', required: true, full: true },
  { name: 'amount', label: 'Amount', type: 'money', required: true, hint: 'PKR, including tax' },
  { name: 'tax_amount', label: 'Tax included', type: 'money' },
  { name: 'expense_date', label: 'Date', type: 'date' },
  { name: 'category_id', label: 'Category', type: 'lookup', lookup: 'expense_categories', required: true },
  { name: 'payee', label: 'Paid to' },
  { name: 'payment_method', label: 'Paid by', type: 'select', options: METHODS },
  { name: 'cost_centre_id', label: 'Cost centre', type: 'lookup', lookup: 'cost_centres' },
  { name: 'department_id', label: 'Department', type: 'lookup', lookup: 'departments' },
  { name: 'branch_id', label: 'Branch', type: 'lookup', lookup: 'branches' },
  { name: 'reference', label: 'Reference', placeholder: 'Bill or receipt number' },
]

/** Receipt picker: opens the camera on phones, file picker elsewhere. */
export function ReceiptInput({ file, onChange }: { file: File | null; onChange: (f: File | null) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-line-strong px-3 py-3 text-[13px] text-ink-2 hover:border-wine-200 hover:bg-wine-50">
      <span className="flex size-9 items-center justify-center rounded-full bg-wine-50 text-wine-700">{file ? <Paperclip className="size-4" /> : <Camera className="size-4" />}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-ink">{file ? file.name : 'Add a receipt'}</span>
        <span className="block text-[12px] text-muted">{file ? 'Tap to change' : 'Take a photo or choose a file'}</span>
      </span>
      <input type="file" accept="image/*,application/pdf" capture="environment" className="sr-only"
        onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
    </label>
  )
}

export async function uploadReceipt(id: number, file: File) {
  const fd = new FormData()
  fd.append('file', file)
  await api.post('/attachments', fd, { entity_type: 'expenses', entity_id: id, category: 'receipt' })
}

export default function Expenses() {
  const { can } = useAuth()
  const canView = can('expenses')
  const [view, setView] = useUrlState('view', canView ? 'all' : 'mine')
  const mine = !canView || view === 'mine'
  const [creating, setCreating] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const qc = useQueryClient()
  const toast = useToast()
  const category = useLookupName('expense_categories')
  const { data: lk } = useLookups()

  return (
    <div className="flex flex-col gap-4">
      {canView && <SpendSummary />}
      <DataTable
        path="/expenses"
        params={{ mine: mine || undefined }}
        rowTo={(r: any) => `/expenses/${r.id}`}
        exportFeature={canView ? 'expenses' : undefined}
        search="Search expenses"
        filters={[
          { key: 'status', label: 'Status', options: ['submitted', 'approved', 'rejected', 'cancelled'] },
          { key: 'category_id', label: 'Category', options: (lk?.expense_categories ?? []).map((c) => ({ value: c.id, label: c.name! })) },
          { key: 'date_from', label: 'From', type: 'date' },
          { key: 'date_to', label: 'To', type: 'date' },
        ]}
        toolbar={<>
          {canView && <Segmented value={view as 'all' | 'mine'} onChange={setView} options={[{ value: 'all', label: 'All' }, { value: 'mine', label: 'Mine' }]} />}
          {can('expenses', 'create') && <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New expense</Button>}
        </>}
        empty={{ title: mine ? "You haven't submitted any expenses" : 'No expenses yet', icon: <Receipt /> }}
        columns={[
          { key: 'number', label: 'Number', render: (r: any) => <span className="font-medium">{r.number}</span> },
          { key: 'expense_date', label: 'Date', sort: 'expense_date', render: (r: any) => date(r.expense_date) },
          { key: 'description', label: 'Description', className: 'max-w-72 truncate', render: (r: any) => <>{r.description}{r.has_receipt && <Paperclip className="ml-1.5 inline size-3.5 text-muted" aria-label="Has receipt" />}</> },
          { key: 'category_id', label: 'Category', render: (r: any) => category(r.category_id) },
          { key: 'payee', label: 'Paid to' },
          { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} /> },
          { key: 'amount', label: 'Amount', align: 'right', sort: 'amount', render: (r: any) => money(r.amount) },
        ]}
      />
      <FormDrawer open={creating} onClose={() => { setCreating(false); setFile(null) }} title="New expense" fields={EXPENSE_FIELDS}
        submitLabel="Submit for approval"
        submit={async (body) => {
          const e = await api.post('/expenses', body)
          if (file) await uploadReceipt(e.id, file).catch(() => toast('Expense saved, but the receipt did not upload', 'error'))
          toast(`${e.number} submitted`)
          setFile(null)
          qc.invalidateQueries({ queryKey: ['/expenses'] })
        }}>
        <ReceiptInput file={file} onChange={setFile} />
      </FormDrawer>
    </div>
  )
}

function SpendSummary() {
  const monthly = useQuery({ queryKey: ['/reports/expenses', 'month-trend'], queryFn: () => api.get('/reports/expenses', { range: 'year', group_by: 'month' }) })
  const cats = useQuery({ queryKey: ['/reports/expenses', 'cat-month'], queryFn: () => api.get('/reports/expenses', { range: 'month', group_by: 'category' }) })
  const pending = useQuery({ queryKey: ['/expenses', 'pending-count'], queryFn: () => api.get('/expenses', { status: 'submitted', page_size: 1 }) })
  const rows = monthly.data?.rows ?? []
  const last = rows[rows.length - 1], prev = rows[rows.length - 2]
  const delta = last && prev && Number(prev.amount) ? ((Number(last.amount) - Number(prev.amount)) / Number(prev.amount)) * 100 : null
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
        <StatTile label="Spent this month" value={cats.data ? compactMoney(cats.data.total) : '—'} delta={delta} upIsGood={false} sub="excl. tax, approved" />
        <StatTile label="Waiting for approval" value={pending.data?.total ?? '—'} sub="submitted expenses" to="/expenses?status=submitted" />
      </div>
      <ChartCard title="Monthly spend" sub="This year, approved, excl. tax">
        <TrendChart data={rows} x="label" xFmt={month} kind="bar" height={200} fmt={(v) => money(v)}
          series={[{ key: 'amount', label: 'Spend' }]} />
      </ChartCard>
      <ChartCard title="By category" sub="This month">
        <BarList limit={6} fmt={(v) => compactMoney(v)} items={(cats.data?.rows ?? []).map((r: any) => ({ label: r.label, value: r.amount }))} />
      </ChartCard>
    </div>
  )
}
