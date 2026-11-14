import { useQuery } from '@tanstack/react-query'
import { TrendingUp } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { date, money } from '../../lib/format'
import { productLabel, useRefMap } from '../../lib/hooks'
import { Badge, Card, Empty, Loading, Segmented } from '../../ui/kit'
import { LinesTable } from './common'

export default function PriceChanges() {
  const [days, setDays] = useState('90')
  const supplier = useRefMap('/suppliers')
  const product = useRefMap('/products', productLabel)
  const { data, isLoading } = useQuery({ queryKey: ['/purchasing/price-changes', days], queryFn: () => api.get<any[]>('/purchasing/price-changes', { days, min_change_pct: 1 }) })
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-ink-2">Unit costs that moved by 1% or more between two purchase orders from the same supplier.</p>
        <Segmented value={days} onChange={setDays} options={[{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: '1 year' }]} />
      </div>
      <Card pad={false}>
        {isLoading ? <Loading /> : !data?.length ? <Empty title="No price changes" icon={<TrendingUp />}>Supplier prices have held steady in this period.</Empty> : (
          <LinesTable rows={data} cols={[
            { label: 'Item', render: (r: any) => <Link to={`/products/${r.product_id}`} className="font-medium hover:text-wine-800">{product(r.product_id)}</Link> },
            { label: 'Supplier', render: (r: any) => <Link to={`/suppliers/${r.supplier_id}`} className="hover:text-wine-800">{supplier(r.supplier_id)}</Link> },
            { label: 'Date', render: (r: any) => date(r.date) },
            { label: 'Was', align: 'right', render: (r: any) => <span className="text-ink-2">{money(r.previous_cost, { paisa: true })}</span> },
            { label: 'Now', align: 'right', render: (r: any) => money(r.latest_cost, { paisa: true }) },
            { label: 'Change', align: 'right', render: (r: any) => <Badge tone={Number(r.change_pct) > 0 ? 'bad' : 'good'}>{Number(r.change_pct) > 0 ? '+' : ''}{r.change_pct}%</Badge> },
          ]} />
        )}
      </Card>
    </div>
  )
}
