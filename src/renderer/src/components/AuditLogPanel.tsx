import { useCallback, useEffect, useState } from 'react'
import type { AuditLogEntry } from '../lib/toolUi'

type Props = {
  compact?: boolean
}

function statusLabel(status: string): string {
  if (status === 'success') return 'OK'
  if (status === 'error') return 'Error'
  if (status === 'needs_permission') return 'Needs permission'
  if (status === 'denied') return 'Denied'
  if (status === 'pending') return 'Pending'
  return status
}

export default function AuditLogPanel({ compact }: Props): React.JSX.Element {
  const [entries, setEntries] = useState<AuditLogEntry[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const next = await window.api.listAuditLog(compact ? 12 : 40)
      setEntries(next as AuditLogEntry[])
    } catch {
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [compact])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <section className={`audit-panel ${compact ? 'is-compact' : ''}`}>
      <div className="audit-panel-head">
        <p className="ui-section-title" style={{ margin: 0 }}>
          Tool audit
        </p>
        <button type="button" className="ui-btn ui-btn-ghost" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {loading ? (
        <p className="ui-copy">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="ui-copy">No tool actions logged yet. Writes, GitHub, and OS control will show up here.</p>
      ) : (
        <ul className="audit-list">
          {entries.map((entry) => (
            <li key={entry.id} className={`audit-row is-${entry.status}`}>
              <div className="audit-row-top">
                <span className="audit-tool">{entry.tool}</span>
                <span className="audit-status">{statusLabel(entry.status)}</span>
              </div>
              <p className="audit-action">{entry.action}</p>
              {entry.path ? <p className="audit-path">{entry.path}</p> : null}
              {entry.detail ? <p className="audit-detail">{entry.detail}</p> : null}
              <p className="audit-time">{new Date(entry.at).toLocaleString()}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
