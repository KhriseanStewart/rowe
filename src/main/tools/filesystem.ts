import { executeFsTool, type FsToolCall, type FsToolName } from '../fs-tools'
import { getSettings } from '../settings'
import { appendAudit } from './audit-log'
import { putPending } from './pending'
import type { ToolCallResponse, ToolContext } from './types'

const MAP: Record<string, FsToolName> = {
  'filesystem.list': 'list_dir',
  'filesystem.read': 'read_file',
  'filesystem.write': 'write_file',
  'filesystem.mkdir': 'mkdir',
  'filesystem.delete': 'delete_path',
  'filesystem.exists': 'path_exists',
  'filesystem.patch': 'patch_file',
  'filesystem.shell': 'run_shell'
}

const MUTATING = new Set(['write_file', 'mkdir', 'delete_path', 'patch_file', 'run_shell'])

export async function runFilesystemTool(
  tool: string,
  params: Record<string, unknown>,
  requestId: string,
  ctx: ToolContext
): Promise<ToolCallResponse> {
  const name = MAP[tool]
  if (!name) {
    return { requestId, status: 'error', error: `Unknown filesystem tool: ${tool}` }
  }

  const call: FsToolCall = { name, args: params }
  const trusted = ctx.trusted ?? Boolean(getSettings().trustedMode)
  const pathHint = String(params.path || params.cwd || '')

  if (MUTATING.has(name) && !trusted) {
    putPending(requestId, { tool, params, requestId }, async () => {
      const result = await executeFsTool(call, { preferHints: [], sender: ctx.sender })
      appendAudit({
        tool,
        action: name,
        path: result.path || pathHint || undefined,
        status: result.ok ? 'success' : 'error',
        detail: result.summary
      })
      return result.ok
        ? { requestId, status: 'success', result: { summary: result.summary, path: result.path, data: result.data as Record<string, unknown> | undefined } }
        : { requestId, status: 'error', error: result.summary, result: { path: result.path } }
    })
    appendAudit({ tool, action: name, path: pathHint || undefined, status: 'pending', detail: 'Awaiting confirmation' })
    return {
      requestId,
      status: 'needs_confirmation',
      confirmation: {
        title: `Confirm ${name}`,
        summary: pathHint ? `${name} → ${pathHint}` : `Run ${name}`,
        danger: name === 'delete_path' || name === 'run_shell',
        preview: { tool, params }
      }
    }
  }

  let result
  try {
    result = await executeFsTool(call, { preferHints: [], sender: ctx.sender })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack : undefined
    console.error('[rowe:fs] filesystem tool threw', { tool, pathHint, message, stack })
    appendAudit({ tool, action: name, path: pathHint || undefined, status: 'error', detail: message })
    return {
      requestId,
      status: 'error',
      error: message,
      result: { path: pathHint, stack }
    }
  }
  appendAudit({
    tool,
    action: name,
    path: result.path || pathHint || undefined,
    status: result.ok ? 'success' : 'error',
    detail: result.summary
  })
  if (!result.ok) {
    console.error('[rowe:fs] filesystem tool ok:false', JSON.stringify(result, null, 2))
    return { requestId, status: 'error', error: result.summary, result: { path: result.path, data: result.data as Record<string, unknown> | undefined } }
  }
  return {
    requestId,
    status: 'success',
    result: {
      summary: result.summary,
      path: result.path,
      data: result.data as Record<string, unknown> | undefined
    }
  }
}
