import { BrowserWindow } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import {
  agentStatePath,
  buildAgentAttachmentContext,
  getAgent,
  getAgentThread,
  touchAgent,
  type StoredAgent
} from './agents'
import { appendMessage } from './history'
import { searchRag } from './rag/retrieve'
import { answerWithRag } from './rag/system-ai'
import { getSettings, planAllowsAskLocal, recordLocalPlanUsage } from './settings'
import { selectedReadyProjects } from './rag/projects'
import { wantsWorkspaceInventory, buildWorkspaceInventoryContext } from './rag/workspace'

export type AgentRunStatus = {
  agentId: string
  status: 'idle' | 'running' | 'waiting' | 'failed' | 'done'
  goal?: string
  progress?: string
  error?: string
  startedAt?: number
  updatedAt?: number
}

type RunnerState = {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  goal: string
  steps: number
  status: AgentRunStatus['status']
}

const runs = new Map<string, AgentRunStatus>()
const abortControllers = new Map<string, AbortController>()

const MAX_STEPS = 8

export function getAgentRunStatus(agentId: string): AgentRunStatus {
  return (
    runs.get(agentId) || {
      agentId,
      status: 'idle'
    }
  )
}

export function cancelAgentRun(agentId: string): boolean {
  const controller = abortControllers.get(agentId)
  if (!controller) {
    const current = runs.get(agentId)
    if (current && current.status === 'running') {
      runs.set(agentId, { ...current, status: 'idle', updatedAt: Date.now() })
      broadcast(agentId)
      return true
    }
    return false
  }
  controller.abort()
  abortControllers.delete(agentId)
  const current = getAgentRunStatus(agentId)
  runs.set(agentId, {
    ...current,
    status: 'idle',
    progress: 'Stopped',
    updatedAt: Date.now()
  })
  broadcast(agentId)
  return true
}

export async function startAgentRun(
  agent: StoredAgent,
  goal: string
): Promise<AgentRunStatus> {
  const trimmed = goal.trim()
  if (!trimmed) {
    throw new Error('Give the agent a goal to run.')
  }
  const allowed = planAllowsAskLocal()
  if (!allowed.ok) {
    throw new Error(allowed.message)
  }
  const existing = getAgentRunStatus(agent.id)
  if (existing.status === 'running') {
    throw new Error(`Agent "${agent.name}" is already running.`)
  }

  const controller = new AbortController()
  abortControllers.set(agent.id, controller)

  const status: AgentRunStatus = {
    agentId: agent.id,
    status: 'running',
    goal: trimmed,
    progress: 'Starting…',
    startedAt: Date.now(),
    updatedAt: Date.now()
  }
  runs.set(agent.id, status)
  broadcast(agent.id)

  void runLoop(agent, trimmed, controller.signal).catch((error) => {
    const message = error instanceof Error ? error.message : 'Agent run failed'
    runs.set(agent.id, {
      agentId: agent.id,
      status: 'failed',
      goal: trimmed,
      error: message,
      progress: message,
      startedAt: status.startedAt,
      updatedAt: Date.now()
    })
    broadcast(agent.id)
  })

  return status
}

