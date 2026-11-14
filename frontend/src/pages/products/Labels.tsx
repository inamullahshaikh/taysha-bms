import { Printer } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ApiError, url } from '../../lib/api'
import { LineItems, PRODUCTS, type FormValues } from '../../ui/Form'
import { Button, Card, Checkbox, ErrorNote, Field, Segmented, Select } from '../../ui/kit'

type Kind = 'product' | 'batch'
const SOURCES = {
  product: PRODUCTS,
  batch: { path: '/stock/batches', label: (r: any) => `${r.number}${r.expiry_date ? ` · exp ${r.expiry_date}` : ''}`, params: { in_stock: true } },
}

export default function Labels() {
  const [sp] = useSearchParams()
  const [kind, setKind] = useState<Kind>('product')
  const [layout, setLayout] = useState('a4_3x8')
  const [showPrice, setShowPrice] = useState(true)
  const [rows, setRows] = useState<FormValues[]>([{ id: sp.get('product') ?? '', copies: '1' }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const print = async () => {
    setBusy(true); setError(null)
    const win = window.open('', '_blank')
    try {
      const res = await fetch(url('/labels'), {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, layout, show_price: showPrice, items: rows.filter((r) => r.id).map((r) => ({ id: Number(r.id), copies: Number(r.copies) || 1 })) }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new ApiError(res.status, d.code, d.message ?? 'Could not make labels', d.fields) }
      if (win) win.location.href = URL.createObjectURL(await res.blob())
    } catch (e) { win?.close(); setError(e) } finally { setBusy(false) }
  }

  return (
    <Card className="max-w-3xl">
      <div className="flex flex-col gap-5">
        {error != null && <ErrorNote error={error} />}
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Label for"><Segmented value={kind} onChange={(k) => { setKind(k); setRows([{ id: '', copies: '1' }]) }} options={[{ value: 'product', label: 'Products' }, { value: 'batch', label: 'Batches' }]} /></Field>
          <Field label="Paper" className="w-56">
            <Select value={layout} onChange={(e) => setLayout(e.target.value)} options={[{ value: 'a4_3x8', label: 'A4 sheet, 3 × 8' }, { value: 'thermal_50x25', label: 'Thermal roll, 50 × 25 mm' }]} />
          </Field>
          {kind === 'product' && <Checkbox className="pb-2" label="Show retail price" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} />}
        </div>
        <LineItems value={rows} onChange={setRows} addLabel={kind === 'product' ? 'Add product' : 'Add batch'} newRow={() => ({ id: '', copies: '1' })}
          columns={[{ name: 'id', label: kind === 'product' ? 'Product' : 'Batch', type: 'record', record: SOURCES[kind] }, { name: 'copies', label: 'Copies', type: 'number', width: '110px' }]} />
        <div className="flex justify-end">
          <Button variant="primary" icon={<Printer className="size-4" />} loading={busy} disabled={!rows.some((r) => r.id)} onClick={print}>Make labels</Button>
        </div>
      </div>
    </Card>
  )
}
