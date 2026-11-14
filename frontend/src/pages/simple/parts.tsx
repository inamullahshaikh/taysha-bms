import { CircleCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { cx } from '../../ui/kit'

/** A numbered question with big answer buttons under it. */
export function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="rounded-card bg-surface p-4 shadow-card sm:p-5">
      <h2 className="mb-3 flex items-center gap-2.5 text-[16px] font-semibold">
        <span className="flex size-7 items-center justify-center rounded-full bg-wine-800 text-[13px] text-cream">{n}</span>{title}
      </h2>
      {children}
    </section>
  )
}

/** One-tap choice buttons (the selected one is filled). */
export function Pick<T extends string | number>({ options, value, onChange }: {
  options: { value: T; label: ReactNode; sub?: ReactNode }[]; value: T | undefined; onChange: (v: T) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}
          className={cx('min-h-14 rounded-xl border-2 px-3 py-2.5 text-left text-[14.5px] font-medium transition active:scale-[0.98]',
            value === o.value ? 'border-wine-800 bg-wine-800 text-cream' : 'border-line-strong bg-surface hover:border-wine-200 hover:bg-wine-50')}>
          <span className="block leading-snug">{o.label}</span>
          {o.sub && <span className={cx('block text-[12px] font-normal', value === o.value ? 'text-cream/75' : 'text-muted')}>{o.sub}</span>}
        </button>
      ))}
    </div>
  )
}

/** "Saved!" screen with big next-step buttons. */
export function Done({ title, children, actions }: { title: string; children?: ReactNode; actions: { label: string; to?: string; onClick?: () => void; primary?: boolean }[] }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-10 text-center">
      <CircleCheck className="size-16 text-good" strokeWidth={1.5} />
      <h1 className="text-[22px] font-semibold">{title}</h1>
      {children && <div className="text-[14px] text-ink-2">{children}</div>}
      <div className="mt-4 flex w-full flex-col gap-2.5">
        {actions.map((a) => {
          const cls = cx('flex h-14 w-full items-center justify-center rounded-xl text-[16px] font-medium',
            a.primary ? 'bg-wine-800 text-cream hover:bg-wine-700' : 'border-2 border-line-strong bg-surface hover:bg-wine-50')
          return a.to
            ? <Link key={a.label} to={a.to} className={cls}>{a.label}</Link>
            : <button key={a.label} type="button" onClick={a.onClick} className={cls}>{a.label}</button>
        })}
      </div>
    </div>
  )
}

/** Big bottom action bar that stays in view on phones. */
export function SaveBar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-2 border-t border-line bg-page/95 px-4 py-3 backdrop-blur-md lg:-mx-8 lg:px-8">
      <div className="mx-auto flex max-w-3xl items-center gap-3">{children}</div>
    </div>
  )
}
