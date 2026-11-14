import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, PieChart, Plus, Vote, X } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { date, label, money, pct, today } from '../../lib/format'
import { useAction, useRefMap, useUrlState } from '../../lib/hooks'
import { SegmentBar } from '../../ui/charts'
import { DataTable } from '../../ui/DataTable'
import type { FieldDef } from '../../ui/Form'
import { Button, Card, Drawer, Empty, ErrorNote, Facts, Field, Input, Loading, Segmented, Select, Status } from '../../ui/kit'
import { Attachments, History, RecordHeader, RecordLayout } from '../../ui/Record'
import { FormDrawer, ResourcePage } from '../../ui/Resource'
import { useToast } from '../../ui/toast'
import { Amount } from './shared'

const KINDS = ['capital_contribution', 'additional_investment', 'loan_in', 'loan_repayment', 'profit_distribution', 'drawing', 'reimbursement']

const PARTNER: FieldDef[] = [
  { name: 'name', label: 'Name', required: true },
  { name: 'cnic', label: 'CNIC' },
  { name: 'phone', label: 'Phone' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'joined_on', label: 'Joined on', type: 'date' },
  { name: 'address', label: 'Address', full: true },
  { name: 'notes', label: 'Notes', type: 'textarea' },
]
const TXN: FieldDef[] = [
  { name: 'partner_id', label: 'Partner', type: 'record', record: { path: '/partners' }, required: true },
  { name: 'kind', label: 'Type', type: 'select', required: true, options: KINDS },
  { name: 'amount', label: 'Amount', type: 'money', required: true },
  { name: 'txn_date', label: 'Date', type: 'date' },
  { name: 'method', label: 'Method', type: 'select', options: ['cash', 'bank_transfer', 'cheque', 'other'] },
  { name: 'reference', label: 'Reference' },
  { name: 'note', label: 'Note', type: 'textarea' },
]
const RESOLUTION: FieldDef[] = [
  { name: 'title', label: 'Title', required: true, full: true },
  { name: 'kind', label: 'Type', type: 'select', options: ['resolution', 'minutes', 'agreement'], createOnly: true },
  { name: 'meeting_date', label: 'Meeting date', type: 'date' },
  { name: 'description', label: 'Details', type: 'textarea' },
]

export default function Partners() {
  const [view, setView] = useUrlState('view', 'partners')
  return (
    <div className="flex flex-col gap-4">
      <OwnershipCard />
      <div><Segmented value={view as any} onChange={setView} options={[
        { value: 'partners', label: 'Partners' }, { value: 'transactions', label: 'Money in and out' }, { value: 'resolutions', label: 'Resolutions' },
      ]} /></div>
      {view === 'transactions' ? <Transactions /> : view === 'resolutions' ? <Resolutions /> : (
        <ResourcePage path="/partners" feature="partners" noun="partner" fields={PARTNER} rowTo={(r: any) => `/partners/${r.id}`}
          columns={[
            { key: 'name', label: 'Partner', render: (r: any) => <span className="font-medium">{r.name}</span> },
            { key: 'ownership_pct', label: 'Ownership', align: 'right', render: (r: any) => pct(r.ownership_pct, 2) },
            { key: 'phone', label: 'Phone' },
            { key: 'joined_on', label: 'Joined', render: (r: any) => date(r.joined_on) },
          ]} />
      )}
    </div>
  )
}

