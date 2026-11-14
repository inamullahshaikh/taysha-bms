import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Table2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { compactMoney, date, label, money, today } from '../../lib/format'
import { ChartCard, Meter, StatTile, TrendChart } from '../../ui/charts'
import type { FieldDef } from '../../ui/Form'
import { Button, Card, Drawer, Empty, ErrorNote, Facts, IconButton, Loading, Status } from '../../ui/kit'
import { Attachments, History, RecordHeader, RecordLayout } from '../../ui/Record'
import { FormDrawer, ResourcePage } from '../../ui/Resource'
import { useToast } from '../../ui/toast'

export const PLATFORMS = ['meta', 'google', 'tiktok', 'influencer', 'email', 'sms', 'event', 'offline', 'other']
const STATUSES = ['planned', 'active', 'paused', 'completed']

const FIELDS: FieldDef[] = [
  { name: 'name', label: 'Name', required: true, full: true },
  { name: 'platform', label: 'Platform', type: 'select', required: true, options: PLATFORMS, createOnly: true },
  { name: 'status', label: 'Status', type: 'select', options: STATUSES },
  { name: 'start_date', label: 'Starts', type: 'date' },
  { name: 'end_date', label: 'Ends', type: 'date' },
  { name: 'budget', label: 'Budget', type: 'money' },
  { name: 'discount_code_id', label: 'Discount code', type: 'record', record: { path: '/discount-codes', label: (r) => r.code }, hint: 'Orders using it count towards this campaign' },
  { name: 'utm_campaign', label: 'UTM campaign', hint: 'Website orders with this tag count too' },
  { name: 'audience', label: 'Audience', full: true },
  { name: 'creative_notes', label: 'Creative notes', type: 'textarea' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
]

export default function Campaigns() {
  return (
    <ResourcePage path="/campaigns" feature="marketing" noun="campaign" fields={FIELDS} rowTo={(r: any) => `/campaigns/${r.id}`}
      defaults={{ platform: 'meta', status: 'planned' }}
      filters={[{ key: 'platform', label: 'Platform', options: PLATFORMS }, { key: 'status', label: 'Status', options: STATUSES }]}
      columns={[
        { key: 'name', label: 'Campaign', render: (r: any) => <span className="font-medium">{r.name}</span> },
        { key: 'platform', label: 'Platform', render: (r: any) => label(r.platform) },
        { key: 'start_date', label: 'Runs', render: (r: any) => `${date(r.start_date)} – ${date(r.end_date)}` },
        { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} /> },
        { key: 'budget', label: 'Budget', align: 'right', render: (r: any) => money(r.budget) },
      ]} />
  )
}

export function CampaignDetail() {
  const id = Number(useParams().id)
  const key = `/campaigns/${id}`
  const { can } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const [drawer, setDrawer] = useState<'edit' | 'metrics' | null>(null)
  const { data: c, error } = useQuery({ queryKey: [key], queryFn: () => api.get(key) })
  const perf = useQuery({ queryKey: [`${key}/performance`], queryFn: () => api.get(`${key}/performance`) })
  const metrics = useQuery({ queryKey: [`${key}/metrics`], queryFn: () => api.get<any[]>(`${key}/metrics`) })
  if (error) return <ErrorNote error={error} />
  if (!c) return <Loading />
  const p = perf.data
  const days = metrics.data ?? []
  return (
    <>
      <RecordHeader back="/campaigns" backLabel="Campaigns" title={c.name} status={<Status value={c.status} />}
        meta={`${label(c.platform)} · ${date(c.start_date)} – ${date(c.end_date)}${c.budget ? ` · budget ${money(c.budget)}` : ''}`}
        actions={can('marketing', 'edit') && <>
          <Button icon={<Table2 className="size-4" />} onClick={() => setDrawer('metrics')}>Enter daily numbers</Button>
          <Button icon={<Pencil className="size-4" />} onClick={() => setDrawer('edit')}>Edit</Button>
        </>} />
      <RecordLayout
        main={<>
          {p && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile label="Spent" value={compactMoney(p.total_cost)} sub={Number(p.influencer_fees) ? `incl. ${compactMoney(p.influencer_fees)} influencer fees` : undefined} />
              <StatTile label="Revenue" value={compactMoney(p.revenue)} sub={`${p.orders} orders`} />
              <StatTile label="Return on spend" value={p.roas ? `${Number(p.roas).toFixed(2)}×` : '—'} />
              <StatTile label="Cost per new customer" value={p.cac ? compactMoney(p.cac) : '—'} sub={`${p.new_customers} new customers`} />
            </div>
          )}
          {p?.budget_used_pct && (
            <Card>
              <div className="mb-2 flex justify-between text-[13px]"><span className="text-ink-2">Budget used</span><span className="tabular font-medium">{Number(p.budget_used_pct).toFixed(0)}%</span></div>
              <Meter value={Number(p.budget_used_pct)} max={100} tone={Number(p.budget_used_pct) > 100 ? 'bad' : Number(p.budget_used_pct) > 90 ? 'warn' : 'brand'} />
            </Card>
          )}
          {days.length > 0 ? (
            <div className="grid gap-4 xl:grid-cols-2">
              <ChartCard title="Daily spend">
                <TrendChart data={days} x="metric_date" xFmt={(v) => date(v).replace(/ \d{4}$/, '')} kind="bar" height={200} fmt={(v) => money(v)} series={[{ key: 'spend', label: 'Spend' }]} />
              </ChartCard>
              <ChartCard title="Leads and conversions">
                <TrendChart data={days} x="metric_date" xFmt={(v) => date(v).replace(/ \d{4}$/, '')} kind="line" height={200}
                  series={[{ key: 'leads', label: 'Leads', color: '#3b6fb6' }, { key: 'conversions', label: 'Conversions', color: '#1f8a70' }]} />
              </ChartCard>
            </div>
          ) : (
            <Card><Empty title="No daily numbers yet">Copy them from the ads manager export, or type them in.</Empty></Card>
          )}
          {p && (
            <Card title="Funnel">
              <Facts cols={4} items={[
                ['Reach', p.reach?.toLocaleString()], ['Impressions', p.impressions?.toLocaleString()], ['Clicks', p.clicks?.toLocaleString()],
                ['Click-through', p.ctr_pct ? `${p.ctr_pct}%` : null], ['Leads', p.leads?.toLocaleString()], ['Conversions', p.conversions?.toLocaleString()],
                ['Gross profit', p.gross_profit !== undefined ? money(p.gross_profit) : undefined],
                ['Profit after marketing', p.profit_after_marketing !== undefined ? money(p.profit_after_marketing) : undefined],
              ]} />
            </Card>
          )}
          <Card title="Brief">
            <Facts items={[['Audience', c.audience], ['UTM campaign', c.utm_campaign], ['Creative notes', c.creative_notes], ['Notes', c.notes]]} />
          </Card>
        </>}
        side={<><Attachments entity="campaigns" id={id} canEdit={can('marketing', 'edit')} /><History entity="campaigns" id={id} /></>}
      />
      <FormDrawer open={drawer === 'edit'} onClose={() => setDrawer(null)} title="Edit campaign" mode="edit" fields={FIELDS} initial={c}
        submit={async (body) => { await api.patch(key, body); toast('Saved'); qc.invalidateQueries({ queryKey: [key] }); qc.invalidateQueries({ queryKey: [`${key}/performance`] }) }} />
      {drawer === 'metrics' && <MetricsEditor id={id} existing={days} onClose={() => setDrawer(null)} />}
    </>
  )
}

