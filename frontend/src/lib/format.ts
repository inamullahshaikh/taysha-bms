/** Display-only formatting. Money and quantities come from the API as strings; never do arithmetic on them here. */

const PKR = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 })
const PKR2 = new Intl.NumberFormat('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const QTY = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 3 })
const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v))

export function money(v: unknown, opts: { paisa?: boolean } = {}) {
  const n = num(v)
  if (n === null || Number.isNaN(n)) return '—'
  return `Rs ${(opts.paisa ? PKR2 : PKR).format(n)}`
}

export function compactMoney(v: unknown) {
  const n = num(v)
  if (n === null || Number.isNaN(n)) return '—'
  return `Rs ${Math.abs(n) >= 10000 ? COMPACT.format(n) : PKR.format(n)}`
}

export const compact = (v: unknown) => {
  const n = num(v)
  return n === null || Number.isNaN(n) ? '—' : Math.abs(n) >= 10000 ? COMPACT.format(n) : QTY.format(n)
}

export function qty(v: unknown, unit?: string | null) {
  const n = num(v)
  if (n === null || Number.isNaN(n)) return '—'
  return unit ? `${QTY.format(n)} ${unit}` : QTY.format(n)
}

export function pct(v: unknown, digits = 1) {
  const n = num(v)
  if (n === null || Number.isNaN(n)) return '—'
  return `${n.toFixed(digits)}%`
}

const D = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const DT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const M = new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit' })

/** "2026-11-14" is a calendar date: parse as local, not UTC. */
const parseDate = (v: string) => (v.length === 10 ? new Date(`${v}T00:00:00`) : new Date(v))

export const date = (v?: string | null) => (v ? D.format(parseDate(v)) : '—')
export const dateTime = (v?: string | null) => (v ? DT.format(parseDate(v)) : '—')
export const month = (v: string) => M.format(parseDate(v.length === 7 ? `${v}-01` : v))

export function ago(v?: string | null) {
  if (!v) return '—'
  const s = (Date.now() - parseDate(v).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`
  return date(v)
}

/** snake_case enum → "Sentence case" */
export const label = (v?: string | null) => (v ? (v.charAt(0).toUpperCase() + v.slice(1)).replace(/_/g, ' ') : '—')

export const today = () => {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