function OwnershipCard() {
  const { can } = useAuth()
  const [editing, setEditing] = useState(false)
  const { data } = useQuery({ queryKey: ['/partners/report'], queryFn: () => api.get('/partners/report') })
  if (!data) return <Loading />
  const rows: any[] = data.partners
  if (!rows.length) return null
  return (
    <Card title="Ownership" action={can('partners', 'edit') && <Button size="sm" icon={<PieChart className="size-4" />} onClick={() => setEditing(true)}>Change shares</Button>}>
      {(
        <>
          <SegmentBar fmt={(v) => `${v.toFixed(2)}%`} parts={rows.map((r) => ({ label: r.name, value: r.ownership_pct }))} />
          <div className="scroll-quiet mt-5 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead><tr className="border-b border-line text-left text-[12px] text-muted">
                <th className="h-9 font-medium">Partner</th><th className="px-3 text-right font-medium">Capital in</th><th className="px-3 text-right font-medium">Loans owed</th>
                <th className="px-3 text-right font-medium">Distributions</th><th className="px-3 text-right font-medium">Drawings</th><th className="pl-3 text-right font-medium">Net invested</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.partner_id} className="border-b border-line last:border-0">
                    <td className="h-10 font-medium">{r.name}</td>
                    {['capital_contributed', 'loans_outstanding', 'distributions', 'drawings'].map((k) => <td key={k} className="px-3 text-right"><Amount v={r[k]} /></td>)}
                    <td className="pl-3 text-right"><Amount v={r.net_invested} strong /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {editing && <SharesEditor partners={rows} onClose={() => setEditing(false)} />}
    </Card>
  )
}

function SharesEditor({ partners, onClose }: { partners: any[]; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [shares, setShares] = useState<Record<number, string>>(Object.fromEntries(partners.map((p) => [p.partner_id, String(Number(p.ownership_pct))])))
  const [eff, setEff] = useState(today())
  const [res, setRes] = useState('')
  const [error, setError] = useState<unknown>(null)
  const resolutions = useQuery({ queryKey: ['/resolutions', 'approved'], queryFn: () => api.get('/resolutions', { status: 'approved', page_size: 100 }) })
  const save = useAction(() => api.put('/partners/ownership', { shares, effective_date: eff, resolution_id: res ? Number(res) : null }), {
    onSuccess: () => { toast('Ownership updated'); qc.invalidateQueries({ queryKey: ['/partners/report'] }); onClose() },
  })
  return (
    <Drawer open onClose={onClose} title="Change ownership"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => { setError(null); save.mutate(undefined, { onError: setError }) }}>Save shares</Button></>}>
      <div className="flex flex-col gap-4">
        {error != null && <ErrorNote error={error} />}
        <p className="text-[13px] text-ink-2">Shares can't add up to more than 100%. The change is kept in each partner's history.</p>
        {partners.map((p) => (
          <Field key={p.partner_id} label={p.name}>
            <Input type="number" step="0.01" value={shares[p.partner_id]} onChange={(e) => setShares((s) => ({ ...s, [p.partner_id]: e.target.value }))} />
          </Field>
        ))}
        <Field label="Effective from"><Input type="date" value={eff} onChange={(e) => setEff(e.target.value)} /></Field>
        <Field label="Approved by resolution">
          <Select value={res} onChange={(e) => setRes(e.target.value)} placeholder="—"
            options={(resolutions.data?.items ?? []).map((r: any) => ({ value: r.id, label: r.title }))} />
        </Field>
      </div>
    </Drawer>
  )
}

export function Transactions({ partnerId }: { partnerId?: number }) {
  const { user, can } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const partner = useRefMap('/partners')
  const [creating, setCreating] = useState(false)
  const decide = useAction((v: { id: number; kind: 'approve' | 'reject' }) => api.post(`/partner-transactions/${v.id}/${v.kind}`), { success: 'Done', invalidate: [['/partner-transactions'], ['/partners/report']] })
  return (
    <>
      <DataTable path="/partner-transactions" params={{ partner_id: partnerId }} persist={!partnerId} search={false}
        filters={[{ key: 'kind', label: 'Type', options: KINDS }, { key: 'status', label: 'Status', options: ['pending', 'approved', 'rejected'] }]}
        exportFeature={partnerId ? undefined : 'partners'}
        toolbar={can('partners', 'edit') && <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Record</Button>}
        empty={{ title: 'No money recorded yet' }}
        columns={[
          { key: 'txn_date', label: 'Date', render: (r: any) => date(r.txn_date) },
          ...(partnerId ? [] : [{ key: 'partner_id', label: 'Partner', render: (r: any) => partner(r.partner_id) }]),
          { key: 'kind', label: 'Type', render: (r: any) => label(r.kind) },
          { key: 'reference', label: 'Reference' },
          { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} /> },
          { key: 'amount', label: 'Amount', align: 'right', render: (r: any) => money(r.amount) },
          { key: 'act', label: '', align: 'right', render: (r: any) => r.status === 'pending' && can('partners', 'approve') && r.created_by_id !== user.id && (
            <span className="inline-flex gap-1">
              <Button size="sm" variant="ghost" aria-label="Reject" onClick={() => decide.mutate({ id: r.id, kind: 'reject' })}><X className="size-4" /></Button>
              <Button size="sm" icon={<Check className="size-4" />} onClick={() => decide.mutate({ id: r.id, kind: 'approve' })}>Approve</Button>
            </span>
          ) },
        ]} />
      <FormDrawer open={creating} onClose={() => setCreating(false)} title="Record partner money" fields={TXN} initial={{ partner_id: partnerId ?? '', txn_date: today(), method: 'bank_transfer' }}
        submit={async (body) => { await api.post('/partner-transactions', body); toast('Recorded. Another partner approves it before it posts.'); qc.invalidateQueries({ queryKey: ['/partner-transactions'] }) }} />
    </>
  )
}

