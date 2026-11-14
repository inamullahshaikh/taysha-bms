import type { ReactNode } from 'react'
import { money } from '../../lib/format'
import { cx } from '../../ui/kit'
import type { LineCol } from '../../ui/Form'
import type { FieldDef } from '../../ui/Form'
import { PRODUCTS, SUPPLIERS } from '../../ui/Form'

type Col<T> = { label: ReactNode; render: (r: T) => ReactNode; align?: 'right' }

/** Read-only lines table for record pages. */
export function LinesTable<T>({ cols, rows, foot }: { cols: Col<T>[]; rows: T[]; foot?: [ReactNode, ReactNode][] }) {
  return (
    <div className="scroll-quiet overflow-x-auto">
      <table className="w-full text-[13.5px]">
        <thead><tr className="border-b border-line text-left">
          {cols.map((c, i) => <th key={i} className={cx('px-4 py-2 text-[12px] font-medium whitespace-nowrap text-muted', c.align === 'right' && 'text-right')}>{c.label}</th>)}
        </tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i} className="border-b border-line last:border-0">
            {cols.map((c, j) => <td key={j} className={cx('px-4 py-2.5', c.align === 'right' && 'tabular text-right whitespace-nowrap')}>{c.render(r)}</td>)}
          </tr>
        ))}</tbody>
      </table>
      {foot && (
        <dl className="ml-auto flex w-full max-w-xs flex-col gap-1.5 border-t border-line px-4 py-3 text-[13.5px]">
          {foot.map(([k, v], i) => (
            <div key={i} className={cx('flex justify-between gap-4', i === foot.length - 1 && 'border-t border-line pt-1.5 font-semibold')}>
              <dt className={i === foot.length - 1 ? '' : 'text-ink-2'}>{k}</dt><dd className="tabular">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}

export const moneyFoot = (r: any, keys: [string, string][]) => keys.filter(([, k]) => r[k] != null).map(([l, k]) => [l, money(r[k], { paisa: true })] as [ReactNode, ReactNode])

export const poFields: FieldDef[] = [
  { name: 'supplier_id', label: 'Supplier', type: 'record', record: SUPPLIERS, required: true, full: true },
  { name: 'order_date', label: 'Order date', type: 'date' },
  { name: 'expected_date', label: 'Expected delivery', type: 'date' },
  { name: 'warehouse_id', label: 'Deliver to', type: 'lookup', lookup: 'warehouses' },
  { name: 'terms', label: 'Terms' },
  { name: 'notes', label: 'Notes', type: 'textarea' },
]

export const poCols: LineCol[] = [
  { name: 'product_id', label: 'Item', type: 'product', record: PRODUCTS },
  { name: 'quantity', label: 'Qty', type: 'number', width: '90px' },
  { name: 'unit', label: 'Pack', type: 'text', width: '110px', placeholder: 'Base unit' },
  { name: 'unit_cost', label: 'Unit cost', type: 'money', width: '120px', placeholder: 'Last price' },
  { name: 'tax_rate', label: 'Tax %', type: 'number', width: '80px' },
]
