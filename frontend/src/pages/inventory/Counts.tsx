import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ClipboardList, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { dateTime, qty } from '../../lib/format'
import { productLabel, useAction, useLookupName, useRefMap } from '../../lib/hooks'
import { DataTable } from '../../ui/DataTable'
import { Badge, Button, Card, Confirm, cx, Input, Loading, Status } from '../../ui/kit'
import { FormDrawer } from '../../ui/Resource'
import { RecordHeader } from '../../ui/Record'
import { useToast } from '../../ui/toast'
import { ScanInput } from './shared'

export default function Counts() {
  const can = useCan()
  const nav = useNavigate()
  const wh = useLookupName('warehouses')
  const [open, setOpen] = useState(false)
  return (
    <>
      <DataTable
        path="/stock/counts"
        search={false}
        rowTo={(c: any) => `/stock/counts/${c.id}`}
        toolbar={can('inventory', 'create') && <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>New count</Button>}
        empty={{ title: 'No stock counts yet', body: 'Count a warehouse on a tablet, review the differences, then approve to correct the books.', icon: <ClipboardList /> }}
        columns={[
          { key: 'number', label: 'Count', render: (c: any) => <span className="font-medium">{c.number}</span> },
          { key: 'warehouse_id', label: 'Warehouse', render: (c: any) => wh(c.warehouse_id) },
          { key: 'lines', label: 'Items', align: 'right', render: (c: any) => c.lines?.length ?? '—' },
          { key: 'note', label: 'Note', render: (c: any) => <span className="text-ink-2">{c.note ?? '—'}</span> },
          { key: 'status', label: 'Status', render: (c: any) => <Status value={c.status} /> },
        ]}
      />
      <FormDrawer open={open} onClose={() => setOpen(false)} title="New stock count" submitLabel="Start count"
        fields={[
          { name: 'warehouse_id', label: 'Warehouse', type: 'lookup', lookup: 'warehouses', required: true, full: true },
          { name: 'note', label: 'Note', full: true, placeholder: 'Month-end count, shelf A…' },
        ]}
        submit={async (b) => { const c = await api.post('/stock/counts', b); nav(`/stock/counts/${c.id}`) }} />
    </>
  )
}

