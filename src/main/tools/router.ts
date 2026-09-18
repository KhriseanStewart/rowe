import { BrowserWindow } from 'electron'
import { reportAgentProgress } from '../agent-progress'
import { getSettings } from '../settings'
import { runDocumentsTool } from './documents'
import { runFilesystemTool } from './filesystem'
import { runGithubTool } from './github-tools'
import { runOsControlTool } from './os-control'
import { dropPending, takePending } from './pending'
import { runScreenshotTool } from './screenshot'
import type { ToolCallRequest, ToolCallResponse, ToolContext } from './types'
import { broadcastStreamEvent } from './stream-server'

function newRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export const TOOL_NAMES = [
  'filesystem.list',
  'filesystem.read',
  'filesystem.write',
  'filesystem.mkdir',
  'filesystem.delete',
  'filesystem.exists',
  'filesystem.patch',
  'filesystem.shell',
  'documents.pdf',
  'documents.docx',
  'documents.xlsx',
  'documents.md',
  'documents.reveal',
  'github.create_branch',
  'github.commit_files',
  'github.open_pr',
  'github.get_repo',
  'github.clone',
  'github.pull',
  'github.push',
  'screenshot.list_windows',
  'screenshot.capture',
  'os.click',
  'os.type',
  'os.key',
  'os.focus_window'
] as const


function broadcastNeedsConfirm(response: ToolCallResponse, sender?: Electron.WebContents): void {
  if (response.status !== 'needs_confirmation') return
  if (sender && !sender.isDestroyed()) {
    sender.send('tools:needs-confirm', response)
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if (sender && win.webContents.id === sender.id) continue
    win.webContents.send('tools:needs-confirm', response)
  }
}

export async function invokeTool(
  request: ToolCallRequest,
  ctx: ToolContext = {}
): Promise<ToolCallResponse> {
  const requestId = request.requestId || newRequestId()
  const tool = String(request.tool || '').trim()
  const params = (request.params || {}) as Record<string, unknown>
  const trusted = ctx.trusted ?? Boolean(getSettings().trustedMode)
  const context: ToolContext = { ...ctx, trusted }

  if (!tool) {
    return { requestId, status: 'error', error: 'Missing tool name' }
  }

  reportAgentProgress({ phase: 'tool', message: `Running ${tool}…`, taskId: requestId })
  broadcastStreamEvent({ type: 'tool.progress', payload: { tool, requestId, message: `Running ${tool}…` } })
  const started = Date.now()

  try {
    let response: ToolCallResponse
    if (tool.startsWith('filesystem.')) {
      response = await runFilesystemTool(tool, params, requestId, context)
    } else if (tool.startsWith('documents.')) {
      response = await runDocumentsTool(tool, params, requestId, context)
    } else if (tool.startsWith('github.')) {
      response = await runGithubTool(tool, params, requestId, context)
    } else if (tool.startsWith('screenshot.')) {
      response = await runScreenshotTool(tool, params, requestId, context)
    } else if (tool.startsWith('os.')) {
      response = await runOsControlTool(tool, params, requestId, context)
    } else {
      response = { requestId, status: 'error', error: `Unknown tool: ${tool}` }
    }

    const ms = Date.now() - started
    if (response.status === 'success') {
      reportAgentProgress({
        phase: 'tool',
        message: `${tool} done (${ms}ms)`,
        taskId: requestId,
        ok: true
      })
    } else if (response.status === 'needs_confirmation') {
      reportAgentProgress({
        phase: 'tool',
        message: `${tool} waiting for confirmation`,
        taskId: requestId
      })
    } else if (response.status === 'needs_permission') {
      reportAgentProgress({
        phase: 'tool',
        message: `${tool} needs permission`,
        taskId: requestId,
        ok: false
      })
    } else {
      reportAgentProgress({
        phase: 'tool',
        message: `${tool} failed: ${response.error || 'error'}`,
        taskId: requestId,
        ok: false
      })
    }
    broadcastNeedsConfirm(response, context.sender)
    if (response.status === 'needs_confirmation') {
      broadcastStreamEvent({ type: 'tool.confirm', payload: response })
    } else {
      broadcastStreamEvent({ type: 'tool.result', payload: response })
    }
    return response
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool invoke failed'
    reportAgentProgress({ phase: 'tool', message: `${tool} failed`, taskId: requestId, ok: false })
    return { requestId, status: 'error', error: message }
  }
}

export async function confirmTool(
  requestId: string,
  approved: boolean
): Promise<ToolCallResponse> {
  if (!approved) {
    dropPending(requestId)
    reportAgentProgress({ phase: 'tool', message: 'Tool canceled', taskId: requestId, ok: false })
    return { requestId, status: 'error', error: 'User declined the tool action' }
  }
  const pending = takePending(requestId)
  if (!pending) {
    return { requestId, status: 'error', error: 'No pending tool confirmation for that requestId' }
  }
  reportAgentProgress({ phase: 'tool', message: `Confirming ${pending.request.tool}…`, taskId: requestId })
  return pending.execute()
}
