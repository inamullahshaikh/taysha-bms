import { useQuery } from '@tanstack/react-query'
import { Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, asPage } from '../lib/api'
import { productLabel, useLookups, type Lookups } from '../lib/hooks'
import { Checkbox, cx, Field, IconButton, Input, Select, Textarea, Button } from './kit'

export type FieldDef = {
  name: string
  label: string
  type?: 'text' | 'email' | 'number' | 'money' | 'date' | 'datetime' | 'textarea' | 'select' | 'bool' | 'lookup' | 'record' | 'tags' | 'password'
  options?: (string | { value: string | number; label: string })[]
  lookup?: keyof Lookups
  record?: RecordSource
  required?: boolean
  /** span the full width of the 2-column form grid */
  full?: boolean
  hint?: string
  placeholder?: string
  /** only on create (e.g. immutable codes) */
  createOnly?: boolean
  /** only on edit */
  editOnly?: boolean
  show?: (values: FormValues) => boolean
}

export type FormValues = Record<string, any>
export type RecordSource = { path: string; label?: (r: any) => string; params?: Record<string, any> }

export const PRODUCTS: RecordSource = { path: '/products', label: productLabel }
export const CUSTOMERS: RecordSource = { path: '/customers', label: (r) => (r.phone ? `${r.name} · ${r.phone}` : r.name) }
export const SUPPLIERS: RecordSource = { path: '/suppliers' }
export const USERS: RecordSource = { path: '/users', label: (r) => r.name }

/** API record → editable string values. */
export function toForm(fields: FieldDef[], rec: FormValues = {}): FormValues {
  const out: FormValues = {}
  for (const f of fields) {
    const v = rec[f.name]
    if (f.type === 'bool') out[f.name] = !!v
    else if (f.type === 'tags') out[f.name] = Array.isArray(v) ? v.join(', ') : ''
    else if (f.type === 'datetime') out[f.name] = v ? String(v).slice(0, 16) : ''
    else out[f.name] = v ?? ''
  }
  return out
}

/** Editable values → API body. Empty means "not given" on create and "clear it" on edit. */
export function fromForm(fields: FieldDef[], values: FormValues, mode: 'create' | 'edit'): FormValues {
  const out: FormValues = {}
  for (const f of fields) {
    if ((mode === 'edit' && f.createOnly) || (mode === 'create' && f.editOnly)) continue
    if (f.show && !f.show(values)) continue
    const v = values[f.name]
    if (f.type === 'bool') out[f.name] = !!v
    else if (f.type === 'tags') out[f.name] = String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (v === '' || v === undefined || v === null) {
      if (mode === 'edit') out[f.name] = null
    } else if (f.type === 'lookup' || f.type === 'record') out[f.name] = Number(v)
    else if (f.type === 'number' && /^\d+$/.test(String(v)) && !String(v).includes('.')) out[f.name] = Number(v)
    else out[f.name] = v
  }
  return out
}

export function FormFields({ fields, values, onChange, errors = {}, mode = 'create' }: {
  fields: FieldDef[]; values: FormValues; onChange: (name: string, v: any) => void
  errors?: Record<string, string>; mode?: 'create' | 'edit'
}) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
      {fields
        .filter((f) => !(mode === 'edit' && f.createOnly) && !(mode === 'create' && f.editOnly) && (!f.show || f.show(values)))
        .map((f) => (
          <FieldInput key={f.name} f={f} value={values[f.name]} onChange={(v) => onChange(f.name, v)} error={errors[f.name]} />
        ))}
    </div>
  )
}

