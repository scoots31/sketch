// Multiplayer room registry + durable persistence.
//
// One TLSocketRoom per sketch, held in memory, authoritative for live edits.
// Clients connect over WebSocket; tldraw's sync-core merges concurrent edits
// conflict-free. We bridge the room to Postgres at its boundary ONLY:
//
//   - load:  seed a new room from the stored {store, schema} blob
//   - flush: convert the room's RoomSnapshot back to {store, schema} and save
//
// The stored format stays {store, schema} (TLStoreSnapshot) — the exact shape
// the human GET endpoint, the agent draw path, and drawShapes() already speak.
// Room-only metadata (clock, tombstones) is dropped on flush: tldraw reconnects
// via full snapshot, not incremental delta, so nothing across a reload needs it.
//
// NOTE: TLSocketRoom is in-memory, so every editor of a sketch must reach the
// same process. Sketch runs single-instance on Render today — correct now.
// Horizontal scale would require sticky routing (known, deferred).

import { TLSocketRoom } from '@tldraw/sync-core'
import { createTLSchema } from '@tldraw/tlschema'
import { query } from './db.js'

// Default tldraw schema (includes geo and the rest) — matches what the browser
// and drawShapes() produce, since both run the same tldraw 3.15.6 defaults.
const schema = createTLSchema()

const SAVE_DEBOUNCE_MS = 2000

// sketchId -> { room, saveTimer }. One entry per live room, globally.
const rooms = new Map()

// RoomSnapshot ({ clock, documents:[{state,...}], schema, tombstones }) ->
// the durable {store, schema} blob. documents[].state IS the tldraw record.
function roomToStoreSnapshot(room) {
  const snap = room.getCurrentSnapshot()
  const store = {}
  for (const doc of snap.documents) store[doc.state.id] = doc.state
  return { store, schema: snap.schema }
}

// Flush a room's current state to Postgres. Returns once durable on disk.
// updated_at doubles as the persisted-at signal for "shapes vanished" debugging.
async function persist(sketchId) {
  const entry = rooms.get(sketchId)
  if (!entry) return
  const document = roomToStoreSnapshot(entry.room)
  await query(
    `UPDATE sketches SET document = $1, updated_at = now() WHERE id = $2`,
    [document, sketchId]
  )
}

// Debounced flush — fires on document change while editors are active.
function scheduleSave(sketchId) {
  const entry = rooms.get(sketchId)
  if (!entry) return
  clearTimeout(entry.saveTimer)
  entry.saveTimer = setTimeout(() => {
    persist(sketchId).catch((e) =>
      console.error('[sketch] room persist failed:', sketchId, e.message)
    )
  }, SAVE_DEBOUNCE_MS)
}

// Get the live room for a sketch, or null if none is currently loaded.
// Used by the agent draw path to decide inject-into-room vs. blob fallback.
export function getActiveRoom(sketchId) {
  return rooms.get(sketchId)?.room || null
}

// Force an immediate, awaited flush of a live room to Postgres. The agent draw
// path uses this to keep its durability guarantee: when draw() returns, durable.
export async function flushRoom(sketchId) {
  await persist(sketchId)
}

// Get or create the single room for a sketch. Returns null if the sketch does
// not exist (caller maps to 404). Privacy is enforced by the caller.
export async function getOrCreateRoom(sketchId) {
  const existing = rooms.get(sketchId)
  if (existing) return existing.room

  const { rows } = await query(
    `SELECT document FROM sketches WHERE id = $1`,
    [sketchId]
  )
  if (!rows.length) return null

  const room = new TLSocketRoom({
    schema,
    onDataChange: () => scheduleSave(sketchId),
    onSessionRemoved: (_room, args) => {
      // Keep the room RESIDENT for the process lifetime (v1). Sockets are
      // flaky — a drop briefly takes active sessions to 0, then the client
      // reconnects. If we evicted here, the reconnect would reload an empty/
      // stale blob and wipe in-flight work. Staying resident makes reconnects
      // harmless: the client re-pulls from the same live room. We still flush
      // on last disconnect so a fully-idle sketch is durable; we just don't
      // delete the room. (Memory is negligible at our scale — a few rooms.)
      if (args.numSessionsRemaining === 0) {
        persist(sketchId).catch((e) =>
          console.error('[sketch] last-disconnect flush failed:', sketchId, e.message)
        )
      }
    },
  })

  // Register before seeding so onDataChange during load can find the entry.
  rooms.set(sketchId, { room, saveTimer: null })

  // Seed from the durable blob. loadSnapshot accepts {store, schema} directly.
  // A never-opened sketch (null document) just starts empty.
  if (rows[0].document) {
    room.loadSnapshot(rows[0].document)
  }

  return room
}

// Wire a freshly-upgraded WebSocket into its sketch's room.
//
// The client sends its initial connect message the instant the socket opens.
// Loading the room is async (a Postgres read), so if we awaited before wiring
// the socket, that first message would land with no listener, be dropped, and
// the client would time out and reconnect forever (tldraw issue #5946).
//
// Fix: attach a temporary listener that buffers frames during the async load,
// remove it the moment the room is ready, then let tldraw attach its own
// native message/close/error listeners on the real socket. Finally replay the
// buffered frames via handleSocketMessage. Removal happens synchronously right
// before handleSocketConnect, so the two listeners never both fire on a frame,
// and no frame is dropped. Socket lifecycle (close → session_removed →
// onSessionRemoved eviction) is handled natively by tldraw.
export async function handleSocketConnection(socket, sketchId, sessionId) {
  const pending = []
  const buffer = (event) => pending.push(event.data)
  socket.addEventListener('message', buffer)

  const room = await getOrCreateRoom(sketchId)
  if (!room) {
    socket.removeEventListener('message', buffer)
    socket.close()
    return
  }

  socket.removeEventListener('message', buffer)
  room.handleSocketConnect({ sessionId, socket })
  for (const data of pending) room.handleSocketMessage(sessionId, data)
  pending.length = 0
}
