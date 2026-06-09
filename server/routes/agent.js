import { Router } from 'express'
import { query } from '../db.js'
import { requireAgentAuth } from '../auth.js'
import { drawShapes, buildRecords } from '../shapes.js'
import { getActiveRoom, flushRoom } from '../rooms.js'

// Agent-facing API. Every route requires shared-secret auth and respects the
// privacy flag: agents see and touch non-private sketches only ("watch
// everything", opt-out privacy). Human/browser routes stay open and separate.
export const agent = Router()
agent.use(requireAgentAuth)

// List — non-private sketches the agents may work in.
agent.get('/sketches', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, updated_at, created_at
         FROM sketches
        WHERE is_private = false
        ORDER BY updated_at DESC`
    )
    res.json(rows)
  } catch (e) {
    next(e)
  }
})

// Read — full document so an agent can see what's there. Private → 403 (loud).
agent.get('/sketches/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, document, is_private, updated_at FROM sketches WHERE id = $1`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'sketch not found' })
    if (rows[0].is_private) {
      return res.status(403).json({ auth: 'rejected', reason: 'sketch is private' })
    }
    res.json(rows[0])
  } catch (e) {
    next(e)
  }
})

// Write — an agent saves the document back (its drawing lands in the same
// durable record as the human's, permanent). Private → 403 (loud).
agent.put('/sketches/:id/document', async (req, res, next) => {
  try {
    const { document } = req.body || {}
    if (document === undefined) {
      return res.status(400).json({ error: 'missing document' })
    }
    const guard = await query(`SELECT is_private FROM sketches WHERE id = $1`, [
      req.params.id,
    ])
    if (!guard.rows.length) return res.status(404).json({ error: 'sketch not found' })
    if (guard.rows[0].is_private) {
      return res.status(403).json({ auth: 'rejected', reason: 'sketch is private' })
    }
    const { rows } = await query(
      `UPDATE sketches SET document = $1, updated_at = now()
        WHERE id = $2 RETURNING id, updated_at`,
      [document, req.params.id]
    )
    res.json({ ...rows[0], by: req.agentId })
  } catch (e) {
    next(e)
  }
})

// Draw — an agent adds shapes from simple specs (the natural way to draw). The
// server builds genuine tldraw records so the shapes are live and editable in
// the human's browser. Read-modify-write: existing shapes are preserved. The
// response is a digest of what was actually stored — the agent's self-check,
// not a rendered image (rendering needs a browser; the human already has one).
// Private → 403 (loud). Bad spec → 400 (loud).
agent.post('/sketches/:id/draw', async (req, res, next) => {
  try {
    const specs = req.body?.shapes
    if (!Array.isArray(specs) || specs.length === 0) {
      return res.status(400).json({ error: 'shapes must be a non-empty array' })
    }
    const guard = await query(
      `SELECT document, is_private FROM sketches WHERE id = $1`,
      [req.params.id]
    )
    if (!guard.rows.length) return res.status(404).json({ error: 'sketch not found' })
    if (guard.rows[0].is_private) {
      return res.status(403).json({ auth: 'rejected', reason: 'sketch is private' })
    }

    const author = req.agentId
    const room = getActiveRoom(req.params.id)

    // LIVE path: a human has this sketch open. Inject the records into the live
    // room so they appear on the open canvas instantly, then flush to Postgres
    // BEFORE returning — when this call returns, the shapes are durable on disk,
    // not just held in memory (the durability guarantee).
    if (room) {
      let built
      try {
        const snap = room.getCurrentSnapshot()
        const store = {}
        for (const d of snap.documents) store[d.state.id] = d.state
        built = buildRecords(store, specs, author)
      } catch (e) {
        return res.status(400).json({ error: e.message })
      }
      await room.updateStore((store) => {
        for (const rec of built.records) store.put(rec)
      })
      await flushRoom(req.params.id)
      const shapeCount = room
        .getCurrentSnapshot()
        .documents.filter((d) => d.state?.typeName === 'shape').length
      return res.json({
        id: req.params.id,
        by: author,
        live: true,
        shapes_added: built.digest.length,
        shape_count: shapeCount,
        shapes: built.digest,
      })
    }

    // FALLBACK path: nobody connected — read-modify-write the durable blob.
    let result
    try {
      result = drawShapes(guard.rows[0].document, specs, author)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }

    const { rows } = await query(
      `UPDATE sketches SET document = $1, updated_at = now()
        WHERE id = $2 RETURNING id, updated_at`,
      [result.document, req.params.id]
    )
    res.json({
      id: rows[0].id,
      updated_at: rows[0].updated_at,
      by: author,
      live: false,
      shapes_added: result.digest.length,
      shape_count: result.shapeCount,
      shapes: result.digest,
    })
  } catch (e) {
    next(e)
  }
})
