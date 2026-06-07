import express from 'express'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initSchema } from './db.js'
import { sketches } from './routes/sketches.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '10mb' })) // tldraw snapshots can be sizeable

app.get('/api/health', (_req, res) => res.json({ ok: true }))
app.use('/api/sketches', sketches)

// In production the same service serves the built client (single Render web service).
const dist = join(__dirname, '..', 'dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html')))
}

// Error handler — never leak a silent 500; name what broke.
app.use((err, _req, res, _next) => {
  console.error('[sketch] error:', err.message)
  res.status(500).json({ error: 'server error', detail: err.message })
})

const port = process.env.PORT || 3000
initSchema()
  .then(() => {
    app.listen(port, () => console.log(`[sketch] listening on ${port}`))
  })
  .catch((e) => {
    console.error('[sketch] failed to init schema:', e.message)
    process.exit(1)
  })
