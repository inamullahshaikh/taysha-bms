import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { api, asPage, ApiError } from './api'
import { useToast } from '../ui/toast'

type Row = { id: number; name?: string; code?: string; [k: string]: any }
export type Lookups = Record<
  | 'sales_channels' | 'price_lists' | 'units' | 'tax_rates' | 'branches' | 'departments'
  | 'product_categories' | 'expense_categories' | 'cost_centres' | 'warehouses' | 'territories' | 'users',
  Row[]
>

/** Lists any signed-in user may read through /lookups even when the full endpoint needs admin access. */
export const FROM_LOOKUPS: Record<string, keyof Lookups> = { '/users': 'users', '/territories': 'territories' }

/** Small dropdown lists any signed-in user may read. */
export function useLookups() {
  // reference lists barely change; settings saves invalidate everything anyway
  return useQuery({ queryKey: ['lookups'], queryFn: () => api.get<Lookups>('/lookups'), staleTime: 30 * 60_000 })
}

export function useLookupName(kind: keyof Lookups) {
  const { data } = useLookups()
  return (id?: number | null) => {
    if (id == null) return '—'
    const r = data?.[kind]?.find((x) => x.id === id)
    return r?.name ?? r?.code ?? `#${id}`
  }
}

/** id → label for a small resource (products, suppliers, users…). One request, cached; empty if no access. */
export function useRefMap(path: string, toLabel: (r: any) => string = (r) => r.name ?? r.number ?? `#${r.id}`) {
  const kind = FROM_LOOKUPS[path]
  const lookups = useLookups()
  const { data } = useQuery({
    queryKey: ['refmap', path],
    queryFn: async () => asPage(await api.get(path, { page_size: 500 })).items,
    staleTime: 10 * 60_000,
    retry: false,
    enabled: !kind,
  })
  const rows = kind ? lookups.data?.[kind] : data
  const map = new Map<number, string>((rows ?? []).map((r: any) => [r.id, toLabel(r)]))
  return (id?: number | null) => (id == null ? '—' : (map.get(id) ?? `#${id}`))
}

export const productLabel = (r: any) => (r.sku ? `${r.name} · ${r.sku}` : r.name)

/** A single value kept in the URL so views are shareable and survive reloads. */
export function useUrlState(key: string, fallback = ''): [string, (v: string) => void] {
  const [sp, setSp] = useSearchParams()
  const value = sp.get(key) ?? fallback
  const set = (v: string) =>
    setSp(
      (prev) => {
        const n = new URLSearchParams(prev)
        if (v && v !== fallback) n.set(key, v)
        else n.delete(key)
        if (key !== 'page') n.delete('page')
        return n
      },
      { replace: true },
    )
  return [value, set]
}

/** Mutation that toasts errors, optionally toasts success, and refreshes the listed query keys. */
export function useAction<TVars = any, TData = any>(
  fn: (v: TVars) => Promise<TData>,
  opts: { success?: string; invalidate?: unknown[][]; onSuccess?: (d: TData, v: TVars) => void } = {},
) {
  const qc = useQueryClient()
  const toast = useToast()
  return useMutation({
    mutationFn: fn,
    onSuccess: (d, v) => {
      if (opts.success) toast(opts.success)
      for (const k of opts.invalidate ?? [[]]) qc.invalidateQueries({ queryKey: k })
      opts.onSuccess?.(d, v)
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Something went wrong', 'error'),
  })
}
