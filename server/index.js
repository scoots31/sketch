import express from 'express'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initSchema } from './db.js'
import { sketches } from './routes/sketches.js'
import { agent } from './routes/agent.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
// Capture the raw body so agent requests can be HMAC-verified over the exact bytes.
app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8') } }))

app.get('/api/health', (_req, res) => res.json({ ok: true }))
app.use('/api/sketches', sketches) // human/browser — open for v1
app.use('/api/agent', agent) // agents — shared-secret auth required

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
