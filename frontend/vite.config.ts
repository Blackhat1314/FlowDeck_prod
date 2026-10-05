import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// `npm run dev` proxies the backend (python run.py) running on :8000
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../backend/static',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'), // landing page  -> /
        auth: resolve(__dirname, 'auth.html'), //   sign in / up  -> /login, /signup
        app: resolve(__dirname, 'app.html'), //     dashboard     -> /app
        admin: resolve(__dirname, 'admin.html'), // admin panel   -> /admin
        legal: resolve(__dirname, 'legal.html'), // privacy, terms -> /privacy, /terms
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
      '/api': 'http://127.0.0.1:8000',
    },
  },
})
