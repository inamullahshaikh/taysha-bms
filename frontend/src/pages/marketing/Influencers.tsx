import { useQueryClient } from '@tanstack/react-query'
import { PackageCheck, Plus } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { compact, date, label, money } from '../../lib/format'
import { useAction, useRefMap, useUrlState } from '../../lib/hooks'
import { DataTable } from '../../ui/DataTable'
import { cleanLines, LineItems, LookupSelect, type FieldDef, type FormValues } from '../../ui/Form'
import { Badge, Button, Field, Modal, Segmented, Status } from '../../ui/kit'
import { FormDrawer, ResourcePage } from '../../ui/Resource'
import { useToast } from '../../ui/toast'

const INFLUENCER: FieldDef[] = [
  { name: 'name', label: 'Name', required: true },
  { name: 'handle', label: 'Handle', placeholder: '@name' },
  { name: 'platform', label: 'Platform', placeholder: 'instagram' },
  { name: 'followers', label: 'Followers', type: 'number' },
  { name: 'rate', label: 'Usual rate', type: 'money' },
  { name: 'phone', label: 'Phone' },
  { name: 'email', label: 'Email', type: 'email' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
]
const DEAL_STATUSES = ['agreed', 'samples_sent', 'posted', 'paid', 'cancelled']
const DEAL: FieldDef[] = [
  { name: 'influencer_id', label: 'Influencer', type: 'record', record: { path: '/influencers' }, required: true, createOnly: true },
  { name: 'campaign_id', label: 'Campaign', type: 'record', record: { path: '/campaigns' }, createOnly: true },
  { name: 'fee', label: 'Fee', type: 'money' },
  { name: 'status', label: 'Status', type: 'select', options: DEAL_STATUSES },
  { name: 'posting_date', label: 'Posting date', type: 'date' },
  { name: 'post_url', label: 'Post link' },
  { name: 'deliverables', label: 'Deliverables', type: 'textarea', placeholder: '1 reel + 3 stories' },
]

export default function Influencers() {
  const [view, setView] = useUrlState('view', 'influencers')
  return (
    <div className="flex flex-col gap-4">
      <div><Segmented value={view as any} onChange={setView} options={[{ value: 'influencers', label: 'Influencers' }, { value: 'deals', label: 'Deals' }]} /></div>
      {view === 'deals' ? <Deals /> : (
        <ResourcePage path="/influencers" feature="marketing" noun="influencer" fields={INFLUENCER}
          columns={[
            { key: 'name', label: 'Name', render: (r: any) => <span className="font-medium">{r.name}</span> },
            { key: 'handle', label: 'Handle' },
            { key: 'platform', label: 'Platform', render: (r: any) => label(r.platform) },
            { key: 'followers', label: 'Followers', align: 'right', render: (r: any) => compact(r.followers) },
            { key: 'rate', label: 'Rate', align: 'right', render: (r: any) => money(r.rate) },
          ]} />
      )}
    </div>
  )
}

function Deals() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const influencer = useRefMap('/influencers')
  const campaign = useRefMap('/campaigns')
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<any>(null)
  const [sending, setSending] = useState<any>(null)
  const [samples, setSamples] = useState<FormValues[]>([])
  const refresh = () => qc.invalidateQueries({ queryKey: ['/influencer-deals'] })
  return (
    <>
      <DataTable path="/influencer-deals" search={false} onRowClick={can('marketing', 'edit') ? setEditing : undefined}
        filters={[{ key: 'status', label: 'Status', options: DEAL_STATUSES }]}
        exportFeature="marketing"
        toolbar={can('marketing', 'edit') && <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => { setSamples([]); setCreating(true) }}>New deal</Button>}
        empty={{ title: 'No influencer deals yet' }}
        columns={[
          { key: 'influencer_id', label: 'Influencer', render: (r: any) => <span className="font-medium">{influencer(r.influencer_id)}</span> },
          { key: 'campaign_id', label: 'Campaign', render: (r: any) => (r.campaign_id ? campaign(r.campaign_id) : '—') },
          { key: 'posting_date', label: 'Posting', render: (r: any) => date(r.posting_date) },
          { key: 'samples', label: 'Samples', render: (r: any) => (!r.samples?.length ? '—' : r.samples_sent ? <Badge tone="good">Sent</Badge> : <Badge tone="warn">{r.samples.length} to send</Badge>) },
          { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} /> },
          { key: 'fee', label: 'Fee', align: 'right', render: (r: any) => money(r.fee) },
        ]} />
      <FormDrawer open={creating} onClose={() => setCreating(false)} title="New influencer deal" fields={DEAL} initial={{ status: 'agreed' }} wide
        submit={async (body) => { await api.post('/influencer-deals', { ...body, samples: cleanLines(samples) }); toast('Deal saved'); refresh() }}>
        <div>
          <p className="mb-2 text-[12.5px] font-medium text-ink-2">Samples to send</p>
          <LineItems value={samples} onChange={setSamples} addLabel="Add product"
            columns={[{ name: 'product_id', label: 'Product', type: 'product' }, { name: 'quantity', label: 'Qty', type: 'number', width: '100px' }]} />
        </div>
      </FormDrawer>
      {editing && (
        <FormDrawer open onClose={() => setEditing(null)} title={`Deal with ${influencer(editing.influencer_id)}`} mode="edit" fields={DEAL} initial={editing}
          footerExtra={editing.samples?.length > 0 && !editing.samples_sent && can('inventory', 'create') && (
            <Button icon={<PackageCheck className="size-4" />} onClick={() => { setSending(editing); setEditing(null) }}>Send samples</Button>
          )}
          submit={async (body) => { await api.patch(`/influencer-deals/${editing.id}`, body); toast('Saved'); refresh() }} />
      )}
      {sending && <SendSamples deal={sending} onClose={() => setSending(null)} />}
    </>
  )
}

/** Samples leave stock from the chosen warehouse. */
function SendSamples({ deal, onClose }: { deal: any; onClose: () => void }) {
  const [wh, setWh] = useState('')
  const send = useAction(() => api.post(`/influencer-deals/${deal.id}/send-samples`, undefined, { warehouse_id: wh }), {
    success: 'Samples sent and taken out of stock', invalidate: [['/influencer-deals']], onSuccess: onClose,
  })
  return (
    <Modal open onClose={onClose} title="Send samples"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!wh} loading={send.isPending} onClick={() => send.mutate(undefined)}>Send</Button></>}>
      <p className="mb-3">{deal.samples.length} product{deal.samples.length > 1 ? 's' : ''} will be issued from stock as samples.</p>
      <Field label="From warehouse"><LookupSelect kind="warehouses" value={wh} onChange={setWh} required /></Field>
    </Modal>
  )
}
