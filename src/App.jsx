import { useEffect, useState } from 'react'
import SketchList from './SketchList.jsx'
import SketchCanvas from './SketchCanvas.jsx'

// Hash routing: #/s/:id opens a sketch, anything else shows the library.
// The hash means every sketch has a shareable URL you can return to any time.
function parseHash() {
  const m = window.location.hash.match(/^#\/s\/([\w-]+)/)
  return m ? m[1] : null
}

export default function App() {
  const [openId, setOpenId] = useState(parseHash())
  const [openName, setOpenName] = useState('')

  useEffect(() => {
    const onHash = () => setOpenId(parseHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const open = (id, name) => {
    setOpenName(name || '')
    window.location.hash = `#/s/${id}`
    setOpenId(id)
  }
  const back = () => {
    window.location.hash = ''
    setOpenId(null)
  }

  return openId ? (
    <SketchCanvas id={openId} name={openName} onBack={back} />
  ) : (
    <SketchList onOpen={open} />
  )
}
