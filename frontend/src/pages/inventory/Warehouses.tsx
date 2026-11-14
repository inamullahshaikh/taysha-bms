import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MapPin } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { useLookupName } from '../../lib/hooks'
import { Button, Drawer, Empty, ErrorNote, Field, Input } from '../../ui/kit'
import { ResourcePage } from '../../ui/Resource'
import type { FieldDef } from '../../ui/Form'

const fields: FieldDef[] = [
  { name: 'code', label: 'Code', required: true, createOnly: true, placeholder: 'LHR-MAIN' },
  { name: 'name', label: 'Name', required: true },
  { name: 'branch_id', label: 'Branch', type: 'lookup', lookup: 'branches' },
  { name: 'address', label: 'Address', type: 'textarea' },
]

export default function Warehouses() {
  const branch = useLookupName('branches')
  const [locs, setLocs] = useState<any>(null)
  return (
    <>
      <ResourcePage
        path="/warehouses" feature="inventory" noun="warehouse" fields={fields}
        columns={[
          { key: 'name', label: 'Warehouse', render: (w: any) => <span className="font-medium">{w.name}</span> },
          { key: 'code', label: 'Code' },
          { key: 'branch_id', label: 'Branch', render: (w: any) => (w.branch_id ? branch(w.branch_id) : '—') },
          { key: 'address', label: 'Address', render: (w: any) => <span className="text-ink-2">{w.address ?? '—'}</span> },
        ]}
        rowActions={(w, close) => <Button variant="ghost" icon={<MapPin className="size-4" />} onClick={() => { close(); setLocs(w) }}>Shelves & bins</Button>}
      />
      {locs && <Locations warehouse={locs} onClose={() => setLocs(null)} />}
    </>
  )
}

function Locations({ warehouse, onClose }: { warehouse: any; onClose: () => void }) {
  const can = useCan()
  const qc = useQueryClient()
  const path = `/stock/warehouses/${warehouse.id}/locations`
  const { data } = useQuery({ queryKey: [path], queryFn: () => api.get<any[]>(path) })
  const [form, setForm] = useState({ code: '', name: '', barcode: '' })
  const [error, setError] = useState<unknown>(null)
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null)
    try {
      await api.post(path, { code: form.code, name: form.name || null, barcode: form.barcode || null })
      setForm({ code: '', name: '', barcode: '' })
      qc.invalidateQueries({ queryKey: [path] })
    } catch (err) { setError(err) }
  }
  return (
    <Drawer open onClose={onClose} title={`Shelves & bins · ${warehouse.name}`}>
      {!data?.length ? <Empty title="No locations yet" icon={<MapPin />}>Add shelves or bins to track where stock sits.</Empty> : (
        <ul className="mb-6 divide-y divide-line rounded-lg border border-line">
          {data.map((l) => (
            <li key={l.id} className="flex items-center justify-between px-3 py-2.5 text-[13.5px]">
              <span><span className="font-medium">{l.code}</span>{l.name && <span className="text-ink-2"> · {l.name}</span>}</span>
              {l.barcode && <span className="text-[12px] text-muted">{l.barcode}</span>}
            </li>
          ))}
        </ul>
      )}
      {can('inventory', 'edit') && (
        <form onSubmit={add} className="flex flex-col gap-3 rounded-lg bg-page p-4">
          <h3 className="text-[13px] font-semibold">Add a location</h3>
          {error != null && <ErrorNote error={error} />}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Code"><Input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="A-01" /></Field>
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Dry store, top shelf" /></Field>
          </div>
          <Field label="Barcode" hint="Leave empty to use the code"><Input value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} /></Field>
          <Button type="submit" variant="primary" className="self-start">Add location</Button>
        </form>
      )}
    </Drawer>
  )
}
