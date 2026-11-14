import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { useAuth, type Action } from '../../lib/auth'
import { RecordSelect } from '../../ui/Form'
import { Button, Card, Confirm, cx, Loading } from '../../ui/kit'
import { useToast } from '../../ui/toast'

type Feature = { key: string; label: string; actions: Action[] }
const ACTIONS: Action[] = ['view', 'create', 'edit', 'archive', 'approve', 'export']

/** Features grouped the way the sidebar is, so the matrix reads like the app. */
const GROUPS: [string, string[]][] = [
  ['Sales', ['orders', 'order_pricing', 'order_payments', 'invoices', 'customers', 'returns', 'complaints', 'discount_codes', 'pos', 'distribution']],
  ['Products & stock', ['products', 'product_prices', 'product_costs', 'inventory', 'purchasing', 'suppliers', 'supplier_bills']],
  ['Production', ['production', 'recipes', 'quality', 'rnd']],
  ['Money', ['expenses', 'accounting', 'approvals', 'assets', 'partners']],
  ['Growth & reports', ['marketing', 'reports']],
  ['Work', ['tasks', 'documents', 'confidential_documents']],
  ['Admin', ['access_management', 'settings', 'audit', 'automation']],
]

const keyOf = (f: string, a: string) => `${f}.${a}`

