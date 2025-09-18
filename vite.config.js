import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // psd’s main file points to .coffee; use the dist bundle instead
    exclude: ["psd", "psd/dist/psd.js"],
  },
  build: {
    commonjsOptions: { transformMixedEsModules: true },
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,            // 👈 importante para WebSocket
        secure: false,
      },
    },
  },
})
