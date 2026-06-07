import { useEffect, useState } from 'react'
import { listSketches, createSketch, renameSketch, deleteSketch } from './api'

// The library — "your sketches." Create, open, rename, delete. The persistent
// home that makes a sketch a place you come back to, not a one-session canvas.
export default function SketchList({ onOpen }) {
  const [sketches, setSketches] = useState(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  const refresh = () =>
    listSketches().then(setSketches).catch((e) => setError(e.message))

  useEffect(() => {
    refresh()
  }, [])

  const create = async (e) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    try {
      const s = await createSketch(n)
      setName('')
      onOpen(s.id, s.name)
    } catch (err) {
      setError(err.message)
    }
  }

  const rename = async (s) => {
    const next = window.prompt('Rename sketch', s.name)
    if (next && next.trim() && next.trim() !== s.name) {
      await renameSketch(s.id, next.trim())
      refresh()
    }
  }

  const remove = async (s) => {
    if (window.confirm(`Delete "${s.name}"? This can't be undone.`)) {
      await deleteSketch(s.id)
      refresh()
    }
  }

  const fmt = (ts) => new Date(ts).toLocaleString()

  return (
    <div style={styles.page}>
      <div style={styles.inner}>
        <h1 style={styles.h1}>Sketch</h1>
        <p style={styles.sub}>A shared visual space. Your sketches live here — open one to keep working.</p>

        <form onSubmit={create} style={styles.form}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name a new sketch…"
            style={styles.input}
          />
          <button type="submit" style={styles.newBtn}>New sketch</button>
        </form>

        {error && <div style={styles.error}>{error}</div>}

        {sketches === null ? (
          <div style={styles.muted}>Loading…</div>
        ) : sketches.length === 0 ? (
          <div style={styles.muted}>No sketches yet. Name one above to begin.</div>
        ) : (
          <ul style={styles.list}>
            {sketches.map((s) => (
              <li key={s.id} style={styles.row}>
                <button style={styles.open} onClick={() => onOpen(s.id, s.name)}>
                  <span style={styles.rowName}>{s.name}</span>
                  <span style={styles.rowMeta}>edited {fmt(s.updated_at)}</span>
                </button>
                <div style={styles.actions}>
                  <button style={styles.link} onClick={() => rename(s)}>Rename</button>
                  <button style={styles.linkDanger} onClick={() => remove(s)}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

const styles = {
  page: { minHeight: '100vh', background: '#f6f7f9', fontFamily: 'system-ui, -apple-system, sans-serif', color: '#1a1a1a' },
  inner: { maxWidth: 720, margin: '0 auto', padding: '56px 24px' },
  h1: { fontSize: 30, fontWeight: 700, margin: '0 0 6px' },
  sub: { color: '#666', margin: '0 0 28px', fontSize: 15 },
  form: { display: 'flex', gap: 10, marginBottom: 28 },
  input: { flex: 1, padding: '11px 14px', fontSize: 15, border: '1px solid #d4d7dd', borderRadius: 9, outline: 'none' },
  newBtn: { padding: '11px 18px', fontSize: 15, fontWeight: 600, color: '#fff', background: '#111', border: 'none', borderRadius: 9, cursor: 'pointer' },
  error: { color: '#b00020', marginBottom: 16, fontSize: 14 },
  muted: { color: '#888', fontSize: 15, padding: '24px 0' },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  row: { display: 'flex', alignItems: 'center', background: '#fff', border: '1px solid #e6e8ec', borderRadius: 11, overflow: 'hidden' },
  open: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3, padding: '14px 18px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' },
  rowName: { fontSize: 16, fontWeight: 600, color: '#111' },
  rowMeta: { fontSize: 12.5, color: '#999' },
  actions: { display: 'flex', gap: 4, padding: '0 14px' },
  link: { border: 'none', background: 'none', color: '#666', fontSize: 13, cursor: 'pointer', padding: '6px 8px' },
  linkDanger: { border: 'none', background: 'none', color: '#b00020', fontSize: 13, cursor: 'pointer', padding: '6px 8px' },
}
