import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, CircleCheck } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, asPage } from '../../lib/api'
import { qty } from '../../lib/format'
import { useLookupName, useRefMap } from '../../lib/hooks'
import { Button, ErrorNote, Input, PageHeader, Spinner, cx } from '../../ui/kit'
import { Done, Pick, SaveBar, Step } from './parts'

const COUNTS = ['1', '2', '3', '4', '5']

/** "We made a batch": pick the product and how many batches; the recipe takes the ingredients out of stock. */
export default function QuickBatch() {
  const qc = useQueryClient()
  const productName = useRefMap('/products')
  const unit = useLookupName('units')
  const [productId, setProductId] = useState<number>()
  const [batches, setBatches] = useState('1')
  const [typing, setTyping] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState<any>(null)

  const recipes = useQuery({
    queryKey: ['/recipes', 'active'],
    queryFn: async () => asPage<any>(await api.get('/recipes', { status: 'active', page_size: 200 })).items,
  })
  const recipe = recipes.data?.find((r) => r.product_id === productId)
  const n = Number(batches) > 0 ? batches : ''
  const check = useQuery({
    queryKey: [`/recipes/${recipe?.id}/check`, n],
    queryFn: () => api.get(`/recipes/${recipe.id}/check`, { batches: n }),
    enabled: !!recipe && !!n,
    placeholderData: (p) => p,
  })
  const short = check.data?.lines.some((l: any) => Number(l.short) > 0)

  const reset = () => { setProductId(undefined); setBatches('1'); setTyping(false); setError(null); setDone(null) }

  const save = async () => {
    setBusy(true); setError(null)
    try {
      setDone(await api.post('/production-orders/quick', { product_id: productId, batches: n }))
      qc.invalidateQueries({ queryKey: ['/stock/balances'] })
      qc.invalidateQueries({ queryKey: ['/production-orders'] })
      window.scrollTo(0, 0)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  if (done) return (
    <Done title="Batch saved" actions={[
      { label: 'Make another batch', onClick: reset, primary: true },
      { label: 'See the batch', to: `/production-orders/${done.id}` },
      { label: 'Back to home', to: '/' },
    ]}>{qty(done.output_quantity)} × {done.product_name} added to stock. The ingredients were taken out.</Done>
  )

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Make a batch" subtitle="Tell us what you made. Ingredients come out of stock and the product goes in." />
      <div className="flex flex-col gap-4">
        <Step n={1} title="What did you make?">
          {recipes.isLoading ? <Spinner /> : !recipes.data?.length ? (
            <p className="text-[14px] text-ink-2">No recipes yet. <Link to="/recipes" className="font-medium text-wine-700 underline">Add a recipe</Link> first, then come back here.</p>
          ) : (
            <Pick value={productId} onChange={setProductId}
              options={recipes.data.map((r) => ({ value: r.product_id, label: productName(r.product_id), sub: `One batch makes ${qty(r.yield_quantity)}` }))} />
          )}
        </Step>

        {recipe && (
          <Step n={2} title="How many batches?">
            <Pick value={typing ? 'other' : batches}
              onChange={(v) => { if (v === 'other') { setTyping(true); setBatches('') } else { setTyping(false); setBatches(v) } }}
              options={[...COUNTS.map((c) => ({ value: c, label: c })), { value: 'other', label: 'Other' }]} />
            {typing && (
              <Input type="number" inputMode="decimal" min="0" autoFocus className="mt-2.5 h-12 text-[16px] sm:max-w-60" placeholder="Number of batches"
                value={batches} onChange={(e) => setBatches(e.target.value)} />
            )}
            {check.data && <p className="mt-3 text-[14px] text-ink-2">That makes <b className="text-ink">{qty(check.data.makes)}</b>.</p>}
          </Step>
        )}

        {recipe && n && (
          <Step n={3} title="Ingredients it uses">
            {!check.data ? <Spinner /> : (
              <ul className="divide-y divide-line">
                {check.data.lines.map((l: any) => {
                  const bad = Number(l.short) > 0
                  return (
                    <li key={l.product_id} className="flex items-center gap-3 py-2.5">
                      {bad ? <CircleAlert className="size-5 shrink-0 text-bad" /> : <CircleCheck className="size-5 shrink-0 text-good" />}
                      <span className="min-w-0 flex-1 text-[14.5px]">{l.name}</span>
                      <span className={cx('tabular text-right text-[13.5px]', bad ? 'font-medium text-bad' : 'text-ink-2')}>
                        {qty(l.needed, unit(l.unit_id))}
                        <span className="block text-[12px] text-muted">{bad ? `short by ${qty(l.short)}` : `${qty(l.available)} in stock`}</span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
            {short && (
              <p className="mt-3 rounded-lg bg-bad-bg px-3 py-2.5 text-[13.5px] text-bad">
                Some ingredients aren't in stock. <Link to="/quick/supplies" className="font-medium underline">Add what you bought</Link> first.
              </p>
            )}
          </Step>
        )}

        {error != null && <ErrorNote error={error} />}
      </div>

      <SaveBar>
        <p className="min-w-0 flex-1 truncate text-[14px] text-ink-2">{recipe ? `${productName(recipe.product_id)} · ${n || '?'} batch${n === '1' ? '' : 'es'}` : 'Pick what you made'}</p>
        <Button variant="primary" className="h-14 px-8 text-[16px]" loading={busy} disabled={!recipe || !n || !check.data || short} onClick={save}>We made it</Button>
      </SaveBar>
    </div>
  )
}
