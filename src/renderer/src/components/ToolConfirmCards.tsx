import { useEffect, useState } from 'react'

export type ToolConfirmPayload = {
  requestId: string
  status: 'needs_confirmation' | string
  confirmation?: {
    title: string
    summary: string
    danger?: boolean
    preview?: Record<string, unknown>
  }
  result?: Record<string, unknown>
  error?: string
}

type CardState = ToolConfirmPayload & {
  busy?: boolean
  resolved?: 'approved' | 'declined' | 'error'
  resultMessage?: string
}

type Props = {
  compact?: boolean
}

function previewLines(preview?: Record<string, unknown>): string[] {
  if (!preview) return []
  const lines: string[] = []
  const tool = preview.tool
  if (typeof tool === 'string') lines.push(`Tool: ${tool}`)
  const params = preview.params
  if (params && typeof params === 'object') {
    const record = params as Record<string, unknown>
    for (const key of ['repo', 'branch', 'path', 'message', 'title', 'base', 'head']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) {
        lines.push(`${key}: ${value.trim()}`)
      }
    }
    const files = record.files
    if (Array.isArray(files) && files.length) {
      lines.push(`files: ${files.length}`)
      for (const file of files.slice(0, 6)) {
        const path = (file as { path?: string })?.path
        if (path) lines.push(`  • ${path}`)
      }
      if (files.length > 6) lines.push(`  … +${files.length - 6} more`)
    }
  }
  return lines.slice(0, 14)
}

export default function ToolConfirmCards({ compact }: Props): React.JSX.Element | null {
  const [cards, setCards] = useState<CardState[]>([])

  useEffect(() => {
    return window.api.onToolConfirm((payload) => {
      if (!payload?.requestId || payload.status !== 'needs_confirmation') return
      setCards((current) => {
        if (current.some((card) => card.requestId === payload.requestId && !card.resolved)) {
          return current
        }
        return [...current, payload]
      })
    })
  }, [])

  const respond = async (requestId: string, approved: boolean): Promise<void> => {
    setCards((current) =>
      current.map((card) => (card.requestId === requestId ? { ...card, busy: true } : card))
    )
    try {
      const result = await window.api.confirmTool(requestId, approved)
      setCards((current) =>
        current.map((card) =>
          card.requestId === requestId
            ? {
                ...card,
                busy: false,
                resolved: approved
                  ? result.status === 'success'
                    ? 'approved'
                    : 'error'
                  : 'declined',
                resultMessage:
                  result.status === 'success'
                    ? String(result.result?.summary || 'Done')
                    : result.error || (approved ? 'Failed' : 'Declined')
              }
            : card
        )
      )
      // Drop resolved cards after a beat
      window.setTimeout(() => {
        setCards((current) => current.filter((card) => card.requestId !== requestId || !card.resolved))
      }, 2200)
    } catch (error) {
      setCards((current) =>
        current.map((card) =>
          card.requestId === requestId
            ? {
                ...card,
                busy: false,
                resolved: 'error',
                resultMessage: error instanceof Error ? error.message : 'Confirm failed'
              }
            : card
        )
      )
    }
  }

  if (!cards.length) return null

  return (
    <div className={`tool-confirm-stack ${compact ? 'is-compact' : ''}`}>
      {cards.map((card) => {
        const title = card.confirmation?.title || 'Confirm tool action'
        const summary = card.confirmation?.summary || 'This action needs your approval.'
        const danger = Boolean(card.confirmation?.danger)
        const lines = previewLines(card.confirmation?.preview)
        return (
          <article
            key={card.requestId}
            className={`tool-confirm-card ${danger ? 'is-danger' : ''} ${card.resolved ? `is-${card.resolved}` : ''}`}
          >
            <header className="tool-confirm-head">
              <div className="min-w-0">
                <p className="tool-confirm-title">{title}</p>
                <p className="tool-confirm-summary">{summary}</p>
              </div>
              {!card.resolved ? (
                <div className="tool-confirm-actions">
                  <button
                    type="button"
                    className={`tool-confirm-btn ${danger ? 'is-danger' : 'is-accept'}`}
                    disabled={card.busy}
                    onClick={() => void respond(card.requestId, true)}
                  >
                    {card.busy ? 'Working…' : danger ? 'Confirm' : 'Allow'}
                  </button>
                  <button
                    type="button"
                    className="tool-confirm-btn is-decline"
                    disabled={card.busy}
                    onClick={() => void respond(card.requestId, false)}
                  >
                    Decline
                  </button>
                </div>
              ) : (
                <span className={`tool-confirm-status is-${card.resolved}`}>
                  {card.resolved === 'approved'
                    ? 'Approved'
                    : card.resolved === 'declined'
                      ? 'Declined'
                      : 'Failed'}
                </span>
              )}
            </header>
            {lines.length ? (
              <pre className="tool-confirm-preview">{lines.join('\n')}</pre>
            ) : null}
            {card.resultMessage ? <p className="tool-confirm-result">{card.resultMessage}</p> : null}
          </article>
        )
      })}
    </div>
  )
}