function FieldInput({ f, value, onChange, error }: { f: FieldDef; value: any; onChange: (v: any) => void; error?: string }) {
  const id = `f-${f.name}`
  const full = f.full || f.type === 'textarea'
  const common = { id, 'aria-invalid': !!error || undefined, required: f.required, placeholder: f.placeholder }
  let input: ReactNode
  switch (f.type) {
    case 'textarea':
      input = <Textarea {...common} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      break
    case 'select':
      input = <Select {...common} value={value ?? ''} onChange={(e) => onChange(e.target.value)} options={f.options ?? []} placeholder={f.required ? 'Choose…' : '—'} />
      break
    case 'lookup':
      input = <LookupSelect {...common} kind={f.lookup!} value={value} onChange={onChange} />
      break
    case 'record':
      input = <RecordSelect id={id} source={f.record!} value={value} onChange={onChange} invalid={!!error} />
      break
    case 'bool':
      return (
        <div className={cx('flex items-end pb-2', full && 'sm:col-span-2')}>
          <Checkbox label={f.label} checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        </div>
      )
    case 'money':
    case 'number':
      input = <Input {...common} type="number" step="any" inputMode="decimal" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      break
    case 'date':
      input = <Input {...common} type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      break
    case 'datetime':
      input = <Input {...common} type="datetime-local" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      break
    default:
      input = <Input {...common} type={f.type === 'email' ? 'email' : f.type === 'password' ? 'password' : 'text'} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
  }
  return (
    <Field label={<>{f.label}{f.required && <span className="text-wine-600"> *</span>}</>} htmlFor={id} error={error}
      hint={f.hint ?? (f.type === 'tags' ? 'Separate with commas' : f.type === 'money' ? 'PKR' : undefined)} className={full ? 'sm:col-span-2' : ''}>
      {input}
    </Field>
  )
}

export function LookupSelect({ kind, value, onChange, placeholder, ...p }: {
  kind: keyof Lookups; value: any; onChange: (v: string) => void; placeholder?: string; id?: string; required?: boolean
}) {
  const { data } = useLookups()
  return (
    <Select {...p} value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? (p.required ? 'Choose…' : '—')}
      options={(data?.[kind] ?? []).map((r) => ({ value: r.id, label: r.code && r.name ? `${r.name}` : (r.name ?? r.code ?? `#${r.id}`) }))} />
  )
}

