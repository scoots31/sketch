import { Tldraw, useEditor, useValue } from 'tldraw'
import 'tldraw/tldraw.css'
import { useSync } from '@tldraw/sync'
import { useMemo } from 'react'

// One sketch open on the canvas — multiplayer. useSync holds a live WebSocket to
// this sketch's room; concurrent edits merge conflict-free and persist server-side.

// Sketch v1 has no image uploads, so the asset store is a pass-through.
const assets = {
  async upload() {
    throw new Error('uploads are not supported in Sketch yet')
  },
  resolve(asset) {
    return asset.props.src
  },
}

function statusLabel(status) {
  if (status === 'synced-remote') return 'live'
  if (status === 'loading') return 'connecting…'
  if (status === 'error') return 'offline'
  return ''
}

// Per-author badge styling. Agent-drawn shapes carry meta.author (set at
// creation, frozen). Human shapes have no author and get no badge.
const AUTHOR_STYLES = {
  ren: '#8b5cf6',
  claude: '#0ea5e9',
  maya: '#f59e0b',
  kate: '#10b981',
  recon: '#ef4444',
}

// SL-002 attribution: a small "Ren" badge floating above each shape an agent
// drew, so it reads at a glance whose mark it is. Rendered in the in-front-of-
// canvas layer (screen space) and re-positioned via pageToViewport so badges
// track pan and zoom. Light overlay — no custom shape utils.
function AuthorBadges() {
  const editor = useEditor()
  const badges = useValue(
    'author-badges',
    () => {
      editor.getCamera() // read camera so this recomputes on pan/zoom
      return editor
        .getCurrentPageShapes()
        .filter((s) => s.meta && s.meta.author)
        .map((s) => {
          const b = editor.getShapePageBounds(s.id)
          if (!b) return null
          const pt = editor.pageToViewport({ x: b.x, y: b.y })
          return { id: s.id, author: String(s.meta.author), x: pt.x, y: pt.y }
        })
        .filter(Boolean)
    },
    [editor]
  )

  return (
    <>
      {badges.map((bd) => {
        const color = AUTHOR_STYLES[bd.author.toLowerCase()] || '#6366f1'
        const label = bd.author.charAt(0).toUpperCase() + bd.author.slice(1)
        return (
          <div
            key={bd.id}
            style={{
              position: 'absolute',
              left: bd.x,
              top: bd.y - 22,
              pointerEvents: 'none',
              background: color,
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
              padding: '2px 7px',
              borderRadius: 8,
              fontFamily: 'system-ui, sans-serif',
              whiteSpace: 'nowrap',
              boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
            }}
          >
            {label}
          </div>
        )
      })}
    </>
  )
}

const components = { InFrontOfTheCanvas: AuthorBadges }

export default function SketchCanvas({ id, name, onBack }) {
  // Same-origin in prod; vite proxies /connect → :3000 in dev.
  const uri = useMemo(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${window.location.host}/connect/${id}`
  }, [id])

  const store = useSync({ uri, assets })

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
        <span style={{ color: '#999', minWidth: 48 }}>{statusLabel(store.status)}</span>
      </div>
      <Tldraw
        store={store}
        components={components}
        onMount={(editor) => {
          // Dev-only test hook — stripped from production builds.
          if (import.meta.env.DEV) window.__editor = editor
        }}
      />
    </div>
  )
}
