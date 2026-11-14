import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CheckCheck, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { ago, money } from '../../lib/format'
import { useRefMap } from '../../lib/hooks'
import { Badge, Button, Confirm, Empty, ErrorNote, Loading, Segmented } from '../../ui/kit'
import { useToast } from '../../ui/toast'

type Item = { type: string; id: number; title: string; amount: string | null; requested_by_id: number | null; requested_at: string; link: string }

/** Where each kind of request is decided. */
const DECIDE: Record<string, (id: number) => string> = {
  expense: (id) => `/expenses/${id}`,
  purchase_request: (id) => `/purchase-requests/${id}`,
  purchase_order: (id) => `/purchase-orders/${id}`,
  journal_entry: (id) => `/accounting/journal/${id}`,
  partner_transaction: (id) => `/partner-transactions/${id}`,
  approval_request: (id) => `/approvals/${id}`,
}
const TYPE: Record<string, string> = {
  expense: 'Expense', purchase_request: 'Purchase request', purchase_order: 'Purchase order',
  journal_entry: 'Journal entry', partner_transaction: 'Partner transaction', approval_request: 'Discount or refund',
}

export default function Approvals() {
  const qc = useQueryClient()
  const toast = useToast()
  const userName = useRefMap('/users')
  const [type, setType] = useState('all')
  const [deciding, setDeciding] = useState<{ item: Item; verb: 'approve' | 'reject' } | null>(null)
  const [busy, setBusy] = useState(false)
  const { data, isLoading, error } = useQuery({ queryKey: ['/approvals/inbox'], queryFn: () => api.get<Item[]>('/approvals/inbox') })

  if (isLoading) return <Loading />
  if (error) return <ErrorNote error={error} />
  const items = data ?? []
  const types = [...new Set(items.map((i) => i.type))]
  const shown = type === 'all' ? items : items.filter((i) => i.type === type)

  const decide = async (note: string) => {
    if (!deciding) return
    const { item, verb } = deciding
    setBusy(true)
    try {
      await api.post(`${DECIDE[item.type](item.id)}/${verb}`, { note: note || null })
      toast(verb === 'approve' ? 'Approved' : 'Rejected')
      qc.invalidateQueries()
      setDeciding(null)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save', 'error')
    } finally {
      setBusy(false)
    }
  }

  if (!items.length)
    return (
      <div className="rounded-card bg-surface shadow-card">
        <Empty title="Nothing waiting for you" icon={<CheckCheck />}>Requests that need your decision show up here. Your own requests go to someone else.</Empty>
      </div>
    )

  return (
    <div className="flex flex-col gap-3">
      {types.length > 1 && (
        <div className="overflow-x-auto [&_button]:whitespace-nowrap">
          <Segmented value={type} onChange={setType}
            options={[{ value: 'all', label: `All ${items.length}` }, ...types.map((t) => ({ value: t, label: `${TYPE[t] ?? t} ${items.filter((i) => i.type === t).length}` }))]} />
        </div>
      )}
      <ul className="divide-y divide-line rounded-card bg-surface shadow-card">
        {shown.map((i) => (
          <li key={`${i.type}-${i.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5">
            <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge tone="brand">{TYPE[i.type] ?? i.type}</Badge>
                <Link to={i.link} className="min-w-0 text-[13.5px] font-medium text-ink hover:text-wine-800">{i.title}</Link>
              </div>
              <p className="mt-1 text-[12.5px] text-muted">
                {i.requested_by_id ? userName(i.requested_by_id) : 'System'} · {ago(i.requested_at)}
              </p>
            </div>
            {i.amount != null && <p className="tabular text-[15px] font-semibold text-ink">{money(i.amount)}</p>}
            <div className="ml-auto flex gap-2 sm:ml-0">
              <Button size="sm" icon={<X className="size-4" />} onClick={() => setDeciding({ item: i, verb: 'reject' })}>Reject</Button>
              <Button size="sm" variant="primary" icon={<Check className="size-4" />} onClick={() => setDeciding({ item: i, verb: 'approve' })}>Approve</Button>
            </div>
          </li>
        ))}
      </ul>
      <Confirm open={!!deciding} onClose={() => setDeciding(null)} loading={busy} onConfirm={decide}
        danger={deciding?.verb === 'reject'}
        title={deciding?.verb === 'approve' ? 'Approve this request?' : 'Reject this request?'}
        confirmLabel={deciding?.verb === 'approve' ? 'Approve' : 'Reject'}
        body={deciding && <p>{deciding.item.title}{deciding.item.amount != null && <> · <span className="font-medium text-ink">{money(deciding.item.amount)}</span></>}</p>}
        note={{ label: deciding?.verb === 'reject' ? 'Reason' : 'Note (optional)', required: deciding?.verb === 'reject' }} />
    </div>
  )
}
