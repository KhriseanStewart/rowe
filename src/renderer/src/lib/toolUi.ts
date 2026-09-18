/** Shared shapes for agent tool UI (matches main tool contract). */

export type ToolPermissionKind = 'screenRecording' | 'accessibility' | 'folderWrite'

export type AuditLogEntry = {
  id: string
  at: number
  tool: string
  action: string
  path?: string
  status: 'success' | 'error' | 'needs_permission' | 'denied' | 'pending'
  detail?: string
}

export type PermissionStatus = {
  screenRecording: 'granted' | 'denied' | 'unknown'
  accessibility: 'granted' | 'denied' | 'unknown'
}

export const TOOL_UI_PRELOAD = {
  getTrustedMode: 'settings:get-trusted-mode',
  setTrustedMode: 'settings:set-trusted-mode',
  listAuditLog: 'audit:list',
  getPermissionStatus: 'permissions:status',
  openPermissionSettings: 'permissions:open-settings'
} as const
