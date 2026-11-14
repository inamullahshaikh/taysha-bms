import { Package } from 'lucide-react'
import { label } from '../../lib/format'
import { useLookupName, useLookups } from '../../lib/hooks'
import { Badge, Status } from '../../ui/kit'
import { ResourcePage } from '../../ui/Resource'
import { KINDS, productDefaults, productFields, STATUSES, TYPES } from './fields'

export default function Products() {
  const { data: lk } = useLookups()
  const cat = useLookupName('product_categories')
  return (
    <ResourcePage
      path="/products" feature="products" noun="product" search="Search name, SKU or barcode"
      fields={productFields} defaults={productDefaults}
      params={{ top_level: true }}
      rowTo={(p: any) => `/products/${p.id}`}
      filters={[
        { key: 'category_id', label: 'All categories', options: (lk?.product_categories ?? []).map((c) => ({ value: c.id, label: c.name! })) },
        { key: 'type', label: 'All types', options: TYPES },
        { key: 'kind', label: 'All kinds', options: KINDS },
        { key: 'status', label: 'Any status', options: STATUSES },
      ]}
      empty="No products yet"
      columns={[
        { key: 'name', label: 'Product', sort: 'name', render: (p: any) => (
          <div className="flex items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-wine-50 text-wine-600"><Package className="size-4" /></span>
            <div className="min-w-0"><p className="truncate font-medium">{p.name}</p><p className="text-[12px] text-muted">{p.sku}</p></div>
          </div>
        ) },
        { key: 'category_id', label: 'Category', render: (p: any) => (p.category_id ? cat(p.category_id) : '—') },
        { key: 'type', label: 'Type', render: (p: any) => <span className="text-ink-2">{label(p.type)}{p.kind !== 'standard' && <Badge tone="brand" className="ml-2">{label(p.kind)}</Badge>}</span> },
        { key: 'barcode', label: 'Barcode', render: (p: any) => <span className="tabular text-ink-2">{p.barcode ?? '—'}</span> },
        { key: 'status', label: 'Status', render: (p: any) => <Status value={p.status} /> },
      ]}
    />
  )
}
