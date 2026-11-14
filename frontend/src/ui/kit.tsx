import { Loader2, X } from 'lucide-react'
import {
  useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { NavLink } from 'react-router-dom'
import { label as fmtLabel } from '../lib/format'

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/* ---------- Button ---------- */

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  icon?: ReactNode
  loading?: boolean
}

export function Button({ variant = 'secondary', size = 'md', icon, loading, className, children, disabled, ...p }: BtnProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-[background,box-shadow,transform] duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-[13.5px]',
        variant === 'primary' && 'bg-wine-800 text-cream shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] hover:bg-wine-700',
        variant === 'secondary' && 'border border-line-strong bg-surface text-ink hover:border-wine-200 hover:bg-wine-50',
        variant === 'ghost' && 'text-ink-2 hover:bg-sunken hover:text-ink',
        variant === 'danger' && 'bg-bad text-white hover:bg-[#a83225]',
        className,
      )}
      {...p}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  )
}

export function IconButton({ label, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx('inline-flex size-8 items-center justify-center rounded-lg text-ink-2 transition hover:bg-sunken hover:text-ink', className)}
      {...p}
    >
      {children}
    </button>
  )
}

/* ---------- Form controls ---------- */

/** A width class passed by the caller (w-40, w-auto…) replaces the default full width. */
const width = (className?: string) => (className && /(^|\s)(\w+:)?w-/.test(className) ? '' : 'w-full')

const control =
  'h-9 rounded-lg border border-line-strong bg-surface px-3 text-[13.5px] text-ink placeholder:text-muted transition focus:border-wine-600 focus:outline-none focus:ring-3 focus:ring-wine-100 disabled:bg-sunken disabled:text-ink-2 aria-invalid:border-bad'

export function Field({ label, error, hint, children, className, htmlFor }: {
  label?: ReactNode; error?: string; hint?: ReactNode; children: ReactNode; className?: string; htmlFor?: string
}) {
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      {label && <label htmlFor={htmlFor} className="text-[12.5px] font-medium text-ink-2">{label}</label>}
      {children}
      {error ? <p className="text-[12px] text-bad">{error}</p> : hint ? <p className="text-[12px] text-muted">{hint}</p> : null}
    </div>
  )
}

export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => (
  <input className={cx(control, width(className), p.type === 'number' && 'tabular', className)} {...p} />
)

export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea className={cx(control, width(className), 'h-auto min-h-20 py-2', className)} {...p} />
)

export function Select({ className, options, placeholder, ...p }: SelectHTMLAttributes<HTMLSelectElement> & {
  options: (string | { value: string | number; label: string })[]
  placeholder?: string
}) {
  return (
    <select className={cx(control, width(className), 'appearance-none bg-[length:16px] bg-[right_8px_center] bg-no-repeat pr-8', className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238e8285' stroke-width='2'%3E%3Cpath d='m7 10 5 5 5-5'/%3E%3C/svg%3E\")" }}
      {...p}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) =>
        typeof o === 'string' ? <option key={o} value={o}>{fmtLabel(o)}</option> : <option key={o.value} value={o.value}>{o.label}</option>,
      )}
    </select>
  )
}

export function Checkbox({ label, className, ...p }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) {
  return (
    <label className={cx('inline-flex cursor-pointer items-center gap-2 text-[13.5px] text-ink', className)}>
      <input type="checkbox" className="size-4 rounded border-line-strong accent-wine-800" {...p} />
      {label}
    </label>
  )
}

/* ---------- Surfaces ---------- */

