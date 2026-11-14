import { Send } from 'lucide-react'
import { api } from '../../lib/api'
import { ago, date, label } from '../../lib/format'
import { useCan } from '../../lib/auth'
import { Button, Status } from '../../ui/kit'
import type { FieldDef } from '../../ui/Form'
import { ResourcePage } from '../../ui/Resource'
import { useToast } from '../../ui/toast'

const REPORTS = ['sales', 'expenses', 'profit_loss', 'receivables_aging', 'slow_moving']

const fields: FieldDef[] = [
  { name: 'name', label: 'Name', required: true, full: true, placeholder: 'Weekly sales for the partners' },
  { name: 'report', label: 'Report', type: 'select', options: REPORTS, required: true, createOnly: true },
  { name: 'frequency', label: 'Send', type: 'select', options: ['daily', 'weekly', 'monthly'], required: true },
  { name: 'next_run', label: 'Next send', type: 'date', required: true },
  { name: 'recipients', label: 'Email to', type: 'tags', required: true, full: true },
  { name: 'active', label: 'Active', type: 'bool' },
]

export default function Scheduled() {
  const toast = useToast()
  const can = useCan()
  return (
    <ResourcePage
      path="/scheduled-reports" feature="reports" noun="scheduled report" fields={fields}
      defaults={{ frequency: 'weekly', active: true, report: 'sales' }}
      empty="No reports are emailed yet"
      columns={[
        { key: 'name', label: 'Name', className: 'font-medium' },
        { key: 'report', label: 'Report', render: (r: any) => label(r.report) },
        { key: 'frequency', label: 'Every', render: (r: any) => label(r.frequency) },
        { key: 'recipients', label: 'To', render: (r: any) => <span className="text-ink-2">{r.recipients.join(', ')}</span> },
        { key: 'next_run', label: 'Next', render: (r: any) => date(r.next_run) },
        { key: 'last_sent_at', label: 'Last sent', render: (r: any) => ago(r.last_sent_at) },
        { key: 'active', label: 'Status', render: (r: any) => <Status value={r.active ? 'active' : 'paused'} /> },
      ]}
      rowActions={(r: any, close) => can('reports', 'edit') && (
        <Button variant="ghost" icon={<Send className="size-4" />} onClick={async () => {
          try {
            const res = await api.post(`/scheduled-reports/${r.id}/send-now`)
            toast(`Sent to ${res.sent_to.join(', ')}`)
            close()
          } catch (e) { toast(e instanceof Error ? e.message : 'Could not send', 'error') }
        }}>Send now</Button>
      )}
    />
  )
}
