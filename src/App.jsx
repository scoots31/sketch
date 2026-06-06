import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'

// Step 1: the blank canvas. No persistence yet — that's the next build.
// The whole-viewport canvas is the entire app surface for now.
export default function App() {
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw />
    </div>
  )
}
