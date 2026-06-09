import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Sketch dev server. Port 5190 to stay clear of the bench (5188) and docs (7700).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5190,
    proxy: {
      '/api': 'http://localhost:3000', // dev: API runs separately on 3000
      '/connect': { target: 'ws://localhost:3000', ws: true }, // multiplayer sockets
    },
  },
})
