import { Tldraw, getSnapshot, loadSnapshot } from 'tldraw'
import 'tldraw/tldraw.css'
import { useCallback, useRef, useState } from 'react'
import { loadSketch, saveSketch } from './api'

// One sketch open on the canvas. Loads the saved document on mount, then
// autosaves the whole snapshot back on every user document change (debounced).
// Save is an UPDATE to the same record — the sketch accumulates.
export default function SketchCanvas({ id, name, onBack }) {
  const saveTimer = useRef(null)
  const [status, setStatus] = useState('') // '', 'saving', 'saved', 'error'

  const handleMount = useCallback(
    async (editor) => {
      try {
        const sketch = await loadSketch(id)
        if (sketch?.document) loadSnapshot(editor.store, sketch.document)
      } catch (e) {
        console.error('[sketch] load failed:', e.message)
        setStatus('error')
      }

      // persist on user-driven document changes only (not camera, not remote)
      editor.store.listen(
        () => {
          setStatus('saving')
          clearTimeout(saveTimer.current)
          saveTimer.current = setTimeout(async () => {
            try {
              await saveSketch(id, getSnapshot(editor.store))
              setStatus('saved')
            } catch (e) {
              console.error('[sketch] save failed:', e.message)
              setStatus('error')
            }
          }, 700)
        },
        { source: 'user', scope: 'document' }
      )
    },
    [id]
  )

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <div
        style={{
          position: 'absolute', top: 8, left: 8, zIndex: 1000,
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'rgba(255,255,255,0.92)', padding: '6px 10px',
          borderRadius: 8, boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
          fontFamily: 'system-ui, sans-serif', fontSize: 13,
        }}
      >
        <button
          onClick={onBack}
          style={{
            border: 'none', background: 'none', cursor: 'pointer',
            fontSize: 13, color: '#444', padding: 0,
          }}
        >
          ← Sketches
        </button>
        <strong style={{ color: '#111' }}>{name || 'Sketch'}</strong>
        <span style={{ color: '#999', minWidth: 48 }}>
          {status === 'saving' ? 'saving…' : status === 'saved' ? 'saved' : status === 'error' ? 'save failed' : ''}
        </span>
      </div>
      <Tldraw onMount={handleMount} />
    </div>
  )
}
