import { useEffect, useState, type ReactNode } from 'react'
import { ApiError } from '../../lib/api'
import { cleanLines, FormFields, fromForm, LineItems, toForm, type FieldDef, type FormValues, type LineCol } from '../../ui/Form'
import { Button, Drawer, ErrorNote } from '../../ui/kit'
import { ScanInput } from './shared'

/** Header fields + line items in one drawer (receive, issue, transfer, requests, POs, bills). */
export function LinesDrawer({ open, onClose, title, fields, initial, columns, initialLines, submit, submitLabel = 'Save', scan, note }: {
  open: boolean
  onClose: () => void
  title: string
  fields: FieldDef[]
  initial?: FormValues
  columns: LineCol[]
  initialLines?: FormValues[]
  submit: (body: FormValues) => Promise<unknown>
  submitLabel?: string
  /** show a barcode box that adds the scanned product as a line */
  scan?: boolean
  note?: ReactNode
}) {
  const blank = () => Object.fromEntries(columns.map((c) => [c.name, '']))
  const [values, setValues] = useState<FormValues>({})
  const [lines, setLines] = useState<FormValues[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    setValues(toForm(fields, initial)); setLines(initialLines?.length ? initialLines : [blank()])
    setErrors({}); setError(null)
    // reset only when opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const save = async () => {
    setBusy(true); setErrors({}); setError(null)
    try {
      await submit({ ...fromForm(fields, values, 'create'), lines: cleanLines(lines) })
      onClose()
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fields)
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={title} wide
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>{submitLabel}</Button></>}>
      <div className="flex flex-col gap-5">
        {error != null && <ErrorNote error={error} />}
        {note}
        {fields.length > 0 && <FormFields fields={fields} values={values} errors={errors} onChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))} />}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold">Items</h3>
            {scan && (
              <ScanInput className="w-full sm:w-72" placeholder="Scan to add an item" onResult={(r) => {
                if (!('product_id' in r)) return
                const extra = r.type === 'batch' ? { batch_id: String(r.batch_id) } : r.type === 'pack' ? { unit: r.pack } : {}
                setLines((ls) => {
                  const i = ls.findIndex((l) => l.product_id === String(r.product_id) && (!('batch_id' in extra) || l.batch_id === extra.batch_id))
                  if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, quantity: String(Number(l.quantity || 0) + 1) } : l))
                  const empty = ls.findIndex((l) => !l.product_id)
                  const row = { ...blank(), product_id: String(r.product_id), quantity: '1', ...extra }
                  return empty >= 0 ? ls.map((l, j) => (j === empty ? row : l)) : [...ls, row]
                })
              }} />
            )}
          </div>
          <LineItems value={lines} onChange={setLines} columns={columns} errors={errors} newRow={blank} />
          {errors.lines && <p className="text-[12px] text-bad">{errors.lines}</p>}
        </div>
      </div>
    </Drawer>
  )
}
