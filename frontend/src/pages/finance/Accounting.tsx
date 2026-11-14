import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpen, Check, Plus, Undo2, X } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { date, dateTime, label, today } from '../../lib/format'
import { useAction, useRefMap, useUrlState } from '../../lib/hooks'
import { DataTable } from '../../ui/DataTable'
import { cleanLines, LineItems, type FieldDef, type FormValues, type RecordSource } from '../../ui/Form'
import { Badge, Button, Card, Confirm, Drawer, ErrorNote, Facts, Field, Input, Loading, Segmented, Status } from '../../ui/kit'
import { History, RecordHeader, RecordLayout } from '../../ui/Record'
import { ResourcePage } from '../../ui/Resource'
import { useToast } from '../../ui/toast'
import { ApiError } from '../../lib/api'
import { Amount, DateInput, ExportMenu } from './shared'

export const ACCOUNTS: RecordSource = { path: '/accounting/accounts', label: (r) => `${r.code} ${r.name}` }

const SOURCE_LINK: Record<string, string> = {
  order: '/orders', sales_document: '/documents', expense: '/expenses', supplier_bill: '/supplier-bills',
  production_order: '/production-orders', asset: '/assets',
}

/* ---------- Journal ---------- */

export default function Journal() {
  const { can } = useAuth()
  const [creating, setCreating] = useState(false)
  return (
    <>
      <DataTable
        path="/accounting/journal"
        rowTo={(r: any) => `/accounting/journal/${r.id}`}
        search={false}
        filters={[
          { key: 'status', label: 'Status', options: ['draft', 'posted', 'rejected'] },
          { key: 'source_type', label: 'Source', options: ['order', 'sales_document', 'payment', 'expense', 'supplier_bill', 'supplier_payment', 'stock_movement', 'production_order'] },
          { key: 'manual_only', label: 'Manual only', type: 'bool' },
          { key: 'date_from', label: 'From', type: 'date' },
          { key: 'date_to', label: 'To', type: 'date' },
        ]}
        toolbar={can('accounting', 'create') && <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Manual entry</Button>}
        empty={{ title: 'No journal entries yet', body: 'Entries post automatically from orders, payments, bills and expenses.', icon: <BookOpen /> }}
        columns={[
          { key: 'number', label: 'Entry', render: (r: any) => <span className="font-medium">{r.number ?? 'Draft'}</span> },
          { key: 'entry_date', label: 'Date', render: (r: any) => date(r.entry_date) },
          { key: 'memo', label: 'Memo', className: 'max-w-96 truncate' },
          { key: 'source_type', label: 'Source', render: (r: any) => (r.is_manual ? <Badge tone="brand">Manual</Badge> : label(r.source_type)) },
          { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} /> },
        ]}
      />
      <ManualEntry open={creating} onClose={() => setCreating(false)} />
    </>
  )
}

function ManualEntry({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const blank = () => ({ account_id: '', debit: '', credit: '', memo: '' })
  const [entryDate, setEntryDate] = useState(today())
  const [memo, setMemo] = useState('')
  const [lines, setLines] = useState<FormValues[]>([blank(), blank()])
  const [error, setError] = useState<unknown>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true); setError(null); setFields({})
    try {
      const e = await api.post('/accounting/journal', { entry_date: entryDate, memo, lines: cleanLines(lines) })
      toast('Entry saved as draft. Someone else approves it to post.')
      qc.invalidateQueries({ queryKey: ['/accounting/journal'] })
      setLines([blank(), blank()]); setMemo('')
      onClose()
      navigate(`/accounting/journal/${e.id}`)
    } catch (err) {
      setError(err)
      if (err instanceof ApiError) setFields(err.fields)
    } finally { setBusy(false) }
  }
  return (
    <Drawer open={open} onClose={onClose} title="Manual journal entry" wide
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save draft</Button></>}>
      <div className="flex flex-col gap-4">
        {error != null && <ErrorNote error={error} />}
        <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
          <Field label="Date" error={fields.entry_date}><Input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} /></Field>
          <Field label="Memo" error={fields.memo}><Input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="What is this entry for" /></Field>
        </div>
        <LineItems value={lines} onChange={setLines} newRow={blank} errors={fields} columns={[
          { name: 'account_id', label: 'Account', type: 'record', record: ACCOUNTS },
          { name: 'debit', label: 'Debit', type: 'money', width: '120px' },
          { name: 'credit', label: 'Credit', type: 'money', width: '120px' },
          { name: 'memo', label: 'Line note', type: 'text' },
        ]} />
        <p className="text-[12.5px] text-muted">Debits must equal credits. Manual entries post once another person with approval access approves them.</p>
      </div>
    </Drawer>
  )
}

