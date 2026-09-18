export type ToolStatus = 'success' | 'error' | 'needs_permission' | 'needs_confirmation'

export type ToolCallRequest = {
  tool: string
  params?: Record<string, unknown>
  requestId?: string
}

export type ToolCallResponse = {
  requestId: string
  status: ToolStatus
  result?: Record<string, unknown>
  error?: string
  /** When status is needs_confirmation, UI should show this preview then call tools:confirm */
  confirmation?: {
    title: string
    summary: string
    danger?: boolean
    preview?: Record<string, unknown>
  }
}

export type ToolContext = {
  sender?: Electron.WebContents
  /** Skip confirm gates (Trusted mode in Settings). */
  trusted?: boolean
}
