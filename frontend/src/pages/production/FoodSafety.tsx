import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { date, label, today } from '../../lib/format'
import type { FieldDef } from '../../ui/Form'
import { Badge, Status } from '../../ui/kit'
import { ResourcePage } from '../../ui/Resource'
import { SimpleTable, TableCard } from '../reports/shared'

const KINDS = ['procedure', 'cleaning', 'inspection', 'temperature', 'pest_control', 'training', 'other']
const RESULTS = [{ value: 'ok', label: 'OK' }, { value: 'issue', label: 'Issue found' }, { value: 'n/a', label: 'Not applicable' }]

const fields: FieldDef[] = [
  { name: 'title', label: 'What was done', required: true, full: true, placeholder: 'Weekly deep clean of mixing room' },
  { name: 'kind', label: 'Kind', type: 'select', options: KINDS, required: true, createOnly: true },
  { name: 'record_date', label: 'Date', type: 'date', required: true, createOnly: true },
  { name: 'performed_by', label: 'Done by', createOnly: true },
  { name: 'area', label: 'Area', createOnly: true },
  { name: 'result', label: 'Result', type: 'select', options: RESULTS },
  { name: 'next_due_date', label: 'Next due', type: 'date', hint: 'Shows on the due list a week before' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
]

export default function FoodSafety() {
  const { data: due = [] } = useQuery({ queryKey: ['/food-safety/due'], queryFn: () => api.get<any[]>('/food-safety/due', { days: 7 }) })
  const t = today()
  return (
    <div className="flex flex-col gap-4">
      {due.length > 0 && (
        <TableCard title="Due in the next 7 days">
          <SimpleTable rows={due} cols={[
            { key: 'title', label: 'Check', render: (r: any) => <span className="font-medium">{r.title}</span> },
            { key: 'kind', label: 'Kind', render: (r: any) => label(r.kind) },
            { key: 'area', label: 'Area', render: (r: any) => r.area ?? '—' },
            { key: 'next_due_date', label: 'Due', render: (r: any) => <Badge tone={r.next_due_date < t ? 'bad' : 'warn'}>{r.next_due_date < t ? `Overdue · ${date(r.next_due_date)}` : date(r.next_due_date)}</Badge> },
          ]} />
        </TableCard>
      )}
      <ResourcePage
        path="/food-safety" feature="quality" noun="record" fields={fields}
        defaults={{ record_date: t, result: 'ok', kind: 'cleaning' }}
        empty="No food safety records yet"
        filters={[{ key: 'kind', label: 'Kind', options: KINDS }, { key: 'result', label: 'Result', options: RESULTS }]}
        columns={[
          { key: 'title', label: 'Record', className: 'font-medium' },
          { key: 'kind', label: 'Kind', render: (r: any) => label(r.kind) },
          { key: 'record_date', label: 'Date', sort: 'record_date', render: (r: any) => date(r.record_date) },
          { key: 'performed_by', label: 'By' },
          { key: 'result', label: 'Result', render: (r: any) => <Status value={r.result === 'n/a' ? null : r.result} /> },
          { key: 'next_due_date', label: 'Next due', render: (r: any) => date(r.next_due_date) },
        ]}
      />
    </div>
  )
}