async function runLoop(agent: StoredAgent, goal: string, signal: AbortSignal): Promise<void> {
  const state = loadState(agent) || {
    messages: [],
    goal,
    steps: 0,
    status: 'running' as const
  }
  state.goal = goal
  state.status = 'running'
  state.messages.push({
    role: 'user',
    content: `Background goal for agent "${agent.name}":\n${goal}\n\nWork step by step. When finished, reply with a clear summary and end with [DONE].`
  })
  saveState(agent, state)

  const thread = getAgentThread(agent)
  if (thread) {
    appendMessage(thread.id, {
      role: 'user',
      text: `[background] ${goal}`
    })
  }

  const projects = agent.projectIds?.length
    ? agent.projectIds
    : (await selectedReadyProjects()).map((project) => project.id)
  const attachments = await buildAgentAttachmentContext(agent)
  const inventory = wantsWorkspaceInventory(goal) ? await buildWorkspaceInventoryContext(goal) : ''

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (signal.aborted) {
      state.status = 'idle'
      saveState(agent, state)
      return
    }

    const plan = getSettings().plan
    if (plan) {
      const spend = plan.openRouterSpendUsd
      if (spend >= plan.openRouterBudgetUsd) {
        throw new Error('Monthly AI budget reached. Agent run stopped.')
      }
    }

    updateProgress(agent.id, `Step ${step + 1}/${MAX_STEPS}…`)

    let ragNote = ''
    try {
      const hits = await searchRag({
        question: `${goal}\n${state.messages.at(-1)?.content || ''}`,
        projectIds: projects,
        limit: 6
      })
      if (hits.length) {
        ragNote = hits
          .map(
            (hit, index) =>
              `[${index + 1}] ${hit.projectName}/${hit.path}:${hit.startLine}-${hit.endLine}\n${hit.content.slice(0, 800)}`
          )
          .join('\n\n')
      }
    } catch {
      ragNote = ''
    }

    const result = await answerWithRag({
      question: state.messages.at(-1)?.content || goal,
      projectIds: projects,
      history: state.messages.slice(0, -1),
      liveContext: [attachments, inventory, ragNote ? `Retrieved context:\n${ragNote}` : '']
        .filter(Boolean)
        .join('\n\n'),
      preferHints: [agent.name, agent.slug].filter(Boolean),
      enableFsTools: true,
      onDelta: () => undefined
    })

    if (result.usage) {
      recordLocalPlanUsage({
        openRouterSpendUsd: result.usage.costUsd,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        askCount: 1,
        source: 'agent-run'
      })
    }

    state.messages.push({ role: 'assistant', content: result.text })
    state.steps += 1
    saveState(agent, state)

    if (thread) {
      appendMessage(thread.id, { role: 'assistant', text: result.text })
    }
    touchAgent(agent.id)
    updateProgress(agent.id, result.text.slice(0, 120))

    if (/\[DONE\]/i.test(result.text) || signal.aborted) {
      break
    }

    state.messages.push({
      role: 'user',
      content:
        'Continue the background goal. If the work is complete, summarize and end with [DONE]. Otherwise take the next concrete step.'
    })
  }

  abortControllers.delete(agent.id)
  state.status = 'done'
  saveState(agent, state)
  runs.set(agent.id, {
    agentId: agent.id,
    status: 'done',
    goal,
    progress: 'Done',
    startedAt: runs.get(agent.id)?.startedAt,
    updatedAt: Date.now()
  })
  broadcast(agent.id)

  if (process.platform === 'darwin') {
    try {
      const { app } = await import('electron')
      app.dock?.bounce?.('informational')
    } catch {
      // ignore
    }
  }
}

function updateProgress(agentId: string, progress: string): void {
  const current = getAgentRunStatus(agentId)
  runs.set(agentId, {
    ...current,
    status: 'running',
    progress,
    updatedAt: Date.now()
  })
  broadcast(agentId)
}

function broadcast(agentId: string): void {
  const payload = getAgentRunStatus(agentId)
  const agent = getAgent(agentId)
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('agents:progress', {
      ...payload,
      name: agent?.name,
      slug: agent?.slug
    })
  }
}

function loadState(agent: StoredAgent): RunnerState | null {
  const path = agentStatePath(agent.slug)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunnerState
  } catch {
    return null
  }
}

function saveState(agent: StoredAgent, state: RunnerState): void {
  const path = agentStatePath(agent.slug)
  writeFileSync(path, JSON.stringify(state, null, 2))
}

/** Resume interrupted runs after app launch (best-effort). */
export function resumeInterruptedAgentRuns(): void {
  // Intentionally no auto-resume of long loops on launch — user restarts with /agent-run.
}