export function JournalEntry() {
  const id = Number(useParams().id)
  const key = `/accounting/journal/${id}`
  const { user, can } = useAuth()
  const navigate = useNavigate()
  const userName = useRefMap('/users')
  const { data: e, error } = useQuery({ queryKey: [key], queryFn: () => api.get(key) })
  const [ask, setAsk] = useState<'approve' | 'reject' | 'reverse' | null>(null)
  const act = useAction((kind: string) => api.post(`${key}/${kind}`, kind === 'reverse' ? {} : undefined), {
    success: 'Done', invalidate: [[key], ['/accounting/journal']],
    onSuccess: (r: any, kind) => { setAsk(null); if (kind === 'reverse') navigate(`/accounting/journal/${r.id}`) },
  })
  if (error) return <ErrorNote error={error} />
  if (!e) return <Loading />
  const decide = e.status === 'draft' && can('accounting', 'approve') && e.created_by_id !== user.id
  const src = e.source_type && SOURCE_LINK[e.source_type]
  return (
    <>
      <RecordHeader back="/accounting/journal" backLabel="Journal" title={e.number ?? 'Draft entry'} status={<Status value={e.status} />}
        meta={`${date(e.entry_date)} · ${e.memo ?? ''}`}
        actions={<>
          {decide && <Button icon={<X className="size-4" />} onClick={() => setAsk('reject')}>Reject</Button>}
          {decide && <Button variant="primary" icon={<Check className="size-4" />} onClick={() => setAsk('approve')}>Approve and post</Button>}
          {e.is_manual && e.status === 'posted' && can('accounting', 'approve') && <Button icon={<Undo2 className="size-4" />} onClick={() => setAsk('reverse')}>Reverse</Button>}
        </>} />
      <RecordLayout
        main={<>
          <Card pad={false} title="Lines">
            <table className="w-full text-[13px]">
              <thead><tr className="border-b border-line text-left text-[12px] text-muted">
                <th className="h-9 px-4 font-medium">Account</th><th className="px-3 font-medium">Note</th>
                <th className="px-3 text-right font-medium">Debit</th><th className="px-4 text-right font-medium">Credit</th>
              </tr></thead>
              <tbody>
                {e.lines.map((l: any, i: number) => (
                  <tr key={i} className="border-b border-line last:border-0">
                    <td className="h-11 px-4"><Link to={`/accounting/ledger/${l.account_id}`} className="hover:text-wine-800">{l.account}</Link></td>
                    <td className="px-3 text-ink-2">{l.memo}</td>
                    <td className="px-3 text-right">{Number(l.debit) ? <Amount v={l.debit} /> : ''}</td>
                    <td className="px-4 text-right">{Number(l.credit) ? <Amount v={l.credit} /> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Details">
            <Facts items={[
              ['Kind', e.is_manual ? 'Manual entry' : 'Automatic posting'],
              ['Source', src ? <Link to={`${src}/${e.source_id}`} className="text-wine-700 hover:underline">{label(e.source_type)} #{e.source_id}</Link> : e.source_type ? label(e.source_type) : null],
              ['Created by', e.created_by_id ? `${userName(e.created_by_id)} · ${dateTime(e.created_at)}` : dateTime(e.created_at)],
              ['Approved by', e.approved_by_id ? userName(e.approved_by_id) : null],
            ]} />
          </Card>
        </>}
        side={<History entity="journal_entries" id={id} />}
      />
      <Confirm open={ask === 'approve'} onClose={() => setAsk(null)} title="Approve and post this entry?" confirmLabel="Approve" loading={act.isPending} onConfirm={() => act.mutate('approve')} />
      <Confirm open={ask === 'reject'} onClose={() => setAsk(null)} title="Reject this entry?" danger confirmLabel="Reject" loading={act.isPending} onConfirm={() => act.mutate('reject')} />
      <Confirm open={ask === 'reverse'} onClose={() => setAsk(null)} title="Reverse this entry?" confirmLabel="Reverse"
        body="A new entry with debits and credits swapped will post today." loading={act.isPending} onConfirm={() => act.mutate('reverse')} />
    </>
  )
}

/* ---------- Accounts & trial balance ---------- */

const ACCOUNT_FIELDS: FieldDef[] = [
  { name: 'code', label: 'Code', required: true, createOnly: true },
  { name: 'name', label: 'Name', required: true },
  { name: 'type', label: 'Type', type: 'select', required: true, createOnly: true, options: ['asset', 'liability', 'equity', 'income', 'expense'] },
  { name: 'parent_id', label: 'Parent account', type: 'record', record: ACCOUNTS },
  { name: 'description', label: 'Description', type: 'textarea' },
]

export function Accounts() {
  const [view, setView] = useUrlState('view', 'accounts')
  const navigate = useNavigate()
  return (
    <div className="flex flex-col gap-4">
      <div><Segmented value={view as 'accounts' | 'trial'} onChange={setView}
        options={[{ value: 'accounts', label: 'Chart of accounts' }, { value: 'trial', label: 'Trial balance' }]} /></div>
      {view === 'trial' ? <TrialBalance /> : (
        <ResourcePage path="/accounting/accounts" feature="accounting" noun="account" fields={ACCOUNT_FIELDS}
          filters={[{ key: 'type', label: 'Type', options: ['asset', 'liability', 'equity', 'income', 'expense'] }]}
          rowActions={(r: any) => <Button variant="ghost" icon={<BookOpen className="size-4" />} onClick={() => navigate(`/accounting/ledger/${r.id}`)}>Ledger</Button>}
          columns={[
            { key: 'code', label: 'Code', sort: 'code', render: (r: any) => <span className="tabular font-medium">{r.code}</span> },
            { key: 'name', label: 'Name', sort: 'name', render: (r: any) => <>{r.name}{r.is_system && <Badge className="ml-2">System</Badge>}</> },
            { key: 'type', label: 'Type', render: (r: any) => label(r.type) },
            { key: 'description', label: 'Description', className: 'max-w-80 truncate text-ink-2' },
          ]} />
      )}
    </div>
  )
}

function TrialBalance() {
  const [asOf, setAsOf] = useState(today())
  const { data } = useQuery({ queryKey: ['/accounting/trial-balance', asOf], queryFn: () => api.get('/accounting/trial-balance', { as_of: asOf }) })
  return (
    <Card pad={false} title={<span className="flex items-center gap-2">Trial balance {data && (data.balanced ? <Badge tone="good">Balanced</Badge> : <Badge tone="bad">Out of balance</Badge>)}</span>}
      action={<div className="flex items-center gap-2">
        <DateInput label="As of" value={asOf} onChange={setAsOf} />
        <ExportMenu feature="accounting" path="/accounting/trial-balance" params={{ as_of: asOf }} />
      </div>}>
      {!data ? <Loading /> : (
        <div className="scroll-quiet overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead><tr className="border-b border-line text-left text-[12px] text-muted">
              <th className="h-9 px-4 font-medium">Account</th><th className="px-3 font-medium">Type</th>
              <th className="px-3 text-right font-medium">Debit</th><th className="px-3 text-right font-medium">Credit</th><th className="px-4 text-right font-medium">Balance</th>
            </tr></thead>
            <tbody>
              {data.rows.map((r: any) => (
                <tr key={r.account_id} className="border-b border-line">
                  <td className="h-10 px-4"><Link to={`/accounting/ledger/${r.account_id}`} className="hover:text-wine-800"><span className="mr-2 tabular text-muted">{r.code}</span>{r.name}</Link></td>
                  <td className="px-3 text-ink-2">{label(r.type)}</td>
                  <td className="px-3 text-right"><Amount v={r.debit} /></td>
                  <td className="px-3 text-right"><Amount v={r.credit} /></td>
                  <td className="px-4 text-right"><Amount v={r.balance} /></td>
                </tr>
              ))}
              <tr className="bg-page font-semibold">
                <td className="h-11 px-4" colSpan={2}>Total</td>
                <td className="px-3 text-right"><Amount v={data.total_debit} strong /></td>
                <td className="px-3 text-right"><Amount v={data.total_credit} strong /></td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

/* ---------- Ledger ---------- */

export function Ledger() {
  const id = Number(useParams().id)
  const [from, setFrom] = useUrlState('from')
  const [to, setTo] = useUrlState('to')
  const params = { date_from: from || undefined, date_to: to || undefined }
  const { data, error } = useQuery({ queryKey: [`/accounting/ledger/${id}`, params], queryFn: () => api.get(`/accounting/ledger/${id}`, params) })
  if (error) return <ErrorNote error={error} />
  return (
    <>
      <RecordHeader back="/accounting/accounts" backLabel="Accounts" title={data?.account ?? 'Ledger'}
        meta={data && `${date(data.from)} – ${date(data.to)} · ${data.rows.length} entries`}
        actions={<>
          <DateInput label="From" value={from} onChange={setFrom} />
          <DateInput label="To" value={to} onChange={setTo} />
          <ExportMenu feature="accounting" path={`/accounting/ledger/${id}`} params={params} />
        </>} />
      {!data ? <Loading /> : (
        <Card pad={false}>
          <div className="scroll-quiet overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead><tr className="border-b border-line text-left text-[12px] text-muted">
                <th className="h-9 px-4 font-medium">Date</th><th className="px-3 font-medium">Entry</th><th className="px-3 font-medium">Memo</th>
                <th className="px-3 text-right font-medium">Debit</th><th className="px-3 text-right font-medium">Credit</th><th className="px-4 text-right font-medium">Balance</th>
              </tr></thead>
              <tbody>
                <tr className="border-b border-line bg-page"><td className="h-10 px-4 text-ink-2" colSpan={5}>Opening balance</td><td className="px-4 text-right"><Amount v={data.opening_balance} strong /></td></tr>
                {data.rows.map((r: any, i: number) => (
                  <tr key={i} className="border-b border-line">
                    <td className="h-10 px-4 whitespace-nowrap">{date(r.date)}</td>
                    <td className="px-3 whitespace-nowrap">{SOURCE_LINK[r.source_type] ? <Link to={`${SOURCE_LINK[r.source_type]}/${r.source_id}`} className="text-wine-700 hover:underline">{r.entry}</Link> : r.entry}</td>
                    <td className="max-w-96 truncate px-3 text-ink-2">{r.memo}</td>
                    <td className="px-3 text-right">{Number(r.debit) ? <Amount v={r.debit} /> : ''}</td>
                    <td className="px-3 text-right">{Number(r.credit) ? <Amount v={r.credit} /> : ''}</td>
                    <td className="px-4 text-right"><Amount v={r.balance} /></td>
                  </tr>
                ))}
                <tr className="bg-page font-semibold"><td className="h-11 px-4" colSpan={5}>Closing balance</td><td className="px-4 text-right"><Amount v={data.closing_balance} strong /></td></tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  )
}
