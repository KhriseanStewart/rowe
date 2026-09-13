import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

type CursorKind =
  | 'pointer'
  | 'text'
  | 'hand'
  | 'cross'
  | 'move'
  | 'resize-ns'
  | 'resize-ew'
  | 'resize-nwse'
  | 'resize-nesw'
  | 'busy'

function CursorMark({ kind }: { kind: CursorKind }): React.JSX.Element {
  if (kind === 'text') {
    return (
      <svg width="11" height="19" viewBox="0 0 11 19" fill="none">
        <path
          d="M1.7 1.6h7.6M5.5 1.6v15.8M1.7 17.4h7.6"
          stroke="#fff"
          strokeWidth="2.35"
          strokeLinecap="round"
        />
        <path
          d="M1.7 1.6h7.6M5.5 1.6v15.8M1.7 17.4h7.6"
          stroke="#0a84ff"
          strokeWidth="1.35"
          strokeLinecap="round"
        />
      </svg>
    )
  }

  if (kind === 'hand') {
    return (
      <svg width="15" height="17" viewBox="0 0 15 17" fill="none">
        <path
          d="M5.6 7.4V2.9c0-.55.44-1 .98-1s.98.45.98 1v3.5M7.56 6.3V2.55c0-.55.44-1 .98-1s.98.45.98 1V6.6M9.52 6.5V3.4c0-.55.43-1 .97-1s.91.45.91 1v5.4c0 2.25-1.46 4.2-3.62 4.2H6.85c-1.76 0-3-1.05-3.7-2.2L2 8.3c-.28-.42.02-1.05.54-1.16.34-.08.7.05.9.32l1.18 1.48V3.5c0-.55.44-1 .98-1s.98.45.98 1v3.2"
          fill="#0a84ff"
          stroke="#fff"
          strokeWidth="1.05"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  if (kind === 'cross') {
    return (
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
        <path d="M7.5 1.4v12.2M1.4 7.5h12.2" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" />
        <path d="M7.5 1.4v12.2M1.4 7.5h12.2" stroke="#0a84ff" strokeWidth="1.25" strokeLinecap="round" />
      </svg>
    )
  }

  if (kind === 'move' || kind.startsWith('resize')) {
    const rotate =
      kind === 'resize-ew' ? 90 : kind === 'resize-nwse' ? 45 : kind === 'resize-nesw' ? -45 : 0
    return (
      <svg
        width="15"
        height="15"
        viewBox="0 0 15 15"
        fill="none"
        style={{ transform: `rotate(${rotate}deg)` }}
      >
        <path d="M7.5 1.5v12M1.5 7.5h12" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" />
        <path d="M7.5 1.5v12M1.5 7.5h12" stroke="#0a84ff" strokeWidth="1.25" strokeLinecap="round" />
      </svg>
    )
  }

  if (kind === 'busy') {
    return (
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
        <circle cx="7.5" cy="7.5" r="5.2" stroke="#fff" strokeWidth="2.2" />
        <circle cx="7.5" cy="7.5" r="5.2" stroke="#0a84ff" strokeWidth="1.25" strokeDasharray="8 8" />
      </svg>
    )
  }

  if (window.api.platform === 'win32') {
    return (
      <svg width="14" height="20" viewBox="0 0 14 20" fill="none">
        <path
          d="M1.15 1.2 1.5 16.4l3.55-3.35 2.05 4.95 2.05-.85-2.05-4.85 4.85-.2L1.15 1.2Z"
          fill="#0a84ff"
          stroke="#fff"
          strokeWidth="1.05"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  return (
    <svg width="14" height="20" viewBox="0 0 14 20" fill="none">
      <path
        d="M1.45 1.15c-.32-.22-.72.08-.62.45L3.55 16.2c.1.4.64.46.84.1l2.05-2.8 1.82 4c.12.28.46.4.72.26l1.28-.58c.28-.12.4-.46.26-.72l-1.82-4 3.78-.28c.42-.04.56-.56.22-.78L1.45 1.15Z"
        fill="#0a84ff"
        stroke="#fff"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Overlay(): React.JSX.Element {
  const [kind, setKind] = useState<CursorKind>('pointer')

  useEffect(() => {
    return window.api.onCompanionPointer((next) => {
      setKind(next.kind)
    })
  }, [])

  return (
    <div className="companion-cursor">
      <CursorMark kind={kind} />
    </div>
  )
}

const style = document.createElement('style')
style.textContent = `
  html, body, #root {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: transparent;
  }
  .companion-cursor {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    pointer-events: none;
    filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.35));
  }
`
document.head.appendChild(style)

createRoot(document.getElementById('root')!).render(<Overlay />)
