import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Download, FileText, History as HistoryIcon, Paperclip, Upload, X } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api, url } from '../lib/api'
import { ago, dateTime, label } from '../lib/format'
import { useRefMap } from '../lib/hooks'
import { useToast } from './toast'
import { Card, cx, Empty, IconButton, Spinner } from './kit'

/** Header for a record page: back link, title, status, actions. */
export function RecordHeader({ back, backLabel, title, meta, status, actions }: {
  back: string; backLabel: string; title: ReactNode; meta?: ReactNode; status?: ReactNode; actions?: ReactNode
}) {
  return (
    <div className="mb-5">
      <Link to={back} className="mb-3 inline-flex items-center gap-1 text-[12.5px] text-ink-2 hover:text-wine-800">
        <ArrowLeft className="size-3.5" />{backLabel}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-display text-[26px] leading-tight text-wine-800">{title}</h1>
            {status}
          </div>
          {meta && <p className="mt-1 text-[13px] text-ink-2">{meta}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}

/** Two-column record layout: main content + side panels. */
export function RecordLayout({ main, side }: { main: ReactNode; side?: ReactNode }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-4">{main}</div>
      {side && <aside className="flex min-w-0 flex-col gap-4">{side}</aside>}
    </div>
  )
}

const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** Files attached to any record (access is checked against the parent record). */
export function Attachments({ entity, id, canEdit = true }: { entity: string; id: number; canEdit?: boolean }) {
  const qc = useQueryClient()
  const toast = useToast()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const key = ['/attachments', entity, id]
  const { data, isLoading } = useQuery({ queryKey: key, queryFn: () => api.get<any[]>('/attachments', { entity_type: entity, entity_id: id }) })

  const upload = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true)
    try {
      for (const f of Array.from(files)) {
        const fd = new FormData()
        fd.append('file', f)
        await api.post(`/attachments`, fd, { entity_type: entity, entity_id: id })
      }
      toast(files.length > 1 ? `${files.length} files uploaded` : 'File uploaded')
      qc.invalidateQueries({ queryKey: key })
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Upload failed', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title={<span className="flex items-center gap-1.5"><Paperclip className="size-4 text-muted" />Files</span>} pad={false}>
      {isLoading ? <div className="p-4"><Spinner /></div> : (
        <ul className="divide-y divide-line">
          {(data ?? []).map((a) => (
            <li key={a.id} className="flex items-center gap-2.5 px-4 py-2.5">
              <FileText className="size-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <a href={url(`/attachments/${a.id}/download`)} className="block truncate text-[13px] text-ink hover:text-wine-800">{a.filename}</a>
                <p className="text-[11.5px] text-muted">{kb(a.size)} · {a.version > 1 ? `v${a.version} · ` : ''}{ago(a.created_at)}</p>
              </div>
              <a href={url(`/attachments/${a.id}/download`)} aria-label={`Download ${a.filename}`}
                className="inline-flex size-8 items-center justify-center rounded-lg text-ink-2 hover:bg-sunken"><Download className="size-4" /></a>
              {canEdit && (
                <IconButton label="Remove file" onClick={async () => {
                  await api.post(`/attachments/${a.id}/archive`)
                  qc.invalidateQueries({ queryKey: key })
                }}><X className="size-4" /></IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="p-3">
          <button type="button" onClick={() => input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files) }}
            className={cx('flex w-full items-center justify-center gap-2 rounded-lg border border-dashed py-3 text-[12.5px] transition',
              over ? 'border-wine-600 bg-wine-50 text-wine-800' : 'border-line-strong text-ink-2 hover:border-wine-200 hover:text-ink')}>
            {busy ? <Spinner className="size-4" /> : <Upload className="size-4" />}
            Drop files or browse
          </button>
          <input ref={input} type="file" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = '' }} />
        </div>
      )}
    </Card>
  )
}

const SKIP = new Set(['id', 'created_at', 'updated_at', 'created_by_id', 'archived_at'])

/** Who changed what and when, from the audit log. */
export function History({ entity, id }: { entity: string; id: number }) {
  const userName = useRefMap('/users')
  const { data, isLoading } = useQuery({
    queryKey: ['/audit', entity, id],
    queryFn: () => api.get<any[]>('/audit', { entity_type: entity, entity_id: id, limit: 50 }),
    retry: false,
  })
  return (
    <Card title={<span className="flex items-center gap-1.5"><HistoryIcon className="size-4 text-muted" />History</span>} pad={false}>
      {isLoading ? <div className="p-4"><Spinner /></div> : !data?.length ? (
        <Empty title="No history yet" />
      ) : (
        <ol className="scroll-quiet max-h-96 overflow-y-auto px-4 py-3">
          {data.map((e) => {
            const changed = e.after && e.before
              ? Object.keys(e.after).filter((k) => !SKIP.has(k) && JSON.stringify(e.after[k]) !== JSON.stringify(e.before?.[k]))
              : []
            return (
              <li key={e.id} className="relative border-l border-line pb-3.5 pl-4 last:pb-0">
                <span className="absolute top-1.5 -left-[4.5px] size-2 rounded-full bg-wine-200 ring-2 ring-surface" />
                <p className="text-[13px] text-ink">
                  <span className="font-medium">{e.user_id ? userName(e.user_id) : e.source === 'system' ? 'System' : label(e.source)}</span>{' '}
                  {label(e.action).toLowerCase()}
                  {changed.length > 0 && <span className="text-ink-2"> {changed.slice(0, 3).map((k) => label(k).toLowerCase()).join(', ')}{changed.length > 3 && ` +${changed.length - 3}`}</span>}
                </p>
                {e.note && <p className="text-[12px] text-ink-2">{e.note}</p>}
                <p className="text-[11.5px] text-muted" title={dateTime(e.at)}>{ago(e.at)}{e.source !== 'web' && e.source !== 'system' ? ` · ${label(e.source)}` : ''}</p>
              </li>
            )
          })}
        </ol>
      )}
    </Card>
  )
}
