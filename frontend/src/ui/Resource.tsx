import { useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { api, ApiError } from '../lib/api'
import { useCan } from '../lib/auth'
import { useToast } from './toast'
import { DataTable, type Column, type Filter } from './DataTable'
import { FormFields, fromForm, toForm, type FieldDef, type FormValues } from './Form'
import { Badge, Button, Confirm, Drawer, ErrorNote } from './kit'

/** Drawer with a declarative form. Shows server field errors next to the right inputs. */
export function FormDrawer({ open, onClose, title, fields, initial, mode = 'create', submit, submitLabel, footerExtra, children, wide }: {
  open: boolean
  onClose: () => void
  title: ReactNode
  fields: FieldDef[]
  initial?: FormValues
  mode?: 'create' | 'edit'
  submit: (body: FormValues) => Promise<unknown>
  submitLabel?: string
  footerExtra?: ReactNode
  children?: ReactNode
  wide?: boolean
}) {
  const [values, setValues] = useState<FormValues>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    if (open) {
      setValues(toForm(fields, initial))
      setErrors({}); setError(null); setDirty(false)
    }
    // reset only when (re)opened: `initial` is often an inline object
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const close = () => {
    if (dirty && !window.confirm('Discard your changes?')) return
    onClose()
  }
  const save = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setBusy(true); setErrors({}); setError(null)
    try {
      await submit(fromForm(fields, values, mode))
      setDirty(false)
      onClose()
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setErrors(err.fields)
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Drawer open={open} onClose={close} title={title} wide={wide}
      footer={<>
        {footerExtra && <div className="mr-auto flex gap-2">{footerExtra}</div>}
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" loading={busy} onClick={() => save()}>{submitLabel ?? (mode === 'create' ? 'Create' : 'Save changes')}</Button>
      </>}>
      <form onSubmit={save} className="flex flex-col gap-5">
        {error != null && <ErrorNote error={error} />}
        <FormFields fields={fields} values={values} mode={mode} errors={errors}
          onChange={(k, v) => { setValues((s) => ({ ...s, [k]: v })); setDirty(true) }} />
        {children}
        <button type="submit" hidden />
      </form>
    </Drawer>
  )
}

export type ResourceConfig<T = any> = {
  path: string
  feature: string
  /** singular noun for buttons: "customer" */
  noun: string
  columns: Column<T>[]
  filters?: Filter[]
  fields?: FieldDef[]
  /** fields for edit if different from create */
  editFields?: FieldDef[]
  params?: Record<string, any>
  search?: string | false
  /** navigate to a record page instead of opening the edit drawer */
  rowTo?: (row: T) => string
  editMethod?: 'patch' | 'put'
  /** archive/restore endpoints exist (default: yes when the feature has an archive action) */
  archive?: boolean
  defaults?: FormValues
  exportable?: boolean
  empty?: string
  toolbar?: ReactNode
  /** extra buttons in the edit drawer footer */
  rowActions?: (row: T, close: () => void) => ReactNode
}

/** List + create/edit drawer + archive for a plain CRUD resource. */
export function ResourcePage<T extends { id: number; archived_at?: string | null }>(c: ResourceConfig<T>) {
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const [editing, setEditing] = useState<T | null>(null)
  const [creating, setCreating] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const canCreate = !!c.fields && can(c.feature, 'create')
  const canEdit = !!c.fields && can(c.feature, 'edit')
  const canArchive = c.archive !== false && can(c.feature, 'archive')
  const refresh = () => qc.invalidateQueries({ queryKey: [c.path] })

  const filters: Filter[] = [...(c.filters ?? []), ...(canArchive ? [{ key: 'include_archived', label: 'Show archived', type: 'bool' as const }] : [])]
  const columns: Column<T>[] = canArchive
    ? [...c.columns.slice(0, 1).map((col) => ({ ...col, render: (r: T) => <>{col.render ? col.render(r) : (r as any)[col.key]}{r.archived_at && <Badge className="ml-2">Archived</Badge>}</> })), ...c.columns.slice(1)]
    : c.columns

  return (
    <>
      <DataTable<T>
        path={c.path}
        params={c.params}
        columns={columns}
        filters={filters}
        search={c.search}
        rowTo={c.rowTo}
        onRowClick={c.rowTo ? undefined : canEdit || c.rowActions ? setEditing : undefined}
        exportFeature={c.exportable === false ? undefined : c.feature}
        empty={{
          title: c.empty ?? `No ${c.noun}s yet`,
          action: canCreate ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New {c.noun}</Button> : undefined,
        }}
        toolbar={<>
          {c.toolbar}
          {canCreate && <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New {c.noun}</Button>}
        </>}
      />
      {c.fields && (
        <FormDrawer open={creating} onClose={() => setCreating(false)} title={`New ${c.noun}`} fields={c.fields} initial={c.defaults}
          submit={async (body) => { await api.post(c.path, body); toast(`${cap(c.noun)} created`); refresh() }} />
      )}
      {c.fields && editing && (
        <FormDrawer open onClose={() => setEditing(null)} title={`Edit ${c.noun}`} mode="edit"
          fields={c.editFields ?? c.fields} initial={editing as any}
          submit={async (body) => {
            await (c.editMethod === 'put' ? api.put : api.patch)(`${c.path}/${editing.id}`, body)
            toast('Saved'); refresh()
          }}
          footerExtra={<>
            {canArchive && (editing.archived_at
              ? <Button variant="ghost" onClick={async () => { await api.post(`${c.path}/${editing.id}/restore`); toast('Restored'); refresh(); setEditing(null) }}>Restore</Button>
              : <Button variant="ghost" className="text-bad hover:text-bad" onClick={() => setArchiving(true)}>Archive</Button>)}
            {c.rowActions?.(editing, () => setEditing(null))}
          </>}
        />
      )}
      <Confirm open={archiving} onClose={() => setArchiving(false)} danger confirmLabel="Archive"
        title={`Archive this ${c.noun}?`} body="It will be hidden from lists and pickers. You can restore it later."
        onConfirm={async () => {
          try {
            await api.post(`${c.path}/${editing!.id}/archive`)
            toast('Archived'); refresh(); setEditing(null)
          } catch (e) { toast(e instanceof Error ? e.message : 'Could not archive', 'error') }
          setArchiving(false)
        }} />
    </>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
