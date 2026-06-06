# Sketch

A persistent shared visual space for Scott, Ren, and Claude. Standalone tldraw app,
deployed at sketch-app.onrender.com. Talks to han-solo over an authenticated API
(shared-secret HMAC) so agents can read and draw in sketches.

Sibling to Jottings: Jottings is written, Sketch is visual. Both are open spaces —
agents see and contribute by default.

## What a sketch is

A **permanent place work lives** — not a transient whiteboard. Sketches are saved
durably, reopenable any time, re-editable, and they accumulate over time. You and the
agents add to the same sketch across sessions.

## Build sequence (v1)

1. **Blank canvas** — tldraw app loads on the domain ← *current step*
2. **Durable save** — Postgres-backed save / reopen / name (the heartbeat)
3. **Folders + search** — organize once there are many
4. **Agent read/write** — agents read and draw onto the durable record (shared-secret auth)
5. **Multiplayer** — real-time co-drawing, broadcast + collision

## Run

```
npm install
npm run dev   # http://localhost:5190
```

## Auth (designed, proven on han-solo bench, not yet wired here)

Agents authenticate with shared-secret HMAC: sign `agent_id:timestamp:body` with a key
shared between Sketch and Letta, validated locally (no call back to Letta). Every failure
mode fails loud with a named reason. Proof: han-solo `.sketch-sandbox/auth-proof.js`.
