// SSE notification channel — push draw events to open canvases.
//
// Keyed by sketchId. Each connected canvas holds an open SSE response.
// The agent draw route calls broadcastDrawEvent() on rollback so the canvas
// can show a toast before the shapes vanish, rather than a silent flicker.

const _clients = new Map() // sketchId -> Set<{ res, timer }>

export function addClient(sketchId, res) {
  if (!_clients.has(sketchId)) _clients.set(sketchId, new Set())
  const timer = setInterval(() => {
    try { res.write(': heartbeat\n\n') } catch {}
  }, 25000)
  const entry = { res, timer }
  _clients.get(sketchId).add(entry)
  return () => {
    clearInterval(timer)
    _clients.get(sketchId)?.delete(entry)
    if (_clients.get(sketchId)?.size === 0) _clients.delete(sketchId)
  }
}

export function broadcastDrawEvent(sketchId, type, data) {
  const set = _clients.get(sketchId)
  if (!set || set.size === 0) return
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  for (const { res } of set) {
    try { res.write(payload) } catch {}
  }
}
