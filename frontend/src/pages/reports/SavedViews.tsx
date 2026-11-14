import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { Button, Checkbox, Field, IconButton, Input, Menu, MenuItem, Modal } from '../../ui/kit'
import { useToast } from '../../ui/toast'

/** Save the report's URL filters under a name, and re-apply them later. */
export function SavedViews({ report }: { report: string }) {
  const [sp, setSp] = useSearchParams()
  const qc = useQueryClient()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const key = ['/saved-views', report]
  const { data = [] } = useQuery({ queryKey: key, queryFn: () => api.get<any[]>('/saved-views', { report }) })

  const save = async () => {
    await api.post('/saved-views', { name: name.trim(), report, params: Object.fromEntries(sp), shared })
    toast('View saved')
    qc.invalidateQueries({ queryKey: key })
    setOpen(false); setName('')
  }

  return (
    <>
      <Menu trigger={<Button size="sm" icon={<Bookmark className="size-3.5" />}>Views</Button>}>
        <div className="w-64">
          {data.length === 0 && <p className="px-2.5 py-2 text-[12.5px] text-muted">No saved views yet</p>}
          {data.map((v) => (
            <div key={v.id} className="flex items-center">
              <div className="min-w-0 flex-1">
                <MenuItem onClick={() => setSp(new URLSearchParams(v.params), { replace: true })}>
                  <span className="truncate">{v.name}</span>
                  {!v.mine && <span className="ml-auto text-[11px] text-muted">shared</span>}
                </MenuItem>
              </div>
              {v.mine && (
                <IconButton label={`Delete ${v.name}`} onClick={async (e) => {
                  e.stopPropagation()
                  await api.del(`/saved-views/${v.id}`)
                  qc.invalidateQueries({ queryKey: key })
                }}><Trash2 className="size-3.5" /></IconButton>
              )}
            </div>
          ))}
          <div className="mt-1 border-t border-line pt-1">
            <MenuItem onClick={() => setOpen(true)}>Save current view…</MenuItem>
          </div>
        </div>
      </Menu>
      <Modal open={open} onClose={() => setOpen(false)} title="Save this view"
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim()} onClick={save}>Save</Button></>}>
        <div className="flex flex-col gap-3">
          <Field label="Name" htmlFor="view-name"><Input id="view-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Checkbox label="Share with everyone who can see this report" checked={shared} onChange={(e) => setShared(e.target.checked)} />
        </div>
      </Modal>
    </>
  )
}
