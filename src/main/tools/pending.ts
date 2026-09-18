import type { ToolCallRequest, ToolCallResponse } from './types'

type Pending = {
  request: ToolCallRequest
  execute: () => Promise<ToolCallResponse>
  createdAt: number
}

const pending = new Map<string, Pending>()

export function putPending(
  requestId: string,
  request: ToolCallRequest,
  execute: () => Promise<ToolCallResponse>
): void {
  pending.set(requestId, { request, execute, createdAt: Date.now() })
}

export function takePending(requestId: string): Pending | undefined {
  const hit = pending.get(requestId)
  if (hit) pending.delete(requestId)
  return hit
}

export function dropPending(requestId: string): boolean {
  return pending.delete(requestId)
}
