// Thin client over the Sketch API. Same-origin in prod, Vite-proxied in dev.
const BASE = '/api/sketches'

async function json(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `request failed (${res.status})`)
  }
  return res.status === 204 ? null : res.json()
}

export const listSketches = () => fetch(BASE).then(json)

export const createSketch = (name) =>
  fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(json)

export const loadSketch = (id) => fetch(`${BASE}/${id}`).then(json)

// saveSketch removed (gate work, 2026-06-11): the sync client never blob-saves —
// the live room owns persistence. The route itself is room-guarded server-side.

export const renameSketch = (id, name) =>
  fetch(`${BASE}/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(json)

export const deleteSketch = (id) =>
  fetch(`${BASE}/${id}`, { method: 'DELETE' }).then(json)
