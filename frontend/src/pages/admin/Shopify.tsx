import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { ago, dateTime, label } from '../../lib/format'
import { useAction, useUrlState } from '../../lib/hooks'
import { DataTable } from '../../ui/DataTable'
import { FormFields, PRODUCTS, RecordSelect, toForm, type FieldDef, type FormValues } from '../../ui/Form'
import { Badge, Button, Card, Empty, ErrorNote, Loading, Segmented, Status } from '../../ui/kit'
import { useToast } from '../../ui/toast'

const fields: FieldDef[] = [
  { name: 'enabled', label: 'Connected (orders come in, stock goes out)', type: 'bool', full: true },
  { name: 'shop_domain', label: 'Store domain', placeholder: 'taysha.myshopify.com' },
  { name: 'location_id', label: 'Shopify location ID', hint: 'Where stock levels are pushed' },
  { name: 'access_token', label: 'Admin API access token', type: 'password' },
  { name: 'webhook_secret', label: 'Webhook signing secret', type: 'password' },
  { name: 'warehouse_id', label: 'Stock comes from warehouse', type: 'lookup', lookup: 'warehouses' },
  { name: 'sync_stock', label: 'Push available stock to Shopify', type: 'bool' },
]

export default function Shopify() {
  const [view, setView] = useUrlState('view', 'connection')
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <Segmented value={view} onChange={setView} options={[
          { value: 'connection', label: 'Connection' }, { value: 'mapping', label: 'Product mapping' },
          { value: 'log', label: 'Sync log' }, { value: 'reconcile', label: 'Reconciliation' },
        ]} />
      </div>
      {view === 'mapping' ? <Mapping /> : view === 'log' ? <SyncLog /> : view === 'reconcile' ? <Reconcile /> : <Connection />}
    </div>
  )
}

function Connection() {
  const { can } = useAuth()
  const toast = useToast()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: ['/integrations/shopify/config'], queryFn: () => api.get('/integrations/shopify/config') })
  const [values, setValues] = useState<FormValues | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const pull = useAction(() => api.post('/integrations/shopify/pull-products'), {
    invalidate: [['/integrations/shopify/variants']],
    onSuccess: (r: any) => toast(`${r.variants} variants found, ${r.newly_mapped} matched by SKU`),
  })
  if (isLoading) return <Loading />
  if (error) return <ErrorNote error={error} />
  const editable = can('settings', 'edit')
  const v = values ?? { ...toForm(fields, data), access_token: '', webhook_secret: '' }
  const webhook = `${window.location.origin}${data.webhook_url}`

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setErrors({})
    const body: FormValues = {
      enabled: !!v.enabled, sync_stock: !!v.sync_stock, shop_domain: v.shop_domain || null, location_id: v.location_id || null,
      warehouse_id: v.warehouse_id ? Number(v.warehouse_id) : null,
    }
    // secrets are write-only: only send what was typed
    if (v.access_token) body.access_token = v.access_token
    if (v.webhook_secret) body.webhook_secret = v.webhook_secret
    try {
      await api.put('/integrations/shopify/config', body)
      toast('Shopify settings saved'); setValues(null)
      qc.invalidateQueries({ queryKey: ['/integrations/shopify/config'] })
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fields)
      toast(err instanceof Error ? err.message : 'Could not save', 'error')
    } finally { setBusy(false) }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Card title="Store connection" action={<Status value={data.enabled ? 'connected' : 'off'} tone={data.enabled ? 'good' : 'neutral'} />}>
        <form onSubmit={save}>
          <fieldset disabled={!editable}>
            <FormFields fields={fields.map((f) => f.type === 'password' && data[`has_${f.name}`] ? { ...f, placeholder: 'Saved. Leave blank to keep it.' } : f)}
              values={v} errors={errors} mode="edit" onChange={(k, x) => setValues({ ...v, [k]: x })} />
          </fieldset>
          {editable && (
            <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
              <Button disabled={!values} onClick={() => setValues(null)}>Discard</Button>
              <Button type="submit" variant="primary" disabled={!values} loading={busy}>Save</Button>
            </div>
          )}
        </form>
      </Card>
      <div className="flex flex-col gap-4">
        <Card title="Webhook">
          <p className="text-[12.5px] text-ink-2">In Shopify admin, add webhooks for orders and refunds pointing here:</p>
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-sunken px-3 py-2">
            <code className="min-w-0 flex-1 truncate text-[12px]">{webhook}</code>
            <Button size="sm" variant="ghost" aria-label="Copy webhook address" icon={<Copy className="size-3.5" />}
              onClick={() => { navigator.clipboard?.writeText(webhook); toast('Copied') }} />
          </div>
          <p className="mt-3 text-[12.5px] text-muted">Last order sync: {data.last_order_sync_at ? ago(data.last_order_sync_at) : 'never'}</p>
        </Card>
        {editable && (
          <Card title="Products">
            <p className="text-[12.5px] text-ink-2">Fetch Shopify's products and match their variants to ours by SKU. Anything unmatched shows under Product mapping.</p>
            <Button className="mt-3" icon={<RefreshCw className="size-4" />} loading={pull.isPending} onClick={() => pull.mutate(undefined)}>Pull products</Button>
          </Card>
        )}
      </div>
    </div>
  )
}

