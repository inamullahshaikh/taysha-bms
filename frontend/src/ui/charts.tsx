import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { compact } from '../lib/format'
import { cx } from './kit'

/** Categorical slots in fixed order (validated for colour-blind separation). Colour follows the entity, never rank. */
export const SERIES = ['#8c2f45', '#d9822b', '#1f8a70', '#3b6fb6', '#e0a526', '#c45c8a']
const GRID = '#efe7e0'
const AXIS = '#8e8285'

type Fmt = (v: number) => string
const n = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v))

/* ---------- Stat tile ---------- */

export function StatTile({ label, value, delta, upIsGood = true, sub, to, spark }: {
  label: string
  value: ReactNode
  /** signed % vs previous period */
  delta?: number | string | null
  upIsGood?: boolean
  sub?: ReactNode
  to?: string
  spark?: number[]
}) {
  const d = delta === null || delta === undefined || delta === '' ? null : Number(delta)
  const good = d === null ? null : d === 0 ? null : (d > 0) === upIsGood
  const body = (
    <div className={cx('group flex h-full flex-col rounded-card bg-surface p-4 shadow-card transition', to && 'hover:-translate-y-px hover:shadow-[0_6px_20px_-8px_rgb(62_16_25/0.18)]')}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[12.5px] font-medium text-ink-2">{label}</p>
        {d !== null && (
          <span className={cx('inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11.5px] font-semibold',
            good === null ? 'bg-sunken text-ink-2' : good ? 'bg-good-bg text-good' : 'bg-bad-bg text-bad')}
            title="vs previous period">
            {d > 0 ? <ArrowUpRight className="size-3" /> : d < 0 ? <ArrowDownRight className="size-3" /> : null}
            {Math.abs(d).toFixed(1)}%
          </span>
        )}
      </div>
      <p className="mt-2 text-[26px] leading-none font-semibold tracking-[-0.02em] text-ink">{value}</p>
      <div className="mt-auto flex items-end justify-between gap-3 pt-2">
        {sub ? <p className="text-[12px] text-muted">{sub}</p> : <span />}
        {spark && spark.length > 1 && <span className="hidden sm:block"><Sparkline values={spark} /></span>}
      </div>
    </div>
  )
  return to ? <Link to={to} className="block">{body}</Link> : body
}

export function Sparkline({ values, color = SERIES[0] }: { values: number[]; color?: string }) {
  const w = 72, h = 24
  const max = Math.max(...values), min = Math.min(...values)
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - ((v - min) / (max - min || 1)) * (h - 4)])
  const last = pts[pts.length - 1]
  return (
    <svg width={w} height={h} aria-hidden className="shrink-0 overflow-visible">
      <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="#d8c9cc" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={3} fill={color} stroke="#fff" strokeWidth={1.5} />
    </svg>
  )
}

/* ---------- Tooltip ---------- */

function TipBox({ active, payload, label, fmt, labelFmt }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="min-w-36 rounded-lg bg-surface px-3 py-2 text-[12.5px] shadow-pop">
      <p className="mb-1 font-medium text-ink">{labelFmt ? labelFmt(label) : label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-ink-2">
            <span className="size-2 rounded-full" style={{ background: p.color ?? p.stroke ?? p.fill }} />
            {p.name}
          </span>
          <span className="tabular font-medium text-ink">{fmt ? fmt(n(p.value)) : p.value}</span>
        </div>
      ))}
    </div>
  )
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full" style={{ background: i.color, height: 3 }} />{i.label}
        </span>
      ))}
    </div>
  )
}

/* ---------- Trend (time series) ---------- */

export type Series = { key: string; label: string; color?: string }

