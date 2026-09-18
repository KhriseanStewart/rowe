import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'

export type AuditStatus = 'success' | 'error' | 'needs_permission' | 'denied' | 'pending'

export type AuditEntry = {
  id: string
  at: number
  tool: string
  action: string
  path?: string
  status: AuditStatus
  detail?: string
}

function auditPath(): string {
  const dir = join(app.getPath('userData'), 'logs')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'tool-audit.jsonl')
}

export function appendAudit(entry: Omit<AuditEntry, 'id' | 'at'> & { at?: number }): AuditEntry {
  const full: AuditEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: entry.at ?? Date.now(),
    tool: entry.tool,
    action: entry.action,
    path: entry.path,
    status: entry.status,
    detail: entry.detail
  }
  appendFileSync(auditPath(), `${JSON.stringify(full)}\n`, 'utf8')
  return full
}

export function listAuditLog(limit = 50): AuditEntry[] {
  const path = auditPath()
  if (!existsSync(path)) return []
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    const parsed: AuditEntry[] = []
    for (const line of lines.slice(-Math.max(1, limit))) {
      try {
        parsed.push(JSON.parse(line) as AuditEntry)
      } catch {
        // skip bad line
      }
    }
    return parsed.reverse()
  } catch {
    return []
  }
}