export function AccessMatrix({ userId, isOwner }: { userId: number; isOwner: boolean }) {
  const { user, can, refresh } = useAuth()
  const qc = useQueryClient()
  const toast = useToast()
  const editable = can('access_management', 'edit')
  const features = useQuery({ queryKey: ['/access/features'], queryFn: () => api.get<Feature[]>('/access/features') })
  const key = [`/users/${userId}/access`]
  const access = useQuery({ queryKey: key, queryFn: () => api.get<Record<string, string[]>>(`/users/${userId}/access`), enabled: !isOwner })
  const [grants, setGrants] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [copyFrom, setCopyFrom] = useState('')
  const [confirmCopy, setConfirmCopy] = useState(false)

  const original = useMemo(
    () => new Set(Object.entries(access.data ?? {}).flatMap(([f, acts]) => acts.map((a) => keyOf(f, a)))),
    [access.data],
  )
  useEffect(() => setGrants(new Set(original)), [original])

  if (isOwner)
    return (
      <Card title="Access">
        <p className="text-[13.5px] text-ink-2">Owners have full access to every feature, and can approve above company limits. To limit what this person can do, remove the owner role first.</p>
      </Card>
    )
  if (features.isLoading || access.isLoading) return <Card title="Access"><Loading /></Card>

  const list = features.data ?? []
  const byKey = new Map(list.map((f) => [f.key, f]))
  const known = new Set(GROUPS.flatMap(([, ks]) => ks))
  const groups: [string, Feature[]][] = [
    ...GROUPS.map(([g, ks]) => [g, ks.map((k) => byKey.get(k)).filter(Boolean) as Feature[]] as [string, Feature[]]),
    ['Other', list.filter((f) => !known.has(f.key))] as [string, Feature[]],
  ].filter(([, fs]) => fs.length)

  const dirty = grants.size !== original.size || [...grants].some((g) => !original.has(g))

  const setMany = (pairs: [string, Action][], on: boolean) =>
    setGrants((prev) => {
      const n = new Set(prev)
      for (const [f, a] of pairs) {
        if (on) {
          n.add(keyOf(f, a))
          // any other action is useless without seeing the feature
          if (a !== 'view' && byKey.get(f)?.actions.includes('view')) n.add(keyOf(f, 'view'))
        } else {
          n.delete(keyOf(f, a))
          if (a === 'view') for (const x of ACTIONS) n.delete(keyOf(f, x))
        }
      }
      return n
    })

  const rowAll = (f: Feature) => f.actions.every((a) => grants.has(keyOf(f.key, a)))
  const colPairs = (a: Action) => list.filter((f) => f.actions.includes(a)).map((f) => [f.key, a] as [string, Action])
  const colAll = (a: Action) => colPairs(a).every(([f]) => grants.has(keyOf(f, a)))

  const save = async () => {
    setSaving(true)
    try {
      const body: Record<string, string[]> = {}
      for (const g of grants) {
        const [f, a] = g.split('.')
        ;(body[f] ??= []).push(a)
      }
      await api.put(`/users/${userId}/access`, { access: body })
      await qc.invalidateQueries({ queryKey: key })
      if (userId === user.id) await refresh()
      toast('Access saved')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title="Access" pad={false}
      action={editable && (
        <div className="flex items-center gap-2">
          <div className="w-56"><RecordSelect source={{ path: '/users', params: { active: true } }} value={copyFrom} onChange={setCopyFrom} placeholder="Copy access from…" /></div>
          <Button size="sm" icon={<Copy className="size-3.5" />} disabled={!copyFrom || Number(copyFrom) === userId} onClick={() => setConfirmCopy(true)}>Copy</Button>
        </div>
      )}>
      <div className="scroll-quiet max-h-[70vh] overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr>
              <th scope="col" className="border-b border-line px-4 py-2.5 text-left text-[12px] font-medium text-muted">Feature</th>
              {ACTIONS.map((a) => (
                <th key={a} scope="col" className="w-20 border-b border-line px-1 py-2 text-center text-[12px] font-medium text-muted">
                  {editable ? (
                    <button type="button" title={`Toggle ${a} for every feature`} onClick={() => setMany(colPairs(a), !colAll(a))}
                      className="rounded-md px-2 py-0.5 capitalize hover:bg-sunken hover:text-ink">{a}</button>
                  ) : <span className="capitalize">{a}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(([g, fs]) => (
              <Fragment key={g}>
                <tr><td colSpan={7} className="bg-page px-4 pt-3 pb-1.5 text-[11.5px] font-semibold tracking-wide text-ink-2 uppercase">{g}</td></tr>
                {fs.map((f) => (
                  <tr key={f.key} className="hover:bg-wine-50/50">
                    <th scope="row" className="border-b border-line px-4 py-2 text-left font-normal">
                      {editable ? (
                        <button type="button" title="Toggle the whole row" onClick={() => setMany(f.actions.map((a) => [f.key, a]), !rowAll(f))}
                          className="text-left text-ink hover:text-wine-800">{f.label}</button>
                      ) : f.label}
                    </th>
                    {ACTIONS.map((a) => (
                      <td key={a} className="border-b border-line text-center">
                        {f.actions.includes(a) ? (
                          <input type="checkbox" aria-label={`${f.label}: ${a}`} disabled={!editable}
                            className="size-4 cursor-pointer accent-wine-800 disabled:cursor-default"
                            checked={grants.has(keyOf(f.key, a))} onChange={(e) => setMany([[f.key, a]], e.target.checked)} />
                        ) : <span className="text-line-strong" aria-hidden>·</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {editable && (
        <div className={cx('flex items-center justify-end gap-2 border-t border-line px-4 py-3', dirty ? 'bg-wine-50' : 'bg-page')}>
          <p className="mr-auto text-[12.5px] text-ink-2">{dirty ? 'You have unsaved changes. They apply on the person’s next request.' : `${grants.size} permissions granted`}</p>
          <Button size="sm" disabled={!dirty} onClick={() => setGrants(new Set(original))}>Discard</Button>
          <Button size="sm" variant="primary" disabled={!dirty} loading={saving} onClick={save}>Save access</Button>
        </div>
      )}
      <Confirm open={confirmCopy} onClose={() => setConfirmCopy(false)} confirmLabel="Replace access"
        title="Copy access from another user?" body="This replaces everything this person can do with the other user's access."
        onConfirm={async () => {
          try {
            await api.post(`/users/${userId}/access/copy-from/${copyFrom}`)
            await qc.invalidateQueries({ queryKey: key })
            if (userId === user.id) await refresh()
            toast('Access copied')
            setCopyFrom('')
          } catch (e) { toast(e instanceof Error ? e.message : 'Could not copy', 'error') }
          setConfirmCopy(false)
        }} />
    </Card>
  )
}
