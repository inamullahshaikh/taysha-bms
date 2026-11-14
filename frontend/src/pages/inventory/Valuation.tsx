import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useState } from 'react'
import { api, url } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { compactMoney, label, money, qty } from '../../lib/format'
import { useLookups } from '../../lib/hooks'
import { BarList, ChartCard, SERIES } from '../../ui/charts'
import { Button, Card, Loading, Segmented, Select } from '../../ui/kit'

type Group = 'type' | 'product' | 'warehouse'

/** Stock value at weighted-average cost. Needs product_costs (the API enforces it). */
export default function Valuation() {
  const can = useCan()
  const { data: lk } = useLookups()
  const [group, setGroup] = useState<Group>('type')
  const [wh, setWh] = useState('')
  const params = { group_by: group, warehouse_id: wh || undefined }
  const { data, isLoading } = useQuery({ queryKey: ['/stock/valuation', params], queryFn: () => api.get('/stock/valuation', params) })
  const rows: any[] = data?.rows ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={group} onChange={setGroup} options={[{ value: 'type', label: 'By type' }, { value: 'product', label: 'By item' }, { value: 'warehouse', label: 'By warehouse' }]} />
        <div className="w-48"><Select aria-label="Warehouse" className="h-8 text-[13px]" value={wh} onChange={(e) => setWh(e.target.value)} placeholder="All warehouses"
          options={(lk?.warehouses ?? []).map((w) => ({ value: w.id, label: w.name! }))} /></div>
        {can('inventory', 'export') && (
          <a href={url('/stock/valuation', { ...params, format: 'xlsx' })} className="ml-auto">
            <Button size="sm" icon={<Download className="size-3.5" />}>Export</Button>
          </a>
        )}
      </div>
      {isLoading ? <Loading /> : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <ChartCard title="Total stock value" sub="At weighted-average cost">
            <p className="mb-5 text-[34px] leading-none font-semibold tracking-[-0.02em]">{money(data?.total)}</p>
            <BarList fmt={compactMoney} limit={10}
              items={rows.map((r, i) => ({ label: group === 'type' ? label(r.label) : r.label, value: r.value, color: group === 'type' ? SERIES[i % SERIES.length] : undefined }))} />
          </ChartCard>
          <Card pad={false}>
            <table className="w-full text-[13.5px]">
              <thead><tr className="border-b border-line text-left text-[12px] text-muted">
                <th className="px-4 py-2.5 font-medium">{group === 'type' ? 'Type' : group === 'product' ? 'Item' : 'Warehouse'}</th>
                <th className="px-4 py-2.5 text-right font-medium">Quantity</th><th className="px-4 py-2.5 text-right font-medium">Value</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5">{group === 'type' ? label(r.label) : r.label}</td>
                    <td className="tabular px-4 text-right text-ink-2">{qty(r.quantity)}</td>
                    <td className="tabular px-4 text-right font-medium">{money(r.value)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="border-t border-line-strong"><td className="px-4 py-2.5 font-semibold">Total</td><td /><td className="tabular px-4 text-right font-semibold">{money(data?.total)}</td></tr></tfoot>
            </table>
          </Card>
        </div>
      )}
    </div>
  )
}
