import { useLookupName } from '../../lib/hooks'
import { ResourcePage } from '../../ui/Resource'

export default function Categories() {
  const cat = useLookupName('product_categories')
  return (
    <ResourcePage
      path="/product-categories" feature="products" noun="category"
      fields={[
        { name: 'name', label: 'Name', required: true, full: true },
        { name: 'parent_id', label: 'Inside', type: 'lookup', lookup: 'product_categories', full: true, hint: 'Leave empty for a top-level category' },
      ]}
      columns={[
        { key: 'name', label: 'Category', render: (c: any) => <span className="font-medium">{c.name}</span> },
        { key: 'parent_id', label: 'Inside', render: (c: any) => (c.parent_id ? cat(c.parent_id) : '—') },
      ]}
    />
  )
}
