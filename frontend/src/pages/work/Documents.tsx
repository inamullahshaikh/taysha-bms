import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, Pencil } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { date, label } from '../../lib/format'
import { useLookupName } from '../../lib/hooks'
import { CUSTOMERS, PRODUCTS, SUPPLIERS, type FieldDef } from '../../ui/Form'
import { Badge, Button, Card, ErrorNote, Facts, Loading } from '../../ui/kit'
import { Attachments, History, RecordHeader, RecordLayout } from '../../ui/Record'
import { FormDrawer, ResourcePage } from '../../ui/Resource'
import { PROJECTS } from './shared'

const CATEGORIES = ['contract', 'agreement', 'license', 'certificate', 'policy', 'procedure', 'recipe', 'design', 'invoice', 'insurance', 'legal', 'other']

function useDocFields(): FieldDef[] {
  const { can } = useAuth()
  return [
    { name: 'title', label: 'Title', required: true, full: true },
    { name: 'category', label: 'Category', type: 'select', options: CATEGORIES, required: true },
    { name: 'reference_number', label: 'Reference number' },
    { name: 'issued_by', label: 'Issued by' },
    { name: 'issue_date', label: 'Issue date', type: 'date' },
    { name: 'expiry_date', label: 'Expiry date', type: 'date' },
    { name: 'reminder_days', label: 'Remind before expiry (days)', type: 'number' },
    { name: 'tags', label: 'Tags', type: 'tags', full: true },
    { name: 'department_id', label: 'Department', type: 'lookup', lookup: 'departments' },
    { name: 'supplier_id', label: 'Supplier', type: 'record', record: SUPPLIERS },
    { name: 'customer_id', label: 'Customer', type: 'record', record: CUSTOMERS },
    { name: 'product_id', label: 'Product', type: 'record', record: PRODUCTS },
    { name: 'project_id', label: 'Project', type: 'record', record: PROJECTS },
    ...(can('confidential_documents') ? [{ name: 'confidential', label: 'Confidential (only people with confidential access can see it)', type: 'bool', full: true } as FieldDef] : []),
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ]
}

function Expiry({ r }: { r: any }) {
  if (!r.expiry_date) return <span className="text-muted">—</span>
  const d = r.expires_in_days
  return (
    <span className="flex items-center gap-2">
      <span className="tabular">{date(r.expiry_date)}</span>
      {d != null && d < 0 && <Badge tone="bad">Expired</Badge>}
      {d != null && d >= 0 && d <= 30 && <Badge tone="warn">{d === 0 ? 'Today' : `${d}d left`}</Badge>}
    </span>
  )
}

export default function Documents() {
  const fields = useDocFields()
  return (
    <ResourcePage
      path="/document-records" feature="documents" noun="document" fields={fields} rowTo={(r: any) => `/document-records/${r.id}`}
      defaults={{ category: 'contract', reminder_days: 30 }} exportable={false} search="Search title, reference or tag"
      filters={[
        { key: 'category', label: 'Category', options: CATEGORIES },
        { key: 'expiring_within_days', label: 'Expiry', options: [{ value: 30, label: 'Expiring in 30 days' }, { value: 90, label: 'Expiring in 90 days' }] },
        { key: 'expired', label: 'Expired', type: 'bool' },
      ]}
      columns={[
        { key: 'title', label: 'Document', render: (r: any) => <span className="flex items-center gap-1.5 font-medium">{r.confidential && <Lock className="size-3.5 text-wine-600" aria-label="Confidential" />}{r.title}</span> },
        { key: 'category', label: 'Category', render: (r: any) => label(r.category) },
        { key: 'tags', label: 'Tags', render: (r: any) => <span className="flex flex-wrap gap-1">{(r.tags ?? []).slice(0, 3).map((t: string) => <Badge key={t}>{t}</Badge>)}</span> },
        { key: 'file_count', label: 'Files', align: 'right' },
        { key: 'expiry_date', label: 'Expires', render: (r: any) => <Expiry r={r} /> },
      ]}
    />
  )
}

export function DocumentPage() {
  const id = Number(useParams().id)
  const { can } = useAuth()
  const qc = useQueryClient()
  const fields = useDocFields()
  const dept = useLookupName('departments')
  const [editing, setEditing] = useState(false)
  const key = [`/document-records/${id}`]
  const { data: d, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/document-records/${id}`) })
  if (isLoading) return <Loading />
  if (error || !d) return <ErrorNote error={error} />
  return (
    <>
      <RecordHeader back="/document-records" backLabel="Documents" title={d.title}
        status={<>{d.confidential && <Badge tone="brand"><Lock className="size-3" />Confidential</Badge>}{d.expires_in_days != null && d.expires_in_days < 0 && <Badge tone="bad">Expired</Badge>}</>}
        meta={`${label(d.category)}${d.reference_number ? ` · ${d.reference_number}` : ''}`}
        actions={can('documents', 'edit') && <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>} />
      <RecordLayout
        main={<>
          <Attachments entity="document_records" id={id} canEdit={can('documents', 'edit')} />
          {d.notes && <Card title="Notes"><p className="text-[13.5px] whitespace-pre-wrap">{d.notes}</p></Card>}
        </>}
        side={<>
          <Card title="About">
            <Facts cols={1} items={[
              ['Issued by', d.issued_by ?? '—'],
              ['Issue date', date(d.issue_date)],
              ['Expires', <Expiry r={d} />],
              ['Reminder', d.expiry_date ? `${d.reminder_days} days before` : '—'],
              ['Department', d.department_id ? dept(d.department_id) : '—'],
              ['Tags', d.tags?.length ? <span className="flex flex-wrap gap-1">{d.tags.map((t: string) => <Badge key={t}>{t}</Badge>)}</span> : '—'],
            ]} />
          </Card>
          <History entity="document_records" id={id} />
        </>}
      />
      <FormDrawer open={editing} onClose={() => setEditing(false)} title="Edit document" mode="edit" fields={fields} initial={d}
        submit={async (body) => { await api.patch(`/document-records/${id}`, body); qc.invalidateQueries({ queryKey: key }) }} />
    </>
  )
}
