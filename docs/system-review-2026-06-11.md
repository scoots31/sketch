# Sketch — full system review and fresh documentation (2026-06-11)

Read top to bottom on branch `sl-002-multiplayer` (f2cbd76) against `main` (9c2732e).
Every server file, the schema, and the client. This document is the current map;
the older brief (`brief-multiplayer-v1.md`) is the historical scoping record.

## What Sketch is

A permanent place visual work lives. One Render web service (its own service and
its own Postgres — nothing shared with han-solo) serving a tldraw canvas app and
its API from a single Express process. Sketches are durable rows: `{store, schema}`
tldraw snapshots in a `document` jsonb column, accumulating forever — opened,
drawn on, reopened. Humans draw in the browser; agents draw through an
HMAC-authenticated API and their shapes appear with author badges.

## The two worlds: main vs. the branch

**main (= production today):** blob world. Every open browser loads the whole
snapshot, autosaves the whole snapshot on a debounce. Last write wins. Agent
draws are read-modify-write on the same blob and appear on the human's next
reload. Single-player with asynchronous agent writes.

**sl-002-multiplayer (built, verified locally, NOT deployed):** room world.
A resident `TLSocketRoom` per sketch is the live authority; browsers connect
over WebSocket (`/connect/:sketchId`) and tldraw's sync-core merges concurrent
edits conflict-free. Postgres is the boundary: rooms seed from the blob on
first connect and flush back to the same `{store, schema}` format (2s debounce
on change, immediate on last disconnect, immediate + awaited on agent draws).
Agent draws inject into the live room and appear on the open canvas instantly.

## File map (branch)

| File | Role |
|---|---|
| `server/index.js` | Express app + WebSocket upgrade routing to rooms; serves built client; raw-body capture for HMAC |
| `server/rooms.js` | Room registry: seed/flush boundary, debounced + last-disconnect + forced flush; rooms resident for process lifetime (deliberate — eviction on zero sessions would wipe in-flight work on flaky reconnects); single-instance assumption documented |
| `server/routes/sketches.js` | Human API, open (no auth) in v1: list/create/open/save/rename/delete |
| `server/routes/agent.js` | Agent API behind HMAC: list/read (privacy-respecting), PUT document, POST draw (live-room path + blob fallback) |
| `server/auth.js` | HMAC-SHA256 shared-secret auth: `agent_id:timestamp:body`, ±5min replay window, env whitelist, timing-safe compare, loud named failures |
| `server/shapes.js` | Spec → genuine tldraw geo records. Tight whitelist (4 geo types, named palette, label cap, 50 shapes/call); no path from caller input to arbitrary record fields. `buildRecords` shared by blob and room paths so shapes are identical either way. `meta.author` frozen at creation |
| `server/db.js` / `schema.sql` | pg pool; idempotent boot schema. One table: `sketches(id, name, document, is_private, owner_id, folder_id, timestamps)` + list/search indexes |
| `src/App.jsx` | Hash routing (`#/s/:id` shareable) |
| `src/SketchCanvas.jsx` | `useSync` live store + status label + author-badge overlay (screen-space, tracks pan/zoom) |
| `src/api.js` | Thin human API client. NOTE: `saveSketch` is dead code on the branch — the sync client never blob-saves |

## The durability guarantee (agent draws, live path)

`POST /api/agent/sketches/:id/draw` with a room resident: build records from the
room's current snapshot → inject → **awaited flush to Postgres → then respond**.
When the call returns success, the shapes are durable, not just in memory.
The tldraw#5946 connect race (first client frames arriving before the async
room load) is handled by buffering frames during load and replaying them.

## Findings — ordered by weight

### F1 — CLOBBER SEAM (new finding, must fix before or at deploy)
Both blob-write routes are **room-unaware** on the branch:
- `PUT /api/sketches/:id/document` (human, open)
- `PUT /api/agent/sketches/:id/document` (agent — this is han-solo's `sketch_write` tool)

If a room is resident, the room is authoritative in memory: a direct blob write
lands in Postgres and is then **silently overwritten by the room's next flush**.
Ren's `sketch_write` while Scott has the sketch open = her write evaporates.
Fix options (gate decision): inject-into-room when one is resident (mirror the
draw path), or refuse with a named error directing to the draw/sync path.
The dead `saveSketch` client code should also be removed so nothing human-side
rides the blob path by accident.

### F2 — durability failure mode is ambiguous (refines Ren's check #2)
On the live draw path, room injection precedes the flush. If the flush THROWS:
the human sees the shapes on canvas, the agent gets a 500, the shapes are not
durable, and a retry would duplicate them. Ren's pre-deploy durability assertion
(force a flush failure, verify nothing is reported durable) should also pin
WHAT the contract is on failure — current behavior is "visible but unsaved,
caller told error" which invites double-draw retries.

### F3 — anonymous full access via the open human surface (security)
Human routes have no auth ("open for v1" — a known, deliberate v1 choice, now
worth revisiting): anyone with the service URL can list every sketch (ids
included), open, overwrite, rename, DELETE. The WebSocket upgrade path has no
auth either, and `is_private` guards only the agent routes — so a private
sketch is hidden from Ren but fully open to any anonymous browser. The repo is
public, so the surface is discoverable. Decision needed alongside the
rotation sitting (it's the same theme: who may touch what, with which secret).

### F4 — hardening notes (no action required for SL-002)
- `db.js` uses `rejectUnauthorized: false` for Render TLS — standard shortcut, real cert verification is the better end state.
- Rooms are resident forever (fine at a few rooms; revisit if sketch count grows).
- Last-disconnect flush is fire-and-forget with console-only error.
- Single-instance assumption (in-memory rooms) is documented in rooms.js; horizontal scale needs sticky routing.

## The path to done (carried from the recovered close-out + this review)

1. **Fix F1** (room-aware blob writes) and decide F2's failure contract.
2. **Ren's pre-deploy gate:** stress the live room locally (rapid draws,
   reconnects, forced flush failures, simulated concurrency); the durability
   assertion including the F2 failure case. Both non-negotiable.
3. **Scott's canary decision:** feature-flag the room model (default off) vs.
   straight swap with rollback (revert to main) standing by.
4. Deploy to Sketch's Render service; verify the full chat-integrated loop in a
   FOCUSED real browser (preview browsers throttle background tabs and drop the
   live socket — recorded as a team lesson, learned the hours-long way).
5. Then the locked slice map continues (per the full 8ddb0dd5 session record,
   which supersedes the close-out's mislabel): **SL-003 = Scott + Ren
   co-editing** (concurrent-edit integrity — Ren's "breaks the whole thing if
   it's not right"), SL-004 = Ted joins (second human), SL-005 = save & exit
   (shared-session teardown, no lingering state).

## The locked product frame (carries over everything technical above)

The product is NOT generic multiplayer. It is: Scott chats with Ren; opening a
sketch from that conversation means she is ALREADY THERE — present and coherent
with the chat context (the chat-first ritual is load-bearing, not etiquette).
Language is "Ren is in this room," never "summon Ren." Scott draws, she sees
it; the conversation flows onto the canvas; her strokes land live with her
name. Ted is a human in the room, nothing special. The session 8ddb0dd5 record
holds the full anatomy of how the build drifted to "two browsers syncing" and
the reset that fixed it: confirm the felt experience first, scope smallest,
never present plumbing as the experience.
