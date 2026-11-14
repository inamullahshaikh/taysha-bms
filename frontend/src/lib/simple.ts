import { useSyncExternalStore } from 'react'

/** Simple mode: big buttons and a short menu for a small team. On unless someone switches to the full system. */
const KEY = 'taysha.simple'
const listeners = new Set<() => void>()
let mem = true // used when the browser blocks storage

function read() {
  try { return localStorage.getItem(KEY) !== 'off' } catch { return mem }
}

export function setSimple(on: boolean) {
  mem = on
  try { localStorage.setItem(KEY, on ? 'on' : 'off') } catch { /* blocked storage: lasts until reload */ }
  listeners.forEach((l) => l())
}

export function useSimple() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, read)
}
