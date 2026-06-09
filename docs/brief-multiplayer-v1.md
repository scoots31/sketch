# Build Brief — Sketch Multiplayer v1

**Slice:** Sketch real-time co-drawing (roadmap step 5: "Multiplayer — real-time co-drawing, broadcast + collision")
**Repo:** `~/Developer/sketch` (separate service from han-solo; deploys to its own Render web service)
**Date scoped:** 2026-06-08
**Scoped by:** Scott + Claude + Ren

---

## One-sentence goal

Two people can draw on the same sketch at the same time and both see every change live, with neither person's work silently clobbering the other's.

---

## Why this, why now

Today Sketch is single-player with asynchronous agent writes. Each open browser holds its own copy of a sketch and autosaves the whole document back on a debounce — **last write wins**. If two people open the same sketch, they diverge silently and the last save erases the other's work. Agent drawings only appear on a human's next reload. For a "permanent place work lives" that Scott, Ren, and Claude share, that's the core gap. This slice closes it.

---

## Current architecture (verified by reading the code, 2026-06-08)

- **Storage:** one Postgres `document` column per sketch holding the full tldraw store snapshot (`{store, schema}`).
- **Browser** (`src/SketchCanvas.jsx`): loads the blob on mount via `loadSnapshot`, then listens for `{source:'user', scope:'document'}` changes and autosaves the entire `getSnapshot` back through `PUT /api/sketches/:id/document` on a 700ms debounce. No live connection between browsers.
- **Agents** (`server/routes/agent.js` → `server/shapes.js`): `POST /api/agent/sketches/:id/draw` does a read-modify-write on the same blob. `drawShapes()` builds genuine headless tldraw `geo` records (verified working live as `as_agent` on 2026-06-08) and appends them; existing shapes are preserved. Returns a digest the agent trusts as proof the shapes landed.
- **Server** (`server/index.js`): single Express process, serves the built client + the API on one port. One Render web service. Its own Postgres (not shared with han-solo).

---

## Step 1 outcome — resolved decisions (Claude + Ren, 2026-06-08)

- **Packages:** `@tldraw/sync` (client `useSync`) + `@tldraw/sync-core` (server `TLSocketRoom`), both pinned to `3.15.6` to match installed tldraw.
- **Agent injection seam confirmed:** `room.updateStore(async (store) => { store.put(record) })` — server-side store mutation that takes the exact genuine `geo` records `drawShapes()` already produces. `drawShapes` stays unchanged; its output is routed into the room when one is live.
- **Persistence hooks:** constructor `onDataChange` (fires on change), `room.getCurrentSnapshot()` (RoomSnapshot), `room.loadSnapshot()` (accepts both RoomSnapshot and `{store, schema}`).
- **Storage format — DECIDED: keep `{store, schema}` (TLStoreSnapshot) in Postgres.** Convert only at the room boundary: seed the room with `loadSnapshot({store, schema})`; on flush, convert `getCurrentSnapshot()` (RoomSnapshot) → `{store, schema}` before writing. This keeps the human GET endpoint, `drawShapes`, and the agent no-room fallback path 100% unchanged — smallest blast radius, verified path untouched. Rejected: switching the stored format to RoomSnapshot (would force changes to every reader incl. the verified agent path).
- **Dropping clock/tombstones on persist is safe.** They only reconcile deltas within a live room's lifetime; tldraw reconnects via full snapshot, not incremental delta, so a stale-clock client just pulls the current document. No cross-session dependency on them.
- **Observability:** the `sketches.updated_at` column already stamps every write, covering Ren's "when did persist happen" debugging ask — no document-shape or schema change needed.
- **Still to confirm in step 2 (mechanical, doesn't affect the above):** socket handshake method names (`handleSocketConnect` / message / close), and a minimal no-op asset store for `useSync` (v1 has no image uploads).

---

## Approach (agreed: tldraw official sync)

Adopt tldraw's official multiplayer — `@tldraw/sync` (client) + `@tldraw/sync-core` (server `TLSocketRoom`). This is the purpose-built answer: conflict-free merge of concurrent edits, live presence available, and persistence via callbacks. Rejected alternatives: rolling our own WebSocket broadcast (reinvents merge/presence, fragile) and a yjs CRDT layer (heavier, less natural with tldraw than tldraw's own sync).

### What changes

**1. Server — a live room per sketch.**
- Stand up a WebSocket endpoint that hosts one `TLSocketRoom` per open sketch, keyed by sketch id.
- On first connection to a sketch: load the Postgres blob and seed the room's initial snapshot. (Handle the never-opened case the same way `drawShapes` does — a null document seeds the tldraw base store.)
- Persist the room snapshot back to Postgres on a debounce **and** on last-disconnect, so durability matches the "permanent place" promise.
- Respect the existing privacy flag: a private sketch is not a joinable room for agents (humans already have their own open routes; keep parity with current 403 behavior on the agent side).

