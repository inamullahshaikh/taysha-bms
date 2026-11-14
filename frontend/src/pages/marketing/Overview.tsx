import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { compactMoney, label, money } from '../../lib/format'
import { BarList, ChartCard, StatTile, TrendChart } from '../../ui/charts'
import { Card, Empty, Loading } from '../../ui/kit'
import { usePeriod } from '../finance/shared'

const x = (v: unknown) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(2)}×`)

export default function MarketingOverview() {
  const { params, control } = usePeriod('year')
  const dash = useQuery({ queryKey: ['/dashboard', 'marketing', params], queryFn: () => api.get('/dashboard', params) })
  const byCampaign = useQuery({ queryKey: ['/marketing/performance', 'campaign', params], queryFn: () => api.get('/marketing/performance', { ...params, group_by: 'campaign' }) })
  const byPlatform = useQuery({ queryKey: ['/marketing/performance', 'platform', params], queryFn: () => api.get('/marketing/performance', { ...params, group_by: 'platform' }) })
  const promos = useQuery({ queryKey: ['/marketing/promo-codes', params], queryFn: () => api.get<any[]>('/marketing/promo-codes', params) })
  const m = dash.data?.marketing
  const campaigns: any[] = byCampaign.data?.rows ?? []
  const platforms: any[] = byPlatform.data?.rows ?? []

  return (
    <div className="flex flex-col gap-4">
      <div>{control}</div>
      {!m ? <Loading /> : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile label="Spend" value={compactMoney(m.spend)} sub={`${m.active_campaigns} active campaigns`} to="/campaigns" />
          <StatTile label="Revenue from campaigns" value={compactMoney(m.marketing_revenue)} sub={`${m.attributed_orders} attributed orders`} />
          <StatTile label="Return on ad spend" value={x(m.roas)} sub="revenue per rupee spent" />
          <StatTile label="Cost per new customer" value={m.cac ? compactMoney(m.cac) : '—'} />
          <StatTile label="Leads" value={m.leads} to="/leads" />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <ChartCard title="Spend and revenue by campaign" sub="Attributed by discount code and UTM">
          {campaigns.length ? (
            <TrendChart data={campaigns} x="name" kind="bar" height={260} fmt={(v) => money(v)}
              xFmt={(v) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
              series={[{ key: 'total_cost', label: 'Spend incl. influencer fees' }, { key: 'revenue', label: 'Revenue', color: '#1f8a70' }]} />
          ) : <Empty title="No campaign activity in this period" />}
        </ChartCard>
        <ChartCard title="Return on ad spend" sub="Revenue ÷ spend, by campaign">
          <BarList fmt={x} color="#1f8a70" items={[...campaigns].sort((a, b) => Number(b.roas) - Number(a.roas))
            .map((c) => ({ label: c.name, value: c.roas ?? 0, to: `/campaigns/${c.campaign_id}` }))} />
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Cost per new customer by platform">
          <BarList fmt={(v) => compactMoney(v)} color="#d9822b"
            items={platforms.filter((p) => p.cac).sort((a, b) => Number(a.cac) - Number(b.cac)).map((p) => ({ label: label(p.platform), value: p.cac, sub: `${p.new_customers} new` }))}
            empty="No new customers attributed yet" />
        </ChartCard>
        <Card pad={false} title="Discount codes">
          {!promos.data ? <Loading /> : !promos.data.length ? <Empty title="No codes used in this period" /> : (
            <table className="w-full text-[13px]">
              <thead><tr className="border-b border-line text-left text-[12px] text-muted">
                <th className="h-9 px-4 font-medium">Code</th><th className="px-3 text-right font-medium">Orders</th>
                <th className="px-3 text-right font-medium">Revenue</th><th className="px-3 text-right font-medium">Discount given</th><th className="px-4 text-right font-medium">Avg order</th>
              </tr></thead>
              <tbody>
                {promos.data.map((p) => (
                  <tr key={p.code} className="border-b border-line last:border-0">
                    <td className="h-11 px-4 font-medium tabular">{p.code}</td>
                    <td className="px-3 text-right tabular">{p.orders}</td>
                    <td className="px-3 text-right tabular">{money(p.revenue)}</td>
                    <td className="px-3 text-right tabular">{money(p.discount_given)}</td>
                    <td className="px-4 text-right tabular">{money(p.average_order)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  )
}
