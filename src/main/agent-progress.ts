import { EventEmitter } from 'events'

export type AgentProgressPhase =
  | 'planning'
  | 'thinking'
  | 'reading'
  | 'writing'
  | 'shell'
  | 'indexing'
  | 'task'
  | 'tool'

export type AgentProgressEvent = {
  phase: AgentProgressPhase
  message: string
  taskId?: string
  ok?: boolean
}

class AgentProgressEmitter extends EventEmitter {
  emitProgress(payload: AgentProgressEvent): void {
    this.emit('progress', payload)
  }
}

export const agentProgress = new AgentProgressEmitter()

export function reportAgentProgress(payload: AgentProgressEvent): void {
  const message = String(payload.message || '')
  if (/\bresponse\s+safety\b|\buser\s+safety\b|^\s*safety\s*:/i.test(message)) {
    return
  }
  agentProgress.emitProgress({ ...payload, message })
}