**2. Client — swap blob load/save for the sync hook.**
- Replace the mount-load-snapshot + debounced-save-snapshot logic in `SketchCanvas.jsx` with tldraw's `useSync` (or equivalent) pointing at the room's WebSocket URL for that sketch id.
- Keep the existing top-left chrome (back button, name, status). The status indicator can reflect connection state instead of save state.

**3. Agent draw endpoint — inject into the live room (the load-bearing seam).**
This is the part to get right and the part most likely to break the verified agent path. Do not break it.
- On `POST /api/agent/sketches/:id/draw`: build the records with the existing `drawShapes()` exactly as today (the spec → record translation does not change).
- **If a live room is loaded for that sketch:** inject the new records into the room's in-memory store so connected humans see them instantly, mark the room dirty, and **synchronously flush the room to Postgres before returning the digest.**
- **If no room is loaded (nobody connected):** fall back to the current blob read-modify-write path, unchanged.
- Either way, the digest the agent receives is the same shape as today, and by the time `draw()` returns, the shapes are durable on disk.

### The durability guarantee — preserve it exactly

Today the contract is: **when `draw()` returns, the shape is on disk.** A naive room-inject breaks this — the room would persist later on its debounce, so a disconnect or process restart in that window would lose the agent's shape (Ren caught this). The synchronous dirty-flush in the agent path above is what preserves the guarantee. This is mandatory, not optional.

> Note for the operational record: the **agent-visible tool contract does not change** (same specs in, same digest out, skills untouched). What changes underneath is the durability *mechanism* — a shape is now made durable by an explicit flush at draw time rather than by a blob overwrite. Document this in the gate brief so it's understood operationally even though the interface is identical.

---

## Out of scope for v1 (deliberately deferred)

- **Presence / live cursors** — seeing *where* each person is drawing. Real UI value, but it's a second axis of complexity (position tracking, broadcast, disconnect cleanup) that muddies v1's acceptance test. Ship merge first; add presence in v2 once real use shows it's needed.
- **Collision / z-order rules** between human and agent shapes. Default tldraw merge behavior (both shapes land, no override) is what we want for v1. Confirm this during build (see open item) before assuming it.
- **Horizontal scale / sticky routing.** `TLSocketRoom` is in-memory, so all editors of a sketch must hit the same process. Render runs Sketch single-instance, so this is correct today. If Sketch ever scales to multiple instances, sticky routing is required — known future debt, not this slice.
- **Room eviction race guard (Ren-reviewed defer, step 2).** On last disconnect the room flushes then evicts from the registry; a new connection arriving in that gap could be handed the about-to-be-evicted room. Window is narrow, failure is recoverable (new client reconnects to fresh Postgres state — no data loss), and there's no concurrent-session coverage to test a guard against yet. v2: add a guard that cancels eviction if `getNumActiveSessions() > 0` at delete time. Watch logs after ship.

---

## Open item to resolve during build (≤30 min, before committing the approach)

Confirm what `@tldraw/sync`'s merge does when a human and an agent draw **overlapping** areas of the same sketch. Expected: both shapes land, no collision rule. If that holds, no action. If we'd ever want a rule (e.g. "agent shapes behind human shapes"), that's custom injection logic — flag to Scott, do not build silently.

---

## Done criteria (acceptance tests — proof, not assertion)

1. **Two humans, live merge:** two browsers open the same sketch; each draws a shape; both shapes appear in both browsers within a second, and neither is lost. Verify by independent read-back of the persisted document after both disconnect.
2. **Durability across disconnect:** draw in browser A, close it, open the sketch fresh in browser B — A's shapes are present (room persisted on last-disconnect).
3. **Agent draw appears live:** with a human connected, an agent `draw()` call's shapes appear in the connected browser without a reload, and the digest returns as before.
4. **Agent durability preserved:** immediately after an agent `draw()` returns, the shape is present in Postgres (independent read-back through the human GET endpoint, the same verification used on 2026-06-08) — even if the connected human then disconnects.
5. **No-room fallback intact:** an agent `draw()` on a sketch with nobody connected still lands and is durable (the existing verified path is unbroken).
6. **Regression:** the agent draw path verified on 2026-06-08 (specs → genuine `geo` records, attributed `by` the calling persona) still passes exactly.

---

## Files in play

- `server/index.js` — wire up the WebSocket / room endpoint.
- `server/routes/agent.js` — branch the draw route: inject-into-room + synchronous flush vs. blob RMW fallback.
- `server/db.js` — persistence helpers for room load/flush (likely reuse existing query).
- `src/SketchCanvas.jsx` — swap load/save for the sync hook.
- `src/api.js` — room URL plumbing if needed.
- `package.json` — add `@tldraw/sync` / `@tldraw/sync-core`.
- `server/shapes.js` — **unchanged.** The spec→record translation stays exactly as verified.

## Skills

Unchanged. The agent draw contract is identical; the shape doesn't care whether it lands in a live room or a blob. No edits to maya/kate/recon skills for this slice.