const COLS = [
  { key: 'spend', label: 'Spend' }, { key: 'reach', label: 'Reach' }, { key: 'impressions', label: 'Impressions' },
  { key: 'clicks', label: 'Clicks' }, { key: 'leads', label: 'Leads' }, { key: 'conversions', label: 'Conversions' },
]

/** Daily numbers: rows saved by date (existing dates are updated). */
function MetricsEditor({ id, existing, onClose }: { id: number; existing: any[]; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const blank = () => ({ metric_date: today(), spend: '', reach: '', impressions: '', clicks: '', leads: '', conversions: '' })
  const [rows, setRows] = useState<Record<string, string>[]>([...existing.slice(-6).map((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, String(v ?? '')]))), blank()])
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const set = (i: number, k: string, v: string) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)))
  const save = async () => {
    setBusy(true); setError(null)
    try {
      const body = rows.filter((r) => r.metric_date && COLS.some((c) => r[c.key] !== '')).map((r) => ({
        metric_date: r.metric_date,
        ...Object.fromEntries(COLS.map((c) => [c.key, r[c.key] === '' ? 0 : c.key === 'spend' ? r[c.key] : Math.round(Number(r[c.key]))])),
      }))
      await api.put(`/campaigns/${id}/metrics`, body)
      toast(`${body.length} days saved`)
      for (const k of ['metrics', 'performance']) qc.invalidateQueries({ queryKey: [`/campaigns/${id}/${k}`] })
      onClose()
    } catch (e) { setError(e) } finally { setBusy(false) }
  }
  return (
    <Drawer open onClose={onClose} title="Daily numbers" wide
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      {error != null && <div className="mb-4"><ErrorNote error={error} /></div>}
      <p className="mb-3 text-[13px] text-ink-2">The last few days are shown. Saving a date that already exists replaces its numbers.</p>
      <div className="scroll-quiet overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-[13px]">
          <thead><tr className="border-b border-line bg-page text-left text-[12px] text-muted">
            <th className="px-2 py-2 font-medium">Date</th>{COLS.map((c) => <th key={c.key} className="px-2 py-2 font-medium">{c.label}</th>)}<th className="w-10" />
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                <td className="p-1.5"><input type="date" aria-label="Date" value={r.metric_date} onChange={(e) => set(i, 'metric_date', e.target.value)}
                  className="h-9 rounded-lg border border-line-strong px-2 text-[13px] focus:border-wine-600 focus:outline-none" /></td>
                {COLS.map((c) => (
                  <td key={c.key} className="p-1.5"><input type="number" min={0} step="any" aria-label={c.label} value={r[c.key]} onChange={(e) => set(i, c.key, e.target.value)}
                    className="tabular h-9 w-24 rounded-lg border border-line-strong px-2 text-[13px] focus:border-wine-600 focus:outline-none" /></td>
                ))}
                <td className="pr-1.5"><IconButton label="Remove row" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="border-t border-line p-1.5"><Button variant="ghost" size="sm" icon={<Plus className="size-4" />} onClick={() => setRows((x) => [...x, blank()])}>Add day</Button></div>
      </div>
    </Drawer>
  )
}
