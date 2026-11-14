import { CircleAlert, CircleCheck } from 'lucide-react'
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

type Toast = { id: number; text: string; kind: 'ok' | 'error' }
const Ctx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const push = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = Date.now() + Math.random()
    setItems((t) => [...t, { id, text, kind }])
    setTimeout(() => setItems((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000)
  }, [])
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            className="anim-rise flex max-w-md items-center gap-2 rounded-lg bg-wine-950 px-3.5 py-2.5 text-[13px] text-cream shadow-pop"
          >
            {t.kind === 'error' ? (
              <CircleAlert className="size-4 shrink-0 text-[#f5a99f]" />
            ) : (
              <CircleCheck className="size-4 shrink-0 text-[#8fd8b6]" />
            )}
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

export const useToast = () => useContext(Ctx)
