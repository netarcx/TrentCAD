import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Build into ../dist/ui — Fastify serves that directory at GET /
// via @fastify/static.  Same origin as the API means no CORS plumbing.
//
// During dev (`npm run dev` inside server/ui/), Vite serves on :5173
// and proxies /api to the Fastify dev server on :42130, so the admin
// UI gets hot-reload without needing the Fastify side to know about it.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, '../dist/ui'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:42130',
    },
  },
})
