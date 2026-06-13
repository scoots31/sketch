import { Router } from 'express'
import { query } from '../db.js'
import { requireAgentAuth } from '../auth.js'
import { drawShapes } from '../shapes.js'
import { getActiveRoom, applyLiveDraw, LiveDrawRollback } from '../rooms.js'
import { broadcastDrawEvent } from '../notify.js'

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

// Write — an agent REPLACES THE ENTIRE DOCUMENT. This is not an append; the
// June 9 trap was an agent believing "write" added shapes while it wiped the
// canvas. Two guards (gate work, 2026-06-11):
//   1. replace:true must be passed explicitly — 'write' can never read as 'add'.
//   2. Refused while a live room is resident — a full replace would erase what
//      live participants have drawn, and the room's next flush would silently
//      overwrite this write anyway (the F1 clobber seam).
// Private → 403 (loud).
agent.put('/sketches/:id/document', async (req, res, next) => {
  try {
    const { document, replace } = req.body || {}
    if (document === undefined) {
      return res.status(400).json({ error: 'missing document' })
    }
    if (replace !== true) {
      return res.status(400).json({
        applied: false,
        error: 'explicit replace required',
        message:
          'This endpoint replaces the ENTIRE document — it does not append. ' +
          'Pass replace:true to confirm a full replacement, or use the draw ' +
          'endpoint to add shapes to what is already there.',
      })
    }
    if (getActiveRoom(req.params.id)) {
      return res.status(409).json({
        applied: false,
        error: 'live room active',
        message:
          'This sketch is open live right now. Replacing the whole document ' +
          'would erase what participants have drawn, and the live room would ' +
          'overwrite the replacement on its next save anyway. Use the draw ' +
          'endpoint to add shapes, or wait until the sketch is closed.',
      })
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
    res.json({ ...rows[0], by: req.agentId, applied: true })
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

    // LIVE path: a human has this sketch open. applyLiveDraw injects the records
    // into the live room (instant on open canvases) and flushes to Postgres
    // BEFORE returning — success means visible AND durable. On a flush failure
    // it rolls the injection back (failure means NEITHER) and we return the
    // plain-language contract: the message is written to be relayed to the
    // human in chat verbatim; the flags are structural, for the calling agent.
    if (getActiveRoom(req.params.id)) {
      let result
      try {
        result = await applyLiveDraw(req.params.id, specs, author)
      } catch (e) {
        if (e instanceof LiveDrawRollback) {
          broadcastDrawEvent(req.params.id, 'draw-failed', {
            message: e.message,
            by: req.agentId,
          })
          return res.status(500).json({
            applied: false,
            rolled_back: true,
            retry_safe: true,
            message: e.message,
            detail: e.flushError,
          })
        }
        return res.status(400).json({ error: e.message })
      }
      if (result) {
        return res.json({
          id: req.params.id,
          by: author,
          live: true,
          applied: true,
          shapes_added: result.built.digest.length,
          shape_count: result.shapeCount,
          shapes: result.built.digest,
        })
      }
      // room evaporated between check and apply — fall through to the blob path
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