export function Card({ title, action, children, className, pad = true }: {
  title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; pad?: boolean
}) {
  return (
    <section className={cx('rounded-card bg-surface shadow-card', className)}>
      {(title || action) && (
        <header className="flex min-h-12 items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h2 className="text-[13.5px] font-semibold text-ink">{title}</h2>
          {action}
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  )
}

export function PageHeader({ title, subtitle, actions, children }: {
  title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode
}) {
  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-[26px] leading-tight tracking-[0.005em] text-wine-800">{title}</h1>
          {subtitle && <p className="mt-1 text-[13.5px] text-ink-2">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  )
}

/** Key/value list for record pages. */
export function Facts({ items, cols = 2 }: { items: [ReactNode, ReactNode][]; cols?: 1 | 2 | 3 | 4 }) {
  return (
    <dl className={cx('grid gap-x-6 gap-y-3.5', cols === 1 ? 'grid-cols-1' : cols === 2 ? 'sm:grid-cols-2' : cols === 3 ? 'sm:grid-cols-3' : 'grid-cols-2 lg:grid-cols-4')}>
      {items.filter(([, v]) => v !== undefined).map(([k, v], i) => (
        <div key={i} className="min-w-0">
          <dt className="text-[12px] text-muted">{k}</dt>
          <dd className="mt-0.5 truncate text-[13.5px] text-ink">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

/* ---------- Status ---------- */

type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral' | 'brand'
const toneClass: Record<Tone, string> = {
  good: 'bg-good-bg text-good',
  warn: 'bg-warn-bg text-warn',
  bad: 'bg-bad-bg text-bad',
  info: 'bg-info-bg text-info',
  neutral: 'bg-sunken text-ink-2',
  brand: 'bg-wine-100 text-wine-800',
}

const STATUS_TONE: Record<string, Tone> = {}
const set = (tone: Tone, words: string) => words.split(' ').forEach((w) => (STATUS_TONE[w] = tone))
set('good', 'delivered paid approved completed done active pass passed ok available received issued accepted published won closed resolved released in_use posted fulfilled launched billed sent')
set('info', 'confirmed processing packed in_progress submitted ordered partially_received running started open scheduled planned testing qualified contacted in_transit partially_paid shipped approved_pending new todo')
set('warn', 'pending draft hold on_hold cod_pending low partially_billed due_soon expiring under_repair idle paused waiting review medium samples_sent agreed blocked')
set('bad', 'cancelled rejected failed overdue out_of_stock expired fail returned refunded lost recalled high urgent critical disposed retired issue')

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span className={cx('inline-flex h-[22px] items-center gap-1 rounded-full px-2 text-[12px] font-medium whitespace-nowrap', toneClass[tone], className)}>
      {children}
    </span>
  )
}

/** Status pill: colour from the word, always shows the word (never colour alone). */
export function Status({ value, tone }: { value?: string | null; tone?: Tone }) {
  if (!value) return <span className="text-muted">—</span>
  return (
    <Badge tone={tone ?? STATUS_TONE[value] ?? 'neutral'}>
      <span className="size-1.5 rounded-full bg-current opacity-70" />
      {fmtLabel(value)}
    </Badge>
  )
}

/* ---------- Feedback ---------- */

export const Spinner = ({ className }: { className?: string }) => (
  <Loader2 className={cx('size-5 animate-spin text-muted', className)} aria-label="Loading" />
)

export function Loading() {
  return <div className="flex h-40 items-center justify-center"><Spinner /></div>
}

export function Empty({ title, children, icon, action }: { title: string; children?: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-wine-50 text-wine-600 [&_svg]:size-5">{icon}</div>}
      <p className="text-[14px] font-medium text-ink">{title}</p>
      {children && <p className="mt-1 max-w-sm text-[13px] text-ink-2">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <div role="alert" className="rounded-lg border border-bad/20 bg-bad-bg px-3 py-2 text-[13px] text-bad">
      {error instanceof Error ? error.message : 'Something went wrong'}
    </div>
  )
}

/* ---------- Overlays ---------- */

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
}

/** Right-side panel for create/edit forms. */
export function Drawer({ open, onClose, title, children, footer, wide }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean
}) {
  useEscape(open, onClose)
  const id = useId()
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-wine-950/25" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby={id}
        className={cx('anim-slide relative flex h-full w-full flex-col bg-surface shadow-pop', wide ? 'max-w-3xl' : 'max-w-lg')}>
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 id={id} className="text-[15px] font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}><X className="size-4" /></IconButton>
        </header>
        <div className="scroll-quiet flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line bg-page px-5 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

export function Modal({ open, onClose, title, children, footer }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode
}) {
  useEscape(open, onClose)
  const id = useId()
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-wine-950/25" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby={id} className="anim-rise relative w-full max-w-md rounded-card bg-surface shadow-pop">
        <header className="px-5 pt-5"><h2 id={id} className="text-[15px] font-semibold">{title}</h2></header>
        <div className="px-5 py-3 text-[13.5px] text-ink-2">{children}</div>
        {footer && <footer className="flex justify-end gap-2 px-5 pt-2 pb-5">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

/** Confirm, optionally collecting a note/reason. */
export function Confirm({ open, onClose, onConfirm, title, body, confirmLabel = 'Confirm', danger, note, loading }: {
  open: boolean; onClose: () => void; onConfirm: (note: string) => void; title: string; body?: ReactNode
  confirmLabel?: string; danger?: boolean; note?: { label: string; required?: boolean }; loading?: boolean
}) {
  const [text, setText] = useState('')
  useEffect(() => { if (open) setText('') }, [open])
  return (
    <Modal open={open} onClose={onClose} title={title}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} loading={loading}
          disabled={note?.required && !text.trim()} onClick={() => onConfirm(text.trim())}>{confirmLabel}</Button>
      </>}>
      {body}
      {note && (
        <Field label={note.label} className="mt-3">
          <Textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      )}
    </Modal>
  )
}

/** Small dropdown menu anchored to a trigger. */
export function Menu({ trigger, children, align = 'right', up }: { trigger: ReactNode; children: ReactNode; align?: 'left' | 'right'; up?: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  useEscape(open, () => setOpen(false))
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && (
        <div onClick={() => setOpen(false)}
          className={cx('anim-rise absolute z-40 min-w-48 rounded-lg bg-surface p-1 shadow-pop', up ? 'bottom-full mb-1.5' : 'top-full mt-1.5', align === 'right' ? 'right-0' : 'left-0')}>
          {children}
        </div>
      )}
    </div>
  )
}

export function MenuItem({ icon, children, onClick, danger }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={cx('flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] hover:bg-sunken [&_svg]:size-4 [&_svg]:text-muted', danger ? 'text-bad' : 'text-ink')}>
      {icon}{children}
    </button>
  )
}

/* ---------- Tabs ---------- */

/** Route tabs (sub-navigation inside a section) or state tabs (inside a record). */
export function Tabs<T extends string>({ tabs, value, onChange }: {
  tabs: { value: T; label: ReactNode; to?: string }[]; value?: T; onChange?: (v: T) => void
}) {
  const base = 'relative -mb-px flex h-10 items-center border-b-2 px-0.5 text-[13.5px] font-medium whitespace-nowrap transition'
  const on = 'border-wine-800 text-wine-800'
  const off = 'border-transparent text-ink-2 hover:text-ink'
  return (
    <nav className="scroll-quiet flex gap-5 overflow-x-auto border-b border-line">
      {tabs.map((t) =>
        t.to ? (
          <NavLink key={t.value} to={t.to} end className={({ isActive }) => cx(base, isActive ? on : off)}>{t.label}</NavLink>
        ) : (
          <button key={t.value} type="button" onClick={() => onChange?.(t.value)} className={cx(base, value === t.value ? on : off)}>
            {t.label}
          </button>
        ),
      )}
    </nav>
  )
}

/** Segmented control for small filter sets (date ranges, views). */
export function Segmented<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void
}) {
  return (
    <div className="inline-flex rounded-lg bg-sunken p-0.5" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={cx('h-7 rounded-md px-2.5 text-[12.5px] font-medium whitespace-nowrap transition',
            value === o.value ? 'bg-surface text-ink shadow-card' : 'text-ink-2 hover:text-ink')}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