/** Searchable picker over any list endpoint that supports ?q=. */
export function RecordSelect({ source, value, onChange, id, invalid, placeholder = 'Search…', autoFocus }: {
  source: RecordSource; value: any; onChange: (id: string, row?: any) => void; id?: string; invalid?: boolean
  placeholder?: string; autoFocus?: boolean
}) {
  const toLabel = source.label ?? ((r: any) => r.name ?? r.number ?? `#${r.id}`)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const results = useQuery({
    queryKey: ['pick', source.path, q, source.params],
    queryFn: async () => asPage(await api.get(source.path, { ...source.params, q, page_size: 20 })).items,
    enabled: open,
  })
  const selected = useQuery({
    queryKey: [`${source.path}/${value}`],
    queryFn: () => api.get(`${source.path}/${value}`),
    enabled: !!value,
    staleTime: 60_000,
  })
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const items = results.data ?? []
  const pick = (r: any) => { onChange(String(r.id), r); setOpen(false); setQ('') }
  const shown = open ? q : value ? (selected.data ? toLabel(selected.data) : '…') : ''

  return (
    <div ref={ref} className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
      <Input id={id} aria-invalid={invalid || undefined} autoFocus={autoFocus} autoComplete="off" role="combobox" aria-expanded={open}
        className="pl-8" placeholder={placeholder} value={shown}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, items.length - 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
          if (e.key === 'Enter' && open && items[hi]) { e.preventDefault(); pick(items[hi]) }
          if (e.key === 'Escape') setOpen(false)
        }} />
      {open && (
        <ul role="listbox" className="scroll-quiet anim-rise absolute top-full z-40 mt-1 max-h-64 w-full overflow-y-auto rounded-lg bg-surface p-1 shadow-pop">
          {results.isLoading && <li className="px-2.5 py-2 text-[13px] text-muted">Searching…</li>}
          {!results.isLoading && items.length === 0 && <li className="px-2.5 py-2 text-[13px] text-muted">No matches</li>}
          {value && !q && (
            <li><button type="button" className="w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-muted hover:bg-sunken" onClick={() => { onChange(''); setOpen(false) }}>Clear selection</button></li>
          )}
          {items.map((r: any, i: number) => (
            <li key={r.id} role="option" aria-selected={i === hi}>
              <button type="button" onMouseEnter={() => setHi(i)} onClick={() => pick(r)}
                className={cx('w-full truncate rounded-md px-2.5 py-1.5 text-left text-[13px]', i === hi ? 'bg-wine-50 text-wine-800' : 'text-ink')}>
                {toLabel(r)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ---------- Line items ---------- */

export type LineCol = {
  name: string
  label: string
  type?: 'product' | 'number' | 'money' | 'text' | 'select' | 'record'
  options?: (string | { value: string | number; label: string })[]
  record?: RecordSource
  width?: string
  placeholder?: string
}

/** Editable rows for orders, invoices, POs, recipes, transfers… Totals always come from the server. */
export function LineItems({ value, onChange, columns, newRow, errors, addLabel = 'Add line' }: {
  value: FormValues[]; onChange: (rows: FormValues[]) => void; columns: LineCol[]
  newRow?: () => FormValues; errors?: Record<string, string>; addLabel?: string
}) {
  const set = (i: number, k: string, v: any) => onChange(value.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
  const blank = newRow ?? (() => Object.fromEntries(columns.map((c) => [c.name, ''])))
  return (
    <div className="rounded-lg border border-line">
      <div className="scroll-quiet overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line bg-page text-left text-[12px] text-muted">
              {columns.map((c) => <th key={c.name} className="px-2 py-2 font-medium first:pl-3" style={{ width: c.width }}>{c.label}</th>)}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {value.map((row, i) => (
              <tr key={i} className="border-b border-line last:border-0 align-top">
                {columns.map((c) => {
                  const err = errors?.[`lines.${i}.${c.name}`]
                  return (
                    <td key={c.name} className="px-1.5 py-1.5 first:pl-2" style={{ minWidth: c.type === 'product' || c.type === 'record' ? 240 : 90 }}>
                      {c.type === 'product' || c.type === 'record' ? (
                        <RecordSelect source={c.record ?? PRODUCTS} value={row[c.name]} invalid={!!err} onChange={(v, r) => onChange(value.map((x, j) => (j === i ? { ...x, [c.name]: v, _row: r } : x)))} />
                      ) : c.type === 'select' ? (
                        <Select value={row[c.name] ?? ''} options={c.options ?? []} onChange={(e) => set(i, c.name, e.target.value)} />
                      ) : (
                        <Input aria-label={c.label} aria-invalid={!!err || undefined} placeholder={c.placeholder}
                          type={c.type === 'text' ? 'text' : 'number'} step="any" inputMode={c.type === 'text' ? undefined : 'decimal'}
                          value={row[c.name] ?? ''} onChange={(e) => set(i, c.name, e.target.value)} />
                      )}
                      {err && <p className="mt-1 text-[11.5px] text-bad">{err}</p>}
                    </td>
                  )
                })}
                <td className="py-1.5 pr-1.5 text-right">
                  <IconButton label="Remove line" onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 className="size-4" /></IconButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-line p-1.5">
        <Button variant="ghost" size="sm" icon={<Plus className="size-4" />} onClick={() => onChange([...value, blank()])}>{addLabel}</Button>
      </div>
    </div>
  )
}

/** Strip UI-only keys and empty optional numbers from line rows before sending. */
export function cleanLines(rows: FormValues[]) {
  return rows
    .filter((r) => Object.entries(r).some(([k, v]) => !k.startsWith('_') && v !== '' && v != null))
    .map((r) => {
      const o: FormValues = {}
      for (const [k, v] of Object.entries(r)) {
        if (k.startsWith('_') || v === '' || v == null) continue
        o[k] = k.endsWith('_id') ? Number(v) : v
      }
      return o
    })
}
