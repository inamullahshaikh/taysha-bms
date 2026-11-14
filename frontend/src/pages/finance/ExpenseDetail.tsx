import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, X } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { date, dateTime, label, money } from '../../lib/format'
import { useAction, useApprovals, useLookupName, useRefMap } from '../../lib/hooks'
import { Button, Card, Confirm, ErrorNote, Facts, Loading, Status } from '../../ui/kit'
import { Attachments, History, RecordHeader, RecordLayout } from '../../ui/Record'
import { FormDrawer } from '../../ui/Resource'
import { EXPENSE_FIELDS } from './Expenses'

export default function ExpenseDetail() {
  const id = Number(useParams().id)
  const { user, can } = useAuth()
  const key = `/expenses/${id}`
  const qc = useQueryClient()
  const { data: e, error } = useQuery({ queryKey: [key], queryFn: () => api.get(key) })
  const [ask, setAsk] = useState<'approve' | 'reject' | 'cancel' | null>(null)
  const [editing, setEditing] = useState(false)
  const category = useLookupName('expense_categories')
  const centre = useLookupName('cost_centres')
  const dept = useLookupName('departments')
  const branch = useLookupName('branches')
  const userName = useRefMap('/users')
  const approvals = useApprovals()
  const act = useAction((a: { kind: string; note?: string }) => api.post(`${key}/${a.kind}`, a.kind === 'cancel' ? undefined : { note: a.note || null }),
    { success: 'Done', invalidate: [[key], ['/expenses']], onSuccess: () => setAsk(null) })

  if (error) return <ErrorNote error={error} />
  if (!e) return <Loading />
  const open = e.status === 'submitted'
  const own = e.created_by_id === user.id
  const canDecide = open && (!own || !approvals) && can('expenses', 'approve')
  const canEdit = open && (own || can('expenses', 'edit'))

  return (
    <>
      <RecordHeader back="/expenses" backLabel="Expenses" title={e.number} status={<Status value={e.status} />}
        meta={`${money(e.amount)} · ${category(e.category_id)} · ${date(e.expense_date)}`}
        actions={<>
          {canEdit && <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>}
          {open && own && <Button variant="ghost" onClick={() => setAsk('cancel')}>Withdraw</Button>}
          {canDecide && <Button icon={<X className="size-4" />} onClick={() => setAsk('reject')}>Reject</Button>}
          {canDecide && <Button variant="primary" icon={<Check className="size-4" />} onClick={() => setAsk('approve')}>Approve</Button>}
        </>} />
      <RecordLayout
        main={<>
          <Card title="Details">
            <Facts items={[
              ['Description', e.description],
              ['Amount', money(e.amount, { paisa: true })],
              ['Tax included', money(e.tax_amount, { paisa: true })],
              ['Paid to', e.payee],
              ['Paid by', label(e.payment_method)],
              ['Reference', e.reference],
              ['Cost centre', e.cost_centre_id ? centre(e.cost_centre_id) : null],
              ['Department', e.department_id ? dept(e.department_id) : null],
              ['Branch', e.branch_id ? branch(e.branch_id) : null],
              ['Submitted by', `${userName(e.created_by_id)} · ${dateTime(e.created_at)}`],
            ]} />
          </Card>
          {e.decided_at && (
            <Card title={e.status === 'cancelled' ? 'Withdrawn' : 'Decision'}>
              <Facts items={[['By', userName(e.decided_by_id)], ['When', dateTime(e.decided_at)], ['Note', e.decision_note]]} />
            </Card>
          )}
          {own && open && approvals && !can('expenses', 'approve') && <p className="text-[13px] text-ink-2">Waiting for a manager to approve. Nobody can approve their own expense.</p>}
        </>}
        side={<>
          <Attachments entity="expenses" id={id} canEdit={canEdit} />
          <History entity="expenses" id={id} />
        </>}
      />
      <FormDrawer open={editing} onClose={() => setEditing(false)} title={`Edit ${e.number}`} mode="edit" fields={EXPENSE_FIELDS} initial={e}
        submit={async (body) => { await api.put(key, { ...e, ...body }); qc.invalidateQueries({ queryKey: [key] }) }} />
      <Confirm open={ask === 'approve'} onClose={() => setAsk(null)} title={`Approve ${money(e.amount)}?`} confirmLabel="Approve"
        note={{ label: 'Note (optional)' }} loading={act.isPending} onConfirm={(note) => act.mutate({ kind: 'approve', note })} />
      <Confirm open={ask === 'reject'} onClose={() => setAsk(null)} title="Reject this expense?" confirmLabel="Reject" danger
        note={{ label: 'Reason', required: true }} loading={act.isPending} onConfirm={(note) => act.mutate({ kind: 'reject', note })} />
      <Confirm open={ask === 'cancel'} onClose={() => setAsk(null)} title="Withdraw this expense?" confirmLabel="Withdraw" danger
        body="It will be marked cancelled and leave the approval queue." loading={act.isPending} onConfirm={() => act.mutate({ kind: 'cancel' })} />
    </>
  )
}
