import { useQuery } from '@tanstack/react-query'
import { Boxes } from 'lucide-react'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { compact, compactMoney, money, qty } from '../../lib/format'
import { useLookups } from '../../lib/hooks'
import { BarList, ChartCard, StatTile } from '../../ui/charts'
import { DataTable } from '../../ui/DataTable'
import { Badge } from '../../ui/kit'
import { STOCK_STATUS, useOpsMetrics } from './shared'
import { StockActions } from './StockOps'

export default function Stock() {
  const can = useCan()
  const costs = can('product_costs')
  const { data: lk } = useLookups()
  const inv = useOpsMetrics().data?.inventory
  const valuation = useQuery({
    queryKey: ['/stock/valuation', 'product'],
    queryFn: () => api.get('/stock/valuation', { group_by: 'product' }),
    enabled: costs,
  })

  return (
    <div className="flex flex-col gap-4">
      {inv && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {costs && inv.valuation != null
            ? <StatTile label="Stock value" value={compactMoney(inv.valuation)} sub={`${inv.total_products} items tracked`} to="/stock/valuation" />
            : <StatTile label="Items tracked" value={compact(inv.total_products)} />}
          <StatTile label="Low stock" value={inv.low_stock} sub={inv.materials_short ? `${inv.materials_short} materials short for production` : 'At or below reorder point'} to="/stock?status=low" />
          <StatTile label="Out of stock" value={inv.out_of_stock} sub="Nothing available to sell or use" to="/stock?status=out_of_stock" />
          <StatTile label="Expiring soon" value={inv.expiring_batches} sub={inv.expired_batches_with_stock ? `${inv.expired_batches_with_stock} expired batch still in stock` : 'Batches within 30 days'} to="/stock/batches?expiring_within_days=30" />
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <DataTable
          path="/stock/balances"
          search="Search items"
          filters={[
            { key: 'warehouse_id', label: 'All warehouses', options: (lk?.warehouses ?? []).map((w) => ({ value: w.id, label: w.name! })) },
            { key: 'type', label: 'All types', options: ['finished', 'raw', 'packaging', 'consumable', 'spare'] },
            { key: 'status', label: 'Any level', options: Object.entries(STOCK_STATUS).map(([value, s]) => ({ value, label: s.text })) },
          ]}
          rowTo={(r: any) => `/products/${r.product_id}?tab=stock`}
          toolbar={<StockActions />}
          empty={{ title: 'No stock yet', body: 'Receive stock or record opening balances to get started.', icon: <Boxes /> }}
          columns={[
            { key: 'name', label: 'Item', sort: 'name', render: (r: any) => <div><p className="font-medium text-ink">{r.name}</p><p className="text-[12px] text-muted">{r.sku}</p></div> },
            { key: 'on_hand', label: 'On hand', align: 'right', render: (r: any) => qty(r.on_hand) },
            { key: 'reserved', label: 'Reserved', align: 'right', render: (r: any) => <span className="text-ink-2">{qty(r.reserved)}</span> },
            { key: 'available', label: 'Available', align: 'right', render: (r: any) => <span className="font-medium">{qty(r.available)}</span> },
            { key: 'in_transit', label: 'In transit', align: 'right', render: (r: any) => Number(r.in_transit) ? qty(r.in_transit) : <span className="text-muted">—</span> },
            { key: 'status', label: 'Level', render: (r: any) => { const s = STOCK_STATUS[r.status]; return s ? <Badge tone={s.tone}>{s.text}</Badge> : null } },
            ...(costs ? [{ key: 'value', label: 'Value', align: 'right' as const, render: (r: any) => money(r.value) }] : []),
          ]}
        />
        {costs && (
          <ChartCard title="Where the money sits" sub="Stock value by item">
            <BarList fmt={(v) => compactMoney(v)} limit={8}
              items={(valuation.data?.rows ?? []).map((r: any) => ({ label: r.label, value: r.value, to: `/products/${r.key}?tab=stock` }))} />
          </ChartCard>
        )}
      </div>
    </div>
  )
}
