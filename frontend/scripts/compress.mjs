// After `vite build`: write .br and .gz next to each text asset, so the server sends them as they are
// (smallest downloads, no compression work per request). Images and fonts are already compressed.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const dir = fileURLToPath(new URL('../dist/', import.meta.url))
const TEXT = /\.(js|css|html|svg|json|txt|webmanifest)$/
let raw = 0, br = 0

function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (TEXT.test(name) && statSync(p).size > 1024) {
      const data = readFileSync(p)
      const b = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
      writeFileSync(`${p}.br`, b)
      writeFileSync(`${p}.gz`, gzipSync(data, { level: 9 }))
      raw += data.length
      br += b.length
    }
  }
}

walk(dir)
console.log(`compressed: ${(raw / 1024).toFixed(0)} KB -> ${(br / 1024).toFixed(0)} KB brotli`)