export function TrendChart({ data, x, series, kind = 'area', height = 260, fmt = compact as Fmt, xFmt, stacked }: {
  data: any[]; x: string; series: Series[]; kind?: 'area' | 'line' | 'bar'; height?: number
  fmt?: Fmt; xFmt?: (v: string) => string; stacked?: boolean
}) {
  const rows = data.map((d) => ({ ...d, ...Object.fromEntries(series.map((s) => [s.key, n(d[s.key])])) }))
  const colors = series.map((s, i) => s.color ?? SERIES[i % SERIES.length])
  const axes = (
    <>
      <CartesianGrid vertical={false} stroke={GRID} />
      <XAxis dataKey={x} tickFormatter={xFmt} tickLine={false} axisLine={{ stroke: '#e1d6cc' }} tick={{ fill: AXIS, fontSize: 11.5 }} tickMargin={8} minTickGap={16} />
      <YAxis tickFormatter={(v) => compact(v)} tickLine={false} axisLine={false} tick={{ fill: AXIS, fontSize: 11.5 }} width={44} />
      <Tooltip cursor={kind === 'bar' ? { fill: '#f6eee8' } : { stroke: '#d8c9cc', strokeWidth: 1 }} content={<TipBox fmt={fmt} labelFmt={xFmt} />} />
    </>
  )
  return (
    <div>
      {series.length > 1 && <div className="mb-3"><Legend items={series.map((s, i) => ({ label: s.label, color: colors[i] }))} /></div>}
      <ResponsiveContainer width="100%" height={height}>
        {kind === 'bar' ? (
          <BarChart data={rows} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barGap={2} barCategoryGap="28%">
            {axes}
            {series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={colors[i]} maxBarSize={24} stackId={stacked ? 'a' : undefined}
                radius={stacked && i < series.length - 1 ? 0 : [4, 4, 0, 0]} stroke={stacked ? '#fff' : undefined} strokeWidth={stacked ? 1 : 0} />
            ))}
          </BarChart>
        ) : kind === 'line' ? (
          <LineChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            {axes}
            {series.map((s, i) => (
              <Line key={s.key} dataKey={s.key} name={s.label} stroke={colors[i]} strokeWidth={2} dot={false}
                activeDot={{ r: 4.5, stroke: '#fff', strokeWidth: 2 }} type="monotone" />
            ))}
          </LineChart>
        ) : (
          <AreaChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs>
              {series.map((s, i) => (
                <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={colors[i]} stopOpacity={0.16} />
                  <stop offset="100%" stopColor={colors[i]} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            {axes}
            {series.map((s, i) => (
              <Area key={s.key} dataKey={s.key} name={s.label} stroke={colors[i]} strokeWidth={2} fill={`url(#g-${s.key})`}
                activeDot={{ r: 4.5, stroke: '#fff', strokeWidth: 2 }} type="monotone" />
            ))}
          </AreaChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}

/* ---------- Ranked bars (HTML: labels stay crisp, values never clip) ---------- */

export function BarList({ items, fmt = compact as Fmt, color = SERIES[0], limit, empty = 'No data for this period' }: {
  items: { label: ReactNode; value: number | string; sub?: ReactNode; to?: string; color?: string }[]
  fmt?: Fmt; color?: string; limit?: number; empty?: string
}) {
  const list = limit ? items.slice(0, limit) : items
  const max = Math.max(...list.map((i) => n(i.value)), 1)
  if (!list.length) return <p className="py-8 text-center text-[13px] text-muted">{empty}</p>
  return (
    <ul className="flex flex-col gap-3">
      {list.map((i, k) => {
        const row = (
          <>
            <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px]">
              <span className="truncate text-ink">{i.label}</span>
              <span className="tabular shrink-0 font-medium text-ink">{fmt(n(i.value))}{i.sub && <span className="ml-1.5 font-normal text-muted">{i.sub}</span>}</span>
            </div>
            <div className="h-1.5 rounded-full bg-sunken">
              <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max((n(i.value) / max) * 100, 1.5)}%`, background: i.color ?? color }} />
            </div>
          </>
        )
        return <li key={k}>{i.to ? <Link to={i.to} className="block rounded-md hover:opacity-80">{row}</Link> : row}</li>
      })}
    </ul>
  )
}

/* ---------- Parts of a whole ---------- */

export function SegmentBar({ parts, fmt = compact as Fmt }: { parts: { label: string; value: number | string; color?: string }[]; fmt?: Fmt }) {
  const list = parts.filter((p) => n(p.value) > 0)
  const total = list.reduce((s, p) => s + n(p.value), 0)
  if (!total) return <p className="py-6 text-center text-[13px] text-muted">No data for this period</p>
  return (
    <div>
      <div className="flex h-7 gap-0.5 overflow-hidden rounded-md" role="img"
        aria-label={list.map((p) => `${p.label} ${fmt(n(p.value))}`).join(', ')}>
        {list.map((p, i) => {
          const share = (n(p.value) / total) * 100
          return (
            <div key={p.label} title={`${p.label}: ${fmt(n(p.value))} (${share.toFixed(0)}%)`}
              className="flex items-center overflow-hidden px-2 text-[11.5px] font-medium text-white first:rounded-l-md last:rounded-r-md"
              style={{ width: `${share}%`, background: p.color ?? SERIES[i % SERIES.length] }}>
              {share > 9 && `${share.toFixed(0)}%`}
            </div>
          )
        })}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-5 gap-y-1.5 text-[12.5px]">
        {list.map((p, i) => (
          <li key={p.label} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-ink-2">
              <span className="size-2 shrink-0 rounded-sm" style={{ background: p.color ?? SERIES[i % SERIES.length] }} />
              <span className="truncate">{p.label}</span>
            </span>
            <span className="tabular font-medium text-ink">{fmt(n(p.value))}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Progress / meter with a same-hue track. */
export function Meter({ value, max, tone = 'brand' }: { value: number; max: number; tone?: 'brand' | 'good' | 'warn' | 'bad' }) {
  const pct = Math.min(Math.max(max ? (value / max) * 100 : 0, 0), 100)
  const fill = { brand: SERIES[0], good: '#12805c', warn: '#d98a00', bad: '#c0392b' }[tone]
  const track = { brand: '#f3e4e7', good: '#dff0e7', warn: '#fbedd2', bad: '#f8e0dc' }[tone]
  return (
    <div className="h-2 w-full rounded-full" style={{ background: track }} role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: fill }} />
    </div>
  )
}

export function ChartCard({ title, sub, action, children, className }: { title: string; sub?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-card bg-surface p-4 shadow-card', className)}>
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[13.5px] font-semibold text-ink">{title}</h2>
          {sub && <p className="mt-0.5 text-[12.5px] text-muted">{sub}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}
