// Agent-drawing translation: simple specs → genuine tldraw records.
//
// This is the heart of "an agent can draw." An agent sends a small, safe spec
// ({type, x, y, w, h, label, color}); this builds REAL tldraw shape records —
// the same records the browser produces — so a human sees them live and can
// grab, move, and edit them like their own. The translation lives here, where
// tldraw lives, never hand-rolled on the caller's side (that would drift).
//
// SECURITY (deliberate): the spec is TIGHT. We never accept raw tldraw records.
// Only the shape types and knobs below are honored; anything else is clamped to
// a safe default. There is no path from caller input to arbitrary record fields,
// so a malformed or hostile spec cannot inject a broken or dangerous record.
//
// Headless-safe: builds plain record objects using tldraw's own pure helpers
// (createShapeId, toRichText, getIndexAbove, createTLSchema). No Editor, no DOM
// — proven against the deployed tldraw 3.15.6.

import { createShapeId, toRichText, createTLSchema } from '@tldraw/tlschema'
import { getIndexAbove } from '@tldraw/utils'

// tldraw's named palette. Anything off-list falls back to black.
const COLORS = new Set([
  'black', 'blue', 'green', 'grey', 'light-blue', 'light-green', 'light-red',
  'light-violet', 'orange', 'red', 'violet', 'white', 'yellow',
])
// Geo shapes an agent may draw. Off-list falls back to rectangle.
const GEOS = new Set(['rectangle', 'ellipse', 'triangle', 'diamond'])
const FILLS = new Set(['none', 'semi', 'solid', 'pattern'])

const MAX_SHAPES_PER_CALL = 50
const MAX_LABEL_LEN = 500

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)

// Pull the plain string back out of a richText doc, for the digest the agent
// reads as its self-check.
function plainText(rt) {
  try {
    return rt.content
      .flatMap((p) => (p.content || []).map((n) => n.text || ''))
      .join('')
  } catch {
    return ''
  }
}

// One geo shape record, every prop matching what tldraw 3.15 stores for a
// browser-drawn shape (verified against a real snapshot). Get this set wrong and
// tldraw's validator rejects the whole document — so it mirrors ground truth.
function geoRecord(spec, pageId, index, author) {
  return {
    id: createShapeId(),
    typeName: 'shape',
    type: 'geo',
    x: num(spec.x, 0),
    y: num(spec.y, 0),
    rotation: 0,
    index,
    parentId: pageId,
    isLocked: false,
    opacity: 1,
    props: {
      geo: GEOS.has(spec.type) ? spec.type : 'rectangle',
      w: Math.max(1, num(spec.w, 100)),
      h: Math.max(1, num(spec.h, 100)),
      color: COLORS.has(spec.color) ? spec.color : 'black',
      labelColor: 'black',
      fill: FILLS.has(spec.fill) ? spec.fill : 'none',
      dash: 'draw',
      size: 'm',
      font: 'draw',
      align: 'middle',
      verticalAlign: 'middle',
      growY: 0,
      scale: 1,
      url: '',
      richText: toRichText(
        typeof spec.label === 'string' ? spec.label.slice(0, MAX_LABEL_LEN) : ''
      ),
    },
    // author is frozen at creation: it marks who DREW this shape (e.g. "ren").
    // If a human later moves/resizes it, the mark doesn't change hands.
    meta: author ? { author: String(author) } : {},
  }
}

// The two base records every tldraw document needs. Used only when an agent
// draws into a sketch that's never been opened (document is null).
function baseStore() {
  return {
    'document:document': {
      gridSize: 10,
      name: '',
      meta: {},
      id: 'document:document',
      typeName: 'document',
    },
    'page:page': {
      meta: {},
      id: 'page:page',
      name: 'Page 1',
      index: 'a1',
      typeName: 'page',
    },
  }
}

function validateSpecs(specs) {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new Error('shapes must be a non-empty array of specs')
  }
  if (specs.length > MAX_SHAPES_PER_CALL) {
    throw new Error(`too many shapes in one call (max ${MAX_SHAPES_PER_CALL})`)
  }
}

// Build genuine tldraw geo records for `specs`, WITHOUT mutating anything.
// `store` is the existing records map (from a blob doc OR a live room snapshot) —
// used only to find the target page and the highest existing fractional index so
// new shapes append above the rest. `author` is stamped into each record's meta.
// Returns { records, digest, pageId }. This is the shared core used by both the
// blob path (drawShapes) and the live-room path (agent route), so a shape an
// agent draws is byte-identical whether it lands in Postgres or the live room.
export function buildRecords(store, specs, author = '') {
  validateSpecs(specs)

  let pageId = Object.keys(store).find((k) => store[k]?.typeName === 'page')
  if (!pageId) pageId = 'page:page'

  // Highest existing index on that page. Fractional indices sort
  // lexicographically, so string comparison is the correct ordering.
  let maxIndex = 'a0'
  for (const r of Object.values(store)) {
    if (
      r?.typeName === 'shape' &&
      r.parentId === pageId &&
      typeof r.index === 'string' &&
      r.index > maxIndex
    ) {
      maxIndex = r.index
    }
  }

  const records = []
  const digest = []
  for (const spec of specs) {
    maxIndex = getIndexAbove(maxIndex)
    const rec = geoRecord(spec, pageId, maxIndex, author)
    records.push(rec)
    digest.push({
      id: rec.id,
      type: rec.props.geo,
      label: plainText(rec.props.richText),
      x: rec.x,
      y: rec.y,
      w: rec.props.w,
      h: rec.props.h,
      color: rec.props.color,
      author: author ? String(author) : undefined,
    })
  }
  return { records, digest, pageId }
}

// Add shapes to a tldraw document (the BLOB path). Read-modify-write: existing
// shapes are preserved; new shapes are appended above them. Returns the new
// document plus a digest. `document` is the stored {store, schema} snapshot, or
// null/undefined for a sketch that's never been opened. `author` marks who drew.
export function drawShapes(document, specs, author = '') {
  validateSpecs(specs)

  const doc = document && typeof document === 'object' ? document : null
  const store =
    doc?.store && typeof doc.store === 'object' ? { ...doc.store } : baseStore()
  const schema = doc?.schema || createTLSchema().serialize()

  // Ensure the two base records exist before we attach shapes.
  if (!Object.keys(store).some((k) => store[k]?.typeName === 'page')) {
    store['page:page'] = baseStore()['page:page']
  }
  if (!store['document:document']) {
    store['document:document'] = baseStore()['document:document']
  }

  const { records, digest, pageId } = buildRecords(store, specs, author)
  for (const rec of records) store[rec.id] = rec

  const shapeCount = Object.values(store).filter(
    (r) => r?.typeName === 'shape'
  ).length

  return { document: { store, schema }, digest, shapeCount, pageId }
}
