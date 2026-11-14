import { useQuery } from '@tanstack/react-query'
import { Camera, ScanBarcode } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError } from '../../lib/api'
import { label } from '../../lib/format'
import { Button, cx, IconButton, Input, Modal } from '../../ui/kit'
import { useToast } from '../../ui/toast'

export type ScanResult =
  | { type: 'product'; product_id: number; name: string; sku: string }
  | { type: 'pack'; product_id: number; name: string; sku: string; pack: string; factor?: string }
  | { type: 'batch'; batch_id: number; batch: string; product_id: number; name: string }
  | { type: 'location'; location_id: number; warehouse_id: number; code: string }

/**
 * Barcode input. USB/Bluetooth scanners type the code and press Enter (keyboard wedge);
 * phones can use the camera where the browser has BarcodeDetector.
 */
export function ScanInput({ onResult, placeholder = 'Scan or type a barcode', autoFocus, className }: {
  onResult: (r: ScanResult) => void; placeholder?: string; autoFocus?: boolean; className?: string
}) {
  const [code, setCode] = useState('')
  const [camera, setCamera] = useState(false)
  const toast = useToast()
  const hasCamera = typeof window !== 'undefined' && 'BarcodeDetector' in window

  const lookup = async (value: string) => {
    const v = value.trim()
    if (!v) return
    try {
      onResult(await api.get<ScanResult>('/barcodes/lookup', { code: v }))
      setCode('')
    } catch (e) {
      toast(e instanceof ApiError && e.status === 404 ? `Nothing found for “${v}”` : 'Lookup failed', 'error')
    }
  }

  return (
    <div className={cx('flex gap-1.5', className)}>
      <div className="relative flex-1">
        <ScanBarcode className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
        <Input className="pl-8" autoFocus={autoFocus} value={code} placeholder={placeholder} aria-label="Barcode"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(code) } }} />
      </div>
      {hasCamera && (
        <IconButton label="Scan with camera" className="h-9 w-9 border border-line-strong" onClick={() => setCamera(true)}>
          <Camera className="size-4" />
        </IconButton>
      )}
      {camera && <CameraScan onClose={() => setCamera(false)} onCode={(c) => { setCamera(false); lookup(c) }} />}
    </div>
  )
}

function CameraScan({ onClose, onCode }: { onClose: () => void; onCode: (code: string) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let stream: MediaStream | undefined
    let timer: number | undefined
    let stopped = false
    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (stopped || !video.current) return
        video.current.srcObject = stream
        await video.current.play()
        const detector = new (window as any).BarcodeDetector()
        const tick = async () => {
          if (stopped || !video.current) return
          const codes = await detector.detect(video.current).catch(() => [])
          if (codes[0]?.rawValue) return onCode(codes[0].rawValue)
          timer = window.setTimeout(tick, 250)
        }
        tick()
      } catch {
        setError('Camera not available. Allow camera access or type the code.')
      }
    })()
    return () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()) }
  }, [onCode])
  return (
    <Modal open onClose={onClose} title="Scan a barcode" footer={<Button onClick={onClose}>Close</Button>}>
      {error ? <p className="text-bad">{error}</p> : <video ref={video} muted playsInline className="aspect-[4/3] w-full rounded-lg bg-ink object-cover" />}
    </Modal>
  )
}

/** Where a stock movement came from, as a link when there's a page for it. */
const REF_PATH: Record<string, string> = {
  goods_receipt: '/goods-receipts', transfer: '/stock/transfers', stock_count: '/stock/counts', return: '/returns',
  production_order: '/production-orders', shipment: '/orders', order: '/orders', pos_event: '/pos/events',
}
export function SourceLink({ m }: { m: { reference_type?: string | null; reference_id?: number | null; reference_number?: string | null } }) {
  if (!m.reference_type) return <span className="text-muted">—</span>
  const text = m.reference_number ?? `${label(m.reference_type)}${m.reference_id ? ` #${m.reference_id}` : ''}`
  const base = REF_PATH[m.reference_type]
  // shipments point at their order only when the backend gives the order number
  return base && m.reference_id && m.reference_type !== 'shipment'
    ? <Link to={`${base}/${m.reference_id}`} onClick={(e) => e.stopPropagation()} className="text-wine-700 hover:underline">{text}</Link>
    : <span className="text-ink-2">{text}</span>
}

/** Server-side inventory & purchasing metrics (the dashboard endpoint is access-aware). */
export function useOpsMetrics() {
  return useQuery({ queryKey: ['/dashboard', 'ops'], queryFn: () => api.get('/dashboard', { range: 'month' }), staleTime: 60_000 })
}

export const STOCK_STATUS: Record<string, { text: string; tone: 'good' | 'warn' | 'bad' | 'info' }> = {
  ok: { text: 'In stock', tone: 'good' },
  low: { text: 'Low', tone: 'warn' },
  out_of_stock: { text: 'Out of stock', tone: 'bad' },
  overstock: { text: 'Overstock', tone: 'info' },
}
