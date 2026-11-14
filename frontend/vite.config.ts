import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// The API lives at /api in production (Caddy strips the prefix); the dev server does the same.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: process.env.API_URL ?? 'http://localhost:8010',
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
})
