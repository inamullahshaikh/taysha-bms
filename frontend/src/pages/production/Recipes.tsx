import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { useCan } from '../../lib/auth'
import { date, qty } from '../../lib/format'
import { useRefMap } from '../../lib/hooks'
import { DataTable } from '../../ui/DataTable'
import { PRODUCTS } from '../../ui/Form'
import { Button, Status } from '../../ui/kit'
import { FormDrawer } from '../../ui/Resource'

export default function Recipes() {
  const can = useCan()
  const navigate = useNavigate()
  const product = useRefMap('/products')
  const [creating, setCreating] = useState(false)
  return (
    <>
      <DataTable
        path="/recipes"
        search={false}
        rowTo={(r: any) => `/recipes/${r.id}`}
        filters={[{ key: 'status', label: 'Status', options: ['active', 'draft', 'superseded'] }]}
        empty={{ title: 'No recipes yet', body: 'A recipe lists what goes into one batch. Production orders use the active version.' }}
        toolbar={can('recipes', 'edit') && <Button variant="primary" size="sm" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New recipe</Button>}
        columns={[
          { key: 'product', label: 'Product', render: (r: any) => <span className="font-medium">{product(r.product_id)}</span> },
          { key: 'version', label: 'Version', sort: 'version', render: (r: any) => `v${r.version}` },
          { key: 'status', label: 'Status', render: (r: any) => <Status value={r.status} /> },
          { key: 'yield', label: 'Batch yield', align: 'right', render: (r: any) => qty(r.yield_quantity) },
          { key: 'lines', label: 'Items', align: 'right', render: (r: any) => r.lines.length },
          { key: 'approved_at', label: 'Approved', render: (r: any) => date(r.approved_at) },
        ]}
      />
      <FormDrawer open={creating} onClose={() => setCreating(false)} title="New recipe" submitLabel="Create draft"
        fields={[
          { name: 'product_id', label: 'Product made', type: 'record', record: { ...PRODUCTS, params: { type: 'finished' } }, required: true, full: true },
          { name: 'yield_quantity', label: 'Units per batch', type: 'number', required: true },
          { name: 'labour_minutes', label: 'Labour minutes per batch', type: 'number' },
        ]}
        submit={async (body) => {
          const r = await api.post('/recipes', { ...body, lines: [] })
          navigate(`/recipes/${r.id}`)
        }} />
    </>
  )
}
