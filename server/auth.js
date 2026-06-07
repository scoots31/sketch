import crypto from 'node:crypto'

// Shared-secret agent auth. Ported from the proven bench design
// (han-solo .sketch-sandbox/auth-proof.js, 5/5). An agent signs each request
// HMAC-SHA256 over "agent_id:timestamp:body" with a secret shared between Sketch
// and han-solo/Letta. Validated locally — no call back to Letta. Every failure
// fails LOUD with a named reason, never a silent reject.

const SECRET = process.env.SKETCH_AUTH_SECRET || ''
const CLOCK_WINDOW_MS = 5 * 60 * 1000 // 5 minutes — replay guard + clock-skew flag

// Hand-kept whitelist for v1 (open thread: sync from Letta later).
// SKETCH_AGENTS is a comma-separated list of trusted agent ids.
const WHITELIST = new Set(
  (process.env.SKETCH_AGENTS || 'ren,maya,kate,recon,claude')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
)

export function sign(secret, agentId, timestamp, body) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${agentId}:${timestamp}:${body}`)
    .digest('hex')
}

// Returns { ok: true, agentId } or { ok: false, status, reason }.
export function verify(header, rawBody, now) {
  if (!SECRET) {
    return { ok: false, status: 503, reason: 'auth not configured (no secret)' }
  }
  if (!header) {
    return { ok: false, status: 401, reason: 'missing Sketch-Auth header' }
  }

  let agentId, ts, sig
  try {
    const parts = Object.fromEntries(
      header.split(',').map((kv) => {
        const i = kv.indexOf('=')
        if (i === -1) throw new Error('no =')
        return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]
      })
    )
    agentId = parts.agent_id
    ts = parts.ts
    sig = parts.sig
    if (!agentId || !ts || !sig) throw new Error('missing field')
    if (!/^[0-9a-f]{64}$/.test(sig)) throw new Error('sig not sha256 hex')
  } catch {
    return { ok: false, status: 400, reason: 'malformed signature format' }
  }

  if (!WHITELIST.has(agentId)) {
    return { ok: false, status: 403, reason: 'agent_id not registered' }
  }

  const tsNum = Number(ts)
  const delta = now - tsNum
  if (!Number.isFinite(tsNum) || Math.abs(delta) > CLOCK_WINDOW_MS) {
    return {
      ok: false,
      status: 403,
      reason: 'timestamp expired',
      detail: `client: ${tsNum}, server: ${now}, delta: ${delta}ms (window ±${CLOCK_WINDOW_MS}ms)`,
    }
  }

  const expected = sign(SECRET, agentId, ts, rawBody)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  const match = a.length === b.length && crypto.timingSafeEqual(a, b)
  if (!match) {
    return { ok: false, status: 403, reason: 'hmac mismatch' }
  }

  return { ok: true, agentId }
}

// Express middleware. The raw body must be captured for signing — see index.js
// (express.json with a verify hook stores req.rawBody).
export function requireAgentAuth(req, res, next) {
  const result = verify(req.headers['sketch-auth'], req.rawBody || '', Date.now())
  if (!result.ok) {
    return res
      .status(result.status)
      .json({ auth: 'rejected', reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) })
  }
  req.agentId = result.agentId
  next()
}
