/** fetch wrapper for the FastAPI backend. Errors arrive as {code, message, fields}. */

export const API = '/api'

export class ApiError extends Error {
  status: number
  code: string
  fields: Record<string, string>
  constructor(status: number, code: string, message: string, fields: Record<string, string> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.fields = fields
  }
}

type Params = Record<string, string | number | boolean | null | undefined>

export function qs(params?: Params) {
  if (!params) return ''
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v))
  const out = s.toString()
  return out ? `?${out}` : ''
}

export const url = (path: string, params?: Params) => `${API}${path}${qs(params)}`

let onUnauthorized: () => void = () => {}
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn)

export async function request<T = any>(method: string, path: string, body?: unknown, params?: Params): Promise<T> {
  const isForm = body instanceof FormData
  const res = await fetch(url(path, params), {
    method,
    credentials: 'include',
    headers: body === undefined || isForm ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  })
  if (res.status === 204) return undefined as T
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : undefined
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized()
    throw new ApiError(res.status, data?.code ?? 'error', data?.message ?? res.statusText, data?.fields ?? {})
  }
  return data as T
}

export const api = {
  get: <T = any>(path: string, params?: Params) => request<T>('GET', path, undefined, params),
  post: <T = any>(path: string, body?: unknown, params?: Params) => request<T>('POST', path, body ?? {}, params),
  put: <T = any>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T = any>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T = any>(path: string) => request<T>('DELETE', path),
}

export type Page<T> = { items: T[]; total: number; page: number; page_size: number }

/** Lists come back paged ({items,total}) or as a plain array; treat both alike. */
export function asPage<T>(data: Page<T> | T[] | undefined): Page<T> {
  if (!data) return { items: [], total: 0, page: 1, page_size: 50 }
  if (Array.isArray(data)) return { items: data, total: data.length, page: 1, page_size: data.length || 50 }
  return data
}

/** Open a PDF / file endpoint in a new tab (cookie auth rides along). */
export const openFile = (path: string, params?: Params) => window.open(url(path, params), '_blank', 'noopener')
