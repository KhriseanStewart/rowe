import { useMemo, useState } from 'react'

export type ChatFileEdit = {
  id: string
  path: string
  absolutePath: string
  oldText: string
  newText: string
  description?: string
  before: string
  after: string
}

type EditStatus = 'pending' | 'accepted' | 'declined' | 'error'

type Props = {
  edits: ChatFileEdit[]
  compact?: boolean
}

type DiffLine = { type: 'same' | 'add' | 'del'; text: string }

function buildDiffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, '\n').split('\n')
  const b = after.replace(/\r\n/g, '\n').split('\n')
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ type: 'same', text: a[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: 'del', text: a[i] })
      i += 1
    } else {
      lines.push({ type: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < n) {
    lines.push({ type: 'del', text: a[i] })
    i += 1
  }
  while (j < m) {
    lines.push({ type: 'add', text: b[j] })
    j += 1
  }
  return lines
}

function fileName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

function EditCard({ edit, compact }: { edit: ChatFileEdit; compact?: boolean }): React.JSX.Element {
  const [status, setStatus] = useState<EditStatus>('pending')
  const [error, setError] = useState<string | null>(null)
  const [writtenPath, setWrittenPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const lines = useMemo(() => buildDiffLines(edit.before, edit.after), [edit.before, edit.after])
  const added = lines.filter((line) => line.type === 'add').length
  const removed = lines.filter((line) => line.type === 'del').length

  const accept = async (): Promise<void> => {
    if (busy || status !== 'pending') return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.applyFileEdit({
        path: edit.path,
        absolutePath: edit.absolutePath,
        oldText: edit.oldText,
        newText: edit.newText
      })
      if (!result.ok) {
        setStatus('error')
        setError(result.error)
        return
      }
      setStatus('accepted')
      setWrittenPath(result.absolutePath)
    } catch (caught) {
      setStatus('error')
      setError(caught instanceof Error ? caught.message : 'Failed to apply edit')
    } finally {
      setBusy(false)
    }
  }

  const decline = (): void => {
    if (busy || status !== 'pending') return
    setStatus('declined')
  }

  return (
    <article className={`edit-card ${compact ? 'is-compact' : ''}`}>
      <header className="edit-card-head">
        <div className="edit-card-meta min-w-0">
          <div className="edit-card-title-row">
            <span className="edit-card-file">{fileName(edit.path)}</span>
            <span className="edit-card-path">{edit.path}</span>
          </div>
          {edit.description ? <p className="edit-card-desc">{edit.description}</p> : null}
          <div className="edit-card-stats">
            {added ? <span className="edit-stat is-add">+{added}</span> : null}
            {removed ? <span className="edit-stat is-del">−{removed}</span> : null}
            {!edit.absolutePath ? (
              <span className="edit-card-warn">Accept will ask for the project folder</span>
            ) : null}
          </div>
        </div>
        <div className="edit-card-actions">
          {status === 'pending' ? (
            <>
              <button
                type="button"
                className="edit-btn edit-btn-accept"
                disabled={busy}
                onClick={() => void accept()}
              >
                {busy ? 'Applying…' : 'Accept'}
              </button>
              <button type="button" className="edit-btn edit-btn-decline" disabled={busy} onClick={decline}>
                Decline
              </button>
            </>
          ) : (
            <span className={`edit-status is-${status}`}>
              {status === 'accepted' ? 'Accepted' : status === 'declined' ? 'Declined' : 'Failed'}
            </span>
          )}
        </div>
      </header>

      <div className="edit-diff" role="region" aria-label={`Diff for ${edit.path}`}>
        {lines.map((line, index) => (
          <div key={`${edit.id}-${index}`} className={`edit-diff-line is-${line.type}`}>
            <span className="edit-diff-mark" aria-hidden>
              {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}
            </span>
            <span className="edit-diff-text">{line.text || ' '}</span>
          </div>
        ))}
      </div>

      {error ? <p className="edit-card-error">{error}</p> : null}
      {writtenPath ? (
        <p className="edit-card-wrote break-all">Wrote {writtenPath}</p>
      ) : null}
    </article>
  )
}

export default function EditProposals({ edits, compact }: Props): React.JSX.Element | null {
  if (!edits.length) return null
  return (
    <div className="edit-proposals">
      {edits.map((edit) => (
        <EditCard key={edit.id} edit={edit} compact={compact} />
      ))}
    </div>
  )
}
