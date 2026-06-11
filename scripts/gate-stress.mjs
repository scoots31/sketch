// Gate harness — LIVE-ROOM STRESS (Ren's non-negotiable check #1).
//
// Boots the REAL server (child process, test port, local Postgres) and hunts
// silent failure modes through the real HTTP + WebSocket surface:
//   - room residency via a real socket connect (and drop + reconnect mid-run)
//   - rapid-fire sequential agent draws from two different signers
//   - a concurrent burst (parallel draws) — interleaving integrity
//   - the F1 guards: replace-without-flag, agent replace vs live room,
//     human blob-save vs live room — all must refuse loudly
//   - final integrity: every accepted draw present exactly once, durable
//
// Run from the sketch repo:  node scripts/gate-stress.mjs
// Exit 0 = no silent failures; exit 1 otherwise.

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import WebSocket from 'ws'

const PORT = 3101
const BASE = `http://localhost:${PORT}`
const SECRET = 'gate-stress-secret'

let failures = 0
const assert = (ok, what) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${what}`)
  if (!ok) failures++
}

function sign(agentId, body) {
  const ts = String(Date.now())
  const sig = crypto.createHmac('sha256', SECRET)
    .update(`${agentId}:${ts}:${body}`).digest('hex')
  return `agent_id=${agentId},ts=${ts},sig=${sig}`
}

async function agentCall(method, path, agentId, payload) {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'sketch-auth': sign(agentId, body),
    },
    ...(body ? { body } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('booting real server on the test port...')
  const server = spawn('node', ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      SKETCH_AUTH_SECRET: SECRET,
      SKETCH_AGENTS: 'ren,claude',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverLog = ''
  server.stdout.on('data', (d) => (serverLog += d))
  server.stderr.on('data', (d) => (serverLog += d))
  const dead = new Promise((r) => server.on('exit', r))

  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) break
    } catch {}
    await wait(250)
    if (i === 39) throw new Error(`server never came up. log:\n${serverLog}`)
  }
  console.log('server up.')

  try {
    // throwaway sketch
    const created = await fetch(`${BASE}/api/sketches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '__gate-stress__' }),
    }).then((r) => r.json())
    const id = created.id
    console.log(`sketch ${id} created`)

    // make the room resident with a real socket (a human "opening" the sketch)
    let ws = new WebSocket(`ws://localhost:${PORT}/connect/${id}?sessionId=stress-a`)
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
    await wait(300)

    console.log('\nRAPID FIRE — 20 sequential draws, alternating signers')
    let accepted = 0
    for (let i = 0; i < 20; i++) {
      const who = i % 2 ? 'claude' : 'ren'
      const r = await agentCall('POST', `/api/agent/sketches/${id}/draw`, who, {
        shapes: [{ type: 'rectangle', x: i * 40, y: 40, w: 30, h: 30, label: `seq${i}` }],
      })
      if (r.status === 200 && r.json.applied && r.json.live) accepted++
    }
    assert(accepted === 20, `all 20 sequential draws accepted on the LIVE path (got ${accepted})`)

    console.log('\nSOCKET DROP + RECONNECT mid-run — room must survive, then accept more draws')
    ws.terminate()
    await wait(400)
    const afterDrop = await agentCall('POST', `/api/agent/sketches/${id}/draw`, 'ren', {
      shapes: [{ type: 'ellipse', x: 900, y: 40, label: 'after-drop' }],
    })
    assert(afterDrop.status === 200 && afterDrop.json.live === true,
      'draw after socket drop still lands in the resident room (no eviction wipe)')
    ws = new WebSocket(`ws://localhost:${PORT}/connect/${id}?sessionId=stress-b`)
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
    await wait(300)

    console.log('\nCONCURRENT BURST — 10 parallel draws, both signers interleaved')
    const burst = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        agentCall('POST', `/api/agent/sketches/${id}/draw`, i % 2 ? 'claude' : 'ren', {
          shapes: [{ type: 'diamond', x: i * 40, y: 160, w: 30, h: 30, label: `par${i}` }],
        })
      )
    )
    const burstOk = burst.filter((r) => r.status === 200 && r.json.applied).length
    assert(burstOk === 10, `all 10 concurrent draws accepted (got ${burstOk})`)

    console.log('\nF1 GUARDS — every dangerous write must refuse loudly')
    const noFlag = await agentCall('PUT', `/api/agent/sketches/${id}/document`, 'ren',
      { document: { store: {}, schema: {} } })
    assert(noFlag.status === 400 && /does not append/.test(noFlag.json.message || ''),
      'agent replace WITHOUT replace:true → named 400 explaining the contract')
    const liveReplace = await agentCall('PUT', `/api/agent/sketches/${id}/document`, 'ren',
      { document: { store: {}, schema: {} }, replace: true })
    assert(liveReplace.status === 409 && /open live/.test(liveReplace.json.message || ''),
      'agent replace vs LIVE room → named 409 refusal')
    const humanSave = await fetch(`${BASE}/api/sketches/${id}/document`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ document: { store: {}, schema: {} } }),
    })
    const humanJson = await humanSave.json()
    assert(humanSave.status === 409 && /live room/.test(humanJson.error || ''),
      'human blob-save vs LIVE room → named 409 refusal')

    console.log('\nINTEGRITY — wait out the debounce, then read durable truth via the human GET')
    await wait(2600)
    const doc = await fetch(`${BASE}/api/sketches/${id}`).then((r) => r.json())
    const shapes = Object.values(doc.document?.store || {}).filter((r) => r?.typeName === 'shape')
    const labels = shapes.map((s) => {
      try { return s.props.richText.content[0].content[0].text } catch { return '' }
    })
    assert(shapes.length === 31, `exactly 31 shapes durable (20 seq + 1 after-drop + 10 burst), got ${shapes.length}`)
    assert(new Set(labels).size === 31, 'every label unique — nothing duplicated, nothing lost')
    const authors = new Set(shapes.map((s) => s.meta?.author))
    assert(authors.has('ren') && authors.has('claude') && authors.size === 2,
      'authorship survived: every shape attributed, both signers present')

    ws.close()
    await fetch(`${BASE}/api/sketches/${id}`, { method: 'DELETE' }).catch(() => {})
    // room still resident for the deleted sketch is fine — process exits next

    const rollbacks = (serverLog.match(/live-draw rollback/g) || []).length
    assert(rollbacks === 0, 'zero rollbacks during stress (no hidden flush failures)')
  } finally {
    server.kill()
    await dead
  }

  console.log(failures === 0
    ? '\nSTRESS GATE: PASS — no silent failure modes surfaced.'
    : `\nSTRESS GATE: FAIL — ${failures} assertion(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error('harness error:', e); process.exit(1) })