function Resolutions() {
  const [voting, setVoting] = useState<any>(null)
  return (
    <>
      <ResourcePage path="/resolutions" feature="partners" noun="resolution" fields={RESOLUTION}
        filters={[{ key: 'status', label: 'Status', options: ['proposed', 'approved', 'rejected', 'recorded'] }]}
        rowActions={(r: any, close) => r.status === 'proposed' && <Button icon={<Vote className="size-4" />} onClick={() => { close(); setVoting(r) }}>Votes</Button>}
        columns={[
          { key: 'title', label: 'Resolution', render: (r: any) => <span className="font-medium">{r.title}</span> },
          { key: 'kind', label: 'Type', render: (r: any) => label(r.kind) },
          { key: 'meeting_date', label: 'Meeting', render: (r: any) => date(r.meeting_date) },
          { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} /> },
          { key: 'decided_at', label: 'Decided', render: (r: any) => date(r.decided_at) },
        ]} />
      {voting && <Votes resolution={voting} onClose={() => setVoting(null)} />}
    </>
  )
}

/** Record each partner's vote; the resolution passes or fails by ownership weight. */
function Votes({ resolution, onClose }: { resolution: any; onClose: () => void }) {
  const { can } = useAuth()
  const key = `/resolutions/${resolution.id}/votes`
  const votes = useQuery({ queryKey: [key], queryFn: () => api.get<any[]>(key) })
  const partners = useQuery({ queryKey: ['/partners/report'], queryFn: () => api.get('/partners/report') })
  const cast = useAction((v: { partner_id: number; vote: string }) => api.post(key, v), { invalidate: [[key], ['/resolutions']] })
  return (
    <Drawer open onClose={onClose} title={resolution.title}>
      <p className="mb-4 text-[13px] text-ink-2">Votes are weighted by each partner's share. The resolution is decided once the weight passes half.</p>
      {(partners.data?.partners ?? []).map((p: any) => {
        const v = votes.data?.find((x) => x.partner_id === p.partner_id)
        return (
          <div key={p.partner_id} className="flex items-center justify-between gap-3 border-b border-line py-3 last:border-0">
            <div><p className="text-[13.5px] font-medium">{p.name}</p><p className="text-[12px] text-muted">{pct(p.ownership_pct, 2)} weight</p></div>
            {v ? <Status value={v.vote} tone={v.vote === 'yes' ? 'good' : v.vote === 'no' ? 'bad' : 'neutral'} /> : can('partners', 'edit') ? (
              <div className="flex gap-1">
                {['yes', 'no', 'abstain'].map((x) => <Button key={x} size="sm" variant={x === 'yes' ? 'primary' : 'secondary'} onClick={() => cast.mutate({ partner_id: p.partner_id, vote: x })}>{label(x)}</Button>)}
              </div>
            ) : <span className="text-[12.5px] text-muted">Not voted</span>}
          </div>
        )
      })}
    </Drawer>
  )
}

export function PartnerDetail() {
  const id = Number(useParams().id)
  const key = `/partners/${id}`
  const { can } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const { data: p, error } = useQuery({ queryKey: [key], queryFn: () => api.get(key) })
  const hist = useQuery({ queryKey: [`${key}/ownership-history`], queryFn: () => api.get<any[]>(`${key}/ownership-history`) })
  if (error) return <ErrorNote error={error} />
  if (!p) return <Loading />
  return (
    <>
      <RecordHeader back="/partners" backLabel="Partners" title={p.name} meta={`${pct(p.ownership_pct, 2)} ownership`}
        actions={can('partners', 'edit') && <Button onClick={() => setEditing(true)}>Edit</Button>} />
      <RecordLayout
        main={<>
          <Card title="Details">
            <Facts items={[['CNIC', p.cnic], ['Phone', p.phone], ['Email', p.email], ['Joined', date(p.joined_on)], ['Address', p.address], ['Notes', p.notes]]} />
          </Card>
          <Transactions partnerId={id} />
        </>}
        side={<>
          <Card pad={false} title="Ownership history">
            {!hist.data?.length ? <Empty title="No changes yet" /> : (
              <ul className="divide-y divide-line">
                {hist.data.map((h, i) => (
                  <li key={i} className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                    <span>{date(h.effective_date)}</span>
                    <span className="tabular">{pct(h.old_pct, 2)} → <span className="font-medium">{pct(h.new_pct, 2)}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Attachments entity="partners" id={id} canEdit={can('partners', 'edit')} />
          <History entity="partners" id={id} />
        </>}
      />
      <FormDrawer open={editing} onClose={() => setEditing(false)} title="Edit partner" mode="edit" fields={PARTNER} initial={p}
        submit={async (body) => { await api.patch(key, body); toast('Saved'); qc.invalidateQueries({ queryKey: [key] }) }} />
    </>
  )
}
