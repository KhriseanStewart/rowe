import { useEffect, useState } from 'react'

export type OsPreviewPayload = {
  tool: string
  label: string
  x?: number
  y?: number
  durationMs?: number
}

type Toast = OsPreviewPayload & { id: string }

type Props = {
  compact?: boolean
}

export default function OsActionToast({ compact }: Props): React.JSX.Element | null {
  const [toast, setToast] = useState<Toast | null>(null)

  useEffect(() => {
    return window.api.onOsPreview((payload) => {
      if (!payload?.label && !payload?.tool) return
      const id = crypto.randomUUID()
      const durationMs = Math.max(400, Math.min(payload.durationMs ?? 900, 3000))
      setToast({ ...payload, id })
      window.setTimeout(() => {
        setToast((current) => (current?.id === id ? null : current))
      }, durationMs)
    })
  }, [])

  if (!toast) return null

  const hasPoint = Number.isFinite(toast.x) && Number.isFinite(toast.y)

  return (
    <div
      className={`os-action-toast ${compact ? 'is-compact' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="os-action-toast-dot" aria-hidden />
      <div className="os-action-toast-body">
        <p className="os-action-toast-label">{toast.label || toast.tool}</p>
        <p className="os-action-toast-meta">
          {toast.tool}
          {hasPoint ? ` · ${Math.round(Number(toast.x))},${Math.round(Number(toast.y))}` : ''}
        </p>
      </div>
    </div>
  )
}
