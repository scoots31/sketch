import { Router } from 'express'
import { query } from '../db.js'

// Human-facing sketch API. Open for v1 (single owner); agent auth layers on later.
// Save is an UPDATE to the same record every time — a sketch accumulates, never forks.
export const sketches = Router()

// List — for the "your sketches" view. Light payload: no document blobs.
sketches.get('/', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, is_private, updated_at, created_at
         FROM sketches
        ORDER BY updated_at DESC`
    )
    res.json(rows)
  } catch (e) {
    next(e)
  }
})

// Create — a named, empty sketch. Returns the new id so the client can open it.
sketches.post('/', async (req, res, next) => {
  try {
    const name = (req.body?.name || '').trim() || 'Untitled sketch'
    const { rows } = await query(
      `INSERT INTO sketches (name) VALUES ($1)
       RETURNING id, name, created_at, updated_at`,
      [name]
    )
    res.status(201).json(rows[0])
  } catch (e) {
    next(e)
  }
})

// Open — full record including the document snapshot.
sketches.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, document, is_private, updated_at, created_at
         FROM sketches WHERE id = $1`,
      [req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'sketch not found' })
    res.json(rows[0])
  } catch (e) {
    next(e)
  }
})

// Save — overwrite the document snapshot, bump updated_at. The heartbeat.
sketches.put('/:id/document', async (req, res, next) => {
  try {
    const { document } = req.body || {}
    if (document === undefined) {
      return res.status(400).json({ error: 'missing document' })
    }
    const { rows } = await query(
      `UPDATE sketches
          SET document = $1, updated_at = now()
        WHERE id = $2
      RETURNING id, updated_at`,
      [document, req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'sketch not found' })
    res.json(rows[0])
  } catch (e) {
    next(e)
  }
})

// Rename.
sketches.patch('/:id', async (req, res, next) => {
  try {
    const name = (req.body?.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name required' })
    const { rows } = await query(
      `UPDATE sketches SET name = $1, updated_at = now()
        WHERE id = $2 RETURNING id, name, updated_at`,
      [name, req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'sketch not found' })
    res.json(rows[0])
  } catch (e) {
    next(e)
  }
})

// Delete.
sketches.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await query(`DELETE FROM sketches WHERE id = $1`, [
      req.params.id,
    ])
    if (!rowCount) return res.status(404).json({ error: 'sketch not found' })
    res.status(204).end()
  } catch (e) {
    next(e)
  }
})