function Mapping() {
  const { can } = useAuth()
  const [unmapped, setUnmapped] = useUrlState('unmapped', '1')
  const key = ['/integrations/shopify/variants', unmapped]
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<any[]>('/integrations/shopify/variants', { unmapped_only: !!unmapped }) })
  const map = useAction(({ id, product_id }: { id: string; product_id: number | null }) =>
    api.put(`/integrations/shopify/variants/${id}`, { product_id }), { success: 'Mapping saved', invalidate: [['/integrations/shopify/variants']] })
  const editable = can('settings', 'edit')
  return (
    <Card title="Shopify variants" pad={false}
      action={<Segmented value={unmapped ? 'u' : 'all'} onChange={(x) => setUnmapped(x === 'u' ? '1' : '')} options={[{ value: 'u', label: 'Unmapped' }, { value: 'all', label: 'All' }]} />}>
      {isLoading ? <Loading /> : !data?.length ? (
        <Empty title={unmapped ? 'Every variant is mapped' : 'No Shopify variants yet'}>{unmapped ? 'New Shopify products show up here after you pull products.' : 'Connect the store, then pull products.'}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead><tr className="border-b border-line text-left text-[12px] text-muted">
              <th className="px-4 py-2 font-medium">Shopify variant</th><th className="py-2 font-medium">SKU</th><th className="py-2 font-medium">Last pushed</th><th className="w-80 px-4 py-2 font-medium">Our product</th>
            </tr></thead>
            <tbody>
              {data.map((v) => (
                <tr key={v.variant_id} className={v.product_id ? 'border-b border-line' : 'border-b border-line bg-warn-bg/40'}>
                  <td className="px-4 py-2 font-medium">{v.title}</td>
                  <td className="py-2 font-mono text-[12px] text-ink-2">{v.sku ?? '—'}</td>
                  <td className="tabular py-2 text-ink-2">{v.last_pushed_qty ?? '—'}</td>
                  <td className="px-4 py-1.5">
                    {editable ? <RecordSelect source={PRODUCTS} value={v.product_id ?? ''} placeholder="Choose a product…"
                      onChange={(id) => map.mutate({ id: v.variant_id, product_id: id ? Number(id) : null })} />
                      : v.product_id ? <Link className="text-wine-700 hover:underline" to={`/products/${v.product_id}`}>Product #{v.product_id}</Link> : <Badge tone="warn">Not mapped</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function SyncLog() {
  const { can } = useAuth()
  const retry = useAction((id: number) => api.post(`/integrations/sync-log/${id}/retry`), { success: 'Retried', invalidate: [['/integrations/sync-log']] })
  return (
    <DataTable path="/integrations/sync-log" search={false}
      filters={[
        { key: 'status', label: 'Status', options: ['ok', 'error', 'skipped'] },
        { key: 'kind', label: 'Kind', options: ['order', 'refund', 'cancel', 'fulfillment', 'stock', 'products'] },
        { key: 'unresolved_errors', label: 'Unresolved errors', type: 'bool' },
      ]}
      empty={{ title: 'Nothing synced yet' }}
      columns={[
        { key: 'at', label: 'When', render: (r: any) => <span title={dateTime(r.at)}>{ago(r.at)}</span> },
        { key: 'direction', label: 'Direction', render: (r: any) => (r.direction === 'in' ? 'From Shopify' : 'To Shopify') },
        { key: 'kind', label: 'Kind', render: (r: any) => label(r.kind) },
        { key: 'external_id', label: 'Shopify ID', render: (r: any) => <span className="font-mono text-[12px]">{r.external_id ?? '—'}</span> },
        { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} tone={r.status === 'ok' ? 'good' : r.status === 'error' ? (r.resolved ? 'neutral' : 'bad') : 'neutral'} /> },
        { key: 'message', label: 'Message', className: 'max-w-sm truncate text-ink-2', render: (r: any) => <span title={r.message ?? ''}>{r.message ?? '—'}</span> },
        { key: 'retry', label: '', render: (r: any) => r.status === 'error' && !r.resolved && can('settings', 'edit') && (
          <Button size="sm" loading={retry.isPending && retry.variables === r.id} onClick={(e) => { e.stopPropagation(); retry.mutate(r.id) }}>Retry</Button>
        ) },
      ]} />
  )
}

function Reconcile() {
  const { data, isLoading, error } = useQuery({ queryKey: ['/integrations/shopify/reconciliation'], queryFn: () => api.get<any[]>('/integrations/shopify/reconciliation'), retry: false })
  if (isLoading) return <Loading />
  if (error) return <ErrorNote error={error} />
  return (
    <Card title="Orders that don't match Shopify" pad={false}>
      {!data?.length ? <Empty title="Everything matches">Shopify totals and payment status agree with ours.</Empty> : (
        <ul className="divide-y divide-line">
          {data.map((r) => (
            <li key={r.order_id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
              <Link to={`/orders/${r.order_id}`} className="font-medium text-wine-700 hover:underline">{r.number}</Link>
              <span className="text-muted">Shopify {r.shopify ?? '—'}</span>
              <span className="flex flex-wrap gap-1.5">{r.issues.map((i: string) => <Badge key={i} tone="warn">{i}</Badge>)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
