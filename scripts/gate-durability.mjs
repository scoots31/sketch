// Gate harness — DURABILITY ASSERTION (Ren's non-negotiable check #2).
//
// Proves the live-draw failure contract end to end, in-process against the
// real modules and a real Postgres:
//   success  → shapes visible in the room AND durable in Postgres
//   failure  → NEITHER: injection rolled back, DB untouched, retry-safe error
//
// Output is a human timeline — what a person watching the canvas would see —
// plus hard assertions. Exit 0 = contract holds, exit 1 = it does not.
//
// Run from the sketch repo:  node scripts/gate-durability.mjs
// Uses DATABASE_URL or the local sketch_dev default in server/db.js.

import { query, pool, _testFaults } from '../server/db.js'
import {
  getOrCreateRoom,
  getActiveRoom,
  applyLiveDraw,
  LiveDrawRollback,
} from '../server/rooms.js'

const t0 = Date.now()
const ts = () => `t+${String(Date.now() - t0).padStart(5)}ms`
const say = (line) => console.log(`${ts()}  ${line}`)
let failures = 0
const assert = (ok, what) => {
  console.log(`        ${ok ? 'PASS' : 'FAIL'} — ${what}`)
  if (!ok) failures++
}

const roomShapeIds = (room) =>
  room.getCurrentSnapshot().documents
    .filter((d) => d.state?.typeName === 'shape')
    .map((d) => d.state.id)

async function dbShapeCount(id) {
  const { rows } = await query(`SELECT document FROM sketches WHERE id = $1`, [id])
  const store = rows[0]?.document?.store || {}
  return Object.values(store).filter((r) => r?.typeName === 'shape').length
}

async function main() {
  // a throwaway sketch, clearly marked
  const { rows } = await query(
    `INSERT INTO sketches (name) VALUES ('__gate-durability__') RETURNING id`
  )
  const id = rows[0].id
  say(`sketch created (${id}); loading its live room`)
  const room = await getOrCreateRoom(id)
  assert(getActiveRoom(id) === room, 'room is resident')

  // ---- happy path: visible AND durable -------------------------------------
  say('HAPPY PATH — agent draws one labeled rectangle into the live room')
  const ok = await applyLiveDraw(id, [{ type: 'rectangle', x: 10, y: 10, label: 'durable?' }], 'ren')
  say('draw returned — a watcher saw the shape appear and STAY')
  assert(ok.built.records.length === 1, 'one record injected')
  assert(roomShapeIds(room).length === 1, 'shape present in the live room')
  assert((await dbShapeCount(id)) === 1, 'shape durable in Postgres when the call returns')

  // ---- failure path: neither ------------------------------------------------
  say('FAILURE PATH — injecting a Postgres fault, then the agent draws again')
  _testFaults.failNext = 1
  let err = null
  try {
    await applyLiveDraw(id, [{ type: 'ellipse', x: 200, y: 10, label: 'doomed' }], 'ren')
  } catch (e) {
    err = e
  }
  say('draw returned — a watcher saw the ellipse appear for a moment, then vanish')
  assert(err instanceof LiveDrawRollback, 'failure surfaces as the rollback contract')
  assert(/did not save/.test(err?.message || ''), 'message is the plain-language relay text')
  assert(roomShapeIds(room).length === 1, 'room contains ONLY the prior shape (injection rolled back)')
  assert((await dbShapeCount(id)) === 1, 'Postgres untouched by the failed draw')
  say(`the error an agent would relay verbatim: "${err?.message}"`)

  // ---- retry after heal: the contract's promise ------------------------------
  say('RETRY — fault healed, the agent draws the same ellipse again')
  const retry = await applyLiveDraw(id, [{ type: 'ellipse', x: 200, y: 10, label: 'doomed' }], 'ren')
  assert(retry.built.records.length === 1, 'retry applies cleanly (no duplicate from the failed attempt)')
  assert(roomShapeIds(room).length === 2, 'room has exactly the two intended shapes')
  assert((await dbShapeCount(id)) === 2, 'both durable in Postgres')

  await query(`DELETE FROM sketches WHERE id = $1`, [id])
  say('cleanup done')
  console.log(failures === 0
    ? '\nDURABILITY GATE: PASS — success = visible AND durable; failure = neither; retry-safe.'
    : `\nDURABILITY GATE: FAIL — ${failures} assertion(s) failed.`)
  await pool.end()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('harness error:', e)
  await pool.end().catch(() => {})
  process.exit(1)
})
