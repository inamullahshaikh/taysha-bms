import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { date, money, pct } from '../../lib/format'
import { useLookupName } from '../../lib/hooks'
import { ChartCard, SegmentBar, TrendChart } from '../../ui/charts'
import { Button, Card, Empty, Field, Input, Loading } from '../../ui/kit'
import { FormDrawer } from '../../ui/Resource'
import { useToast } from '../../ui/toast'

const th = 'px-4 py-2 text-[12px] font-medium text-muted'

/** Selling prices per price list (tax-inclusive), with effective dates. */
export function Pricing({ id }: { id: number }) {
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const list = useLookupName('price_lists')
  const [add, setAdd] = useState<any>(null)
  const { data, isLoading } = useQuery({ queryKey: [`/products/${id}/prices`], queryFn: () => api.get(`/products/${id}/prices`) })
  if (isLoading) return <Loading />
  const edit = can('product_prices', 'edit')
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title="Current prices" pad={false} action={edit && <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdd({})}>New price</Button>}>
        <table className="w-full text-[13.5px]">
          <thead><tr className="border-b border-line text-left"><th className={th}>Price list</th><th className={`${th} text-right`}>Price</th><th className={th}>Since</th></tr></thead>
          <tbody>{data.current.map((c: any) => (
            <tr key={c.price_list_id} onClick={edit ? () => setAdd({ price_list_id: c.price_list_id, price: c.price }) : undefined}
              className={`border-b border-line last:border-0 ${edit ? 'cursor-pointer hover:bg-wine-50/60' : ''}`}>
              <td className="px-4 py-2.5">{c.name}</td>
              <td className="tabular px-4 text-right font-medium">{c.price == null ? <span className="font-normal text-muted">Not set</span> : money(c.price, { paisa: true })}</td>
              <td className="px-4 text-ink-2">{date(c.effective_from)}</td>
            </tr>
          ))}</tbody>
        </table>
        <p className="border-t border-line px-4 py-2.5 text-[12px] text-muted">Prices include tax.</p>
      </Card>
      <Card title="Price history" pad={false}>
        {!data.history.length ? <Empty title="No price changes yet" /> : (
          <table className="w-full text-[13.5px]">
            <thead><tr className="border-b border-line text-left"><th className={th}>From</th><th className={th}>List</th><th className={`${th} text-right`}>Price</th><th className={th}>Note</th></tr></thead>
            <tbody>{data.history.map((h: any) => (
              <tr key={h.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5 whitespace-nowrap">{date(h.effective_from)}</td><td className="px-4">{list(h.price_list_id)}</td>
                <td className="tabular px-4 text-right">{money(h.price, { paisa: true })}</td><td className="px-4 text-ink-2">{h.note ?? '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <FormDrawer open={!!add} onClose={() => setAdd(null)} title="Set a price" initial={add} submitLabel="Save price"
        fields={[
          { name: 'price_list_id', label: 'Price list', type: 'lookup', lookup: 'price_lists', required: true },
          { name: 'price', label: 'Price incl. tax', type: 'money', required: true },
          { name: 'effective_from', label: 'Starts', type: 'date', hint: 'Empty means today; a future date schedules the change' },
          { name: 'note', label: 'Note', full: true },
        ]}
        submit={async (b) => { await api.post(`/products/${id}/prices`, b); toast('Price saved'); qc.invalidateQueries({ queryKey: [`/products/${id}/prices`] }) }} />
    </div>
  )
}

const PARTS = ['materials', 'packaging', 'labour', 'overhead', 'delivery', 'other'] as const

/** Unit cost build-up, its history, and margins per price list. Only shown with product_costs. */
export function Costs({ id }: { id: number }) {
  const can = useCan()
  const qc = useQueryClient()
  const toast = useToast()
  const [add, setAdd] = useState(false)
  const [tryPrice, setTryPrice] = useState('')
  const costs = useQuery({ queryKey: [`/products/${id}/costs`], queryFn: () => api.get(`/products/${id}/costs`) })
  const margins = useQuery({ queryKey: [`/products/${id}/margins`], queryFn: () => api.get(`/products/${id}/margins`) })
  const whatIf = useQuery({
    queryKey: [`/products/${id}/margins`, tryPrice],
    queryFn: () => api.get(`/products/${id}/margins`, { price: tryPrice }),
    enabled: Number(tryPrice) > 0,
  })
  if (costs.isLoading) return <Loading />
  const cur = costs.data?.current
  const hist: any[] = costs.data?.history ?? []
  const w = whatIf.data?.what_if

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Unit cost" sub={cur ? `Since ${date(cur.effective_from)}` : 'No cost recorded yet'}
          action={can('product_costs', 'edit') && <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdd(true)}>Update cost</Button>}>
          {cur ? <>
            <p className="mb-4 text-[30px] leading-none font-semibold tracking-[-0.02em]">{money(cur.total, { paisa: true })}</p>
            <SegmentBar fmt={(v) => money(v, { paisa: true })} parts={PARTS.map((k) => ({ label: k.charAt(0).toUpperCase() + k.slice(1), value: cur[k] }))} />
            {cur.note && <p className="mt-3 text-[12.5px] text-ink-2">{cur.note}</p>}
          </> : <Empty title="No cost yet">Costs come from production and purchases, or enter one by hand.</Empty>}
        </ChartCard>
        <ChartCard title="Margins by price list" sub={`Prices include ${margins.data?.tax_rate ?? '—'}% tax; margin is on the net price`}>
          {!margins.data?.price_lists?.length ? <Empty title="No prices to compare">Set prices on the Pricing tab.</Empty> : (
            <table className="w-full text-[13.5px]">
              <thead><tr className="border-b border-line text-left text-[12px] text-muted"><th className="py-2 font-medium">List</th><th className="py-2 text-right font-medium">Price</th><th className="py-2 text-right font-medium">Net</th><th className="py-2 text-right font-medium">Margin</th></tr></thead>
              <tbody>{margins.data.price_lists.map((m: any) => (
                <tr key={m.price_list} className="border-b border-line last:border-0">
                  <td className="py-2.5">{m.name}</td><td className="tabular text-right">{money(m.price)}</td><td className="tabular text-right text-ink-2">{money(m.net_price)}</td>
                  <td className="tabular text-right font-medium">{money(m.margin)} <span className="font-normal text-muted">{pct(m.margin_pct)}</span></td>
                </tr>
              ))}</tbody>
            </table>
          )}
          <div className="mt-4 rounded-lg bg-page p-3">
            <Field label="Try a selling price (incl. tax)" htmlFor="try-price">
              <Input id="try-price" type="number" inputMode="decimal" placeholder="e.g. 1500" value={tryPrice} onChange={(e) => setTryPrice(e.target.value)} />
            </Field>
            {w && <p className="mt-2 text-[13px] text-ink-2">Net {money(w.net_price, { paisa: true })} after {money(w.tax, { paisa: true })} tax · margin <span className="font-semibold text-ink">{money(w.margin, { paisa: true })} ({pct(w.margin_pct)})</span></p>}
          </div>
        </ChartCard>
      </div>
      {hist.length > 1 && (
        <ChartCard title="Unit cost over time">
          <TrendChart kind="line" height={200} data={[...hist].reverse()} x="effective_from" xFmt={(v) => date(v)} fmt={(v) => money(v)} series={[{ key: 'total', label: 'Unit cost' }]} />
        </ChartCard>
      )}
      <FormDrawer open={add} onClose={() => setAdd(false)} title="Update unit cost" initial={cur ? { ...cur, effective_from: '', note: '' } : {}}
        fields={[
          ...PARTS.map((k) => ({ name: k, label: k.charAt(0).toUpperCase() + k.slice(1), type: 'money' as const })),
          { name: 'effective_from', label: 'From', type: 'date' },
          { name: 'note', label: 'Why it changed', full: true },
        ]}
        submit={async (b) => { await api.post(`/products/${id}/costs`, b); toast('Cost saved'); qc.invalidateQueries({ queryKey: [`/products/${id}`] }); qc.invalidateQueries({ queryKey: [`/products/${id}/costs`] }); qc.invalidateQueries({ queryKey: [`/products/${id}/margins`] }) }} />
    </div>
  )
}
