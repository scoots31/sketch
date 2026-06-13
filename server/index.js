import express from 'express'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocketServer } from 'ws'
import { initSchema } from './db.js'
import { sketches } from './routes/sketches.js'
import { agent } from './routes/agent.js'
import { handleSocketConnection } from './rooms.js'
import { addClient } from './notify.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
// Capture the raw body so agent requests can be HMAC-verified over the exact bytes.
app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8') } }))

app.get('/api/health', (_req, res) => res.json({ ok: true }))
app.use('/api/sketches', sketches) // human/browser — open for v1
app.use('/api/agent', agent) // agents — shared-secret auth required

// SSE draw-event notifications — canvas subscribes here for agent-draw feedback.
app.get('/api/notify/:sketchId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const remove = addClient(req.params.sketchId, res)
  req.on('close', remove)
})

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

// Multiplayer: a WebSocket per sketch room, on the same HTTP server. tldraw's
// useSync connects to wss://host/connect/<sketchId>?sessionId=<id>; we route the
// upgrade to that sketch's room. Until the client uses sync (next step), nothing
// connects here, so this is dormant capability — the live save path is unchanged.
const server = createServer(app)
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost')
  const match = url.pathname.match(/^\/connect\/([^/]+)$/)
  if (!match) {
    socket.destroy()
    return
  }
  const sketchId = match[1]
  const sessionId = url.searchParams.get('sessionId') || randomUUID()
  wss.handleUpgrade(req, socket, head, (ws) => {
    handleSocketConnection(ws, sketchId, sessionId).catch((e) => {
      console.error('[sketch] ws connect failed:', sketchId, e.message)
      ws.close()
    })
  })
})

const port = process.env.PORT || 3000
initSchema()
  .then(() => {
    server.listen(port, () => console.log(`[sketch] listening on ${port}`))
  })
  .catch((e) => {
    console.error('[sketch] failed to init schema:', e.message)
    process.exit(1)
  })