/** Tablet-first count screen: blind count while open, variance review once submitted. */
export function CountPage() {
  const id = Number(useParams().id)
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const wh = useLookupName('warehouses')
  const product = useRefMap('/products', productLabel)
  const batch = useRefMap('/stock/batches', (r) => r.number)
  const key = [`/stock/counts/${id}`]
  const { data: c, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get(`/stock/counts/${id}`) })
  const [counts, setCounts] = useState<Record<number, string>>({})
  const [filter, setFilter] = useState<'all' | 'todo' | 'diff'>('all')
  const [confirm, setConfirm] = useState<'approve' | 'cancel' | null>(null)
  useEffect(() => {
    if (c) setCounts(Object.fromEntries(c.lines.map((l: any) => [l.id, l.counted_quantity ?? ''])))
  }, [c])

  const dirty = useMemo(() => c?.lines.some((l: any) => String(l.counted_quantity ?? '') !== String(counts[l.id] ?? '')), [c, counts])
  const save = useAction(
    () => api.put(`/stock/counts/${id}/lines`, c.lines.filter((l: any) => counts[l.id] !== '' && counts[l.id] != null).map((l: any) => ({ line_id: l.id, counted_quantity: counts[l.id] }))),
    { success: 'Counts saved', invalidate: [key] },
  )
  const act = useAction(async (a: string) => {
    if (a === 'submit' && dirty) await api.put(`/stock/counts/${id}/lines`, c.lines.filter((l: any) => counts[l.id] !== '').map((l: any) => ({ line_id: l.id, counted_quantity: counts[l.id] })))
    return api.post(`/stock/counts/${id}/${a}`)
  }, { success: 'Count updated', invalidate: [key, ['/stock/counts']] })

  if (isLoading || !c) return <Loading />
  const open = c.status === 'open'
  const lines = c.lines.filter((l: any) =>
    filter === 'todo' ? (counts[l.id] ?? '') === '' : filter === 'diff' ? l.difference != null && Number(l.difference) !== 0 : true)
  const done = c.lines.filter((l: any) => (counts[l.id] ?? '') !== '').length
  const diffs = c.lines.filter((l: any) => l.difference != null && Number(l.difference) !== 0).length

  return (
    <>
      <RecordHeader back="/stock/counts" backLabel="Stock counts" title={c.number} status={<Status value={c.status} />}
        meta={<>{wh(c.warehouse_id)}{c.note ? ` · ${c.note}` : ''}{c.approved_at ? ` · approved ${dateTime(c.approved_at)}` : ''}</>}
        actions={<>
          {open && can('inventory', 'create') && <>
            <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button>
            <Button variant="primary" disabled={done < c.lines.length} loading={act.isPending} onClick={() => act.mutate('submit')}>Submit for review</Button>
          </>}
          {c.status === 'submitted' && can('inventory', 'approve') && <Button variant="primary" onClick={() => setConfirm('approve')}>Approve & adjust stock</Button>}
          {['open', 'submitted'].includes(c.status) && can('inventory', 'edit') && <Button variant="ghost" onClick={() => setConfirm('cancel')}>Cancel count</Button>}
        </>} />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        {open && (
          <ScanInput autoFocus className="w-full sm:w-80" placeholder="Scan an item to count it" onResult={(r) => {
            if (!('product_id' in r)) return
            const line = c.lines.find((l: any) => l.product_id === r.product_id && (r.type !== 'batch' || l.batch_id === r.batch_id))
            if (!line) return toast('That item is not on this count', 'error')
            setFilter('all')
            setTimeout(() => document.querySelector<HTMLInputElement>(`[data-line="${line.id}"]`)?.select(), 0)
          }} />
        )}
        <div className="flex gap-1.5">
          {([['all', `All ${c.lines.length}`], open ? ['todo', `To count ${c.lines.length - done}`] : ['diff', `Differences ${diffs}`]] as [typeof filter, string][]).map(([v, t]) => (
            <button key={v} type="button" onClick={() => setFilter(v)}
              className={cx('h-8 rounded-full border px-3 text-[12.5px]', filter === v ? 'border-wine-600 bg-wine-50 text-wine-800' : 'border-line text-ink-2')}>{t}</button>
          ))}
        </div>
        {open && <span className="ml-auto text-[12.5px] text-muted">{done} of {c.lines.length} counted</span>}
      </div>

      <Card pad={false}>
        <ul className="divide-y divide-line">
          {lines.map((l: any) => (
            <li key={l.id} className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14.5px] font-medium">{product(l.product_id)}</p>
                <p className="text-[12.5px] text-muted">{[l.batch_id && `Batch ${batch(l.batch_id)}`, !open && `System ${qty(l.system_quantity)}`].filter(Boolean).join(' · ')}</p>
              </div>
              {open ? (
                <Input data-line={l.id} aria-label={`Counted ${product(l.product_id)}`} type="number" inputMode="decimal" step="any"
                  className="h-11 w-32 text-right text-[16px]" value={counts[l.id] ?? ''}
                  onChange={(e) => setCounts((s) => ({ ...s, [l.id]: e.target.value }))} />
              ) : (
                <div className="flex items-center gap-3 text-right">
                  <span className="tabular text-[14px]">{qty(l.counted_quantity)}</span>
                  {l.difference != null && Number(l.difference) !== 0
                    ? <Badge tone={Number(l.difference) < 0 ? 'bad' : 'info'}>{Number(l.difference) > 0 ? '+' : ''}{qty(l.difference)}</Badge>
                    : <Badge tone="good">Matches</Badge>}
                </div>
              )}
            </li>
          ))}
          {!lines.length && <li className="px-4 py-10 text-center text-[13px] text-muted">Nothing in this view.</li>}
        </ul>
      </Card>

      <Confirm open={confirm === 'approve'} onClose={() => setConfirm(null)} title="Approve this count?" confirmLabel="Approve"
        body={`${diffs} item${diffs === 1 ? '' : 's'} will be adjusted to the counted quantity.`}
        onConfirm={() => { act.mutate('approve'); setConfirm(null); qc.invalidateQueries({ queryKey: ['/stock/balances'] }) }} />
      <Confirm open={confirm === 'cancel'} onClose={() => setConfirm(null)} danger title="Cancel this count?" confirmLabel="Cancel count"
        body="Nothing will be adjusted." onConfirm={() => { act.mutate('cancel'); setConfirm(null) }} />
    </>
  )
}
