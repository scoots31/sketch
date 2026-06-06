import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Sketch dev server. Port 5190 to stay clear of the bench (5188) and docs (7700).
export default defineConfig({
  plugins: [react()],
  server: { port: 5190 },
})
