import { Router } from 'express'
import { query } from '../db.js'
import { requireAgentAuth } from '../auth.js'

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
