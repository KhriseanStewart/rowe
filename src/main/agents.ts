import { app, dialog, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { randomUUID } from 'crypto'
import { createThread, findThreadByAgentId, getThread, type HistoryThread } from './history'
import { getSettings, updateSettings } from './settings'
import { rememberFolderBookmark, withFolderAccess } from './local-folder'

export type StoredAgent = {
  id: string
  name: string
  slug: string
  threadId: string
  projectIds?: string[]
  attachmentPaths: string[]
  systemNote?: string
  createdAt: number
  updatedAt: number
}

type AgentsFile = {
  agents: StoredAgent[]
}

function agentsPath(): string {
  return join(app.getPath('userData'), 'agents.json')
}

function agentStateDir(slug: string): string {
  return join(app.getPath('userData'), 'agents', slug)
}

function readAgents(): AgentsFile {
  const path = agentsPath()
  if (!existsSync(path)) {
    return { agents: [] }
  }
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as AgentsFile
    return { agents: Array.isArray(data.agents) ? data.agents : [] }
  } catch {
    return { agents: [] }
  }
}

function writeAgents(data: AgentsFile): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(agentsPath(), JSON.stringify(data, null, 2))
}

export function slugifyAgentName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'agent'
}

export function listAgents(): StoredAgent[] {
  return readAgents()
    .agents.slice()
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

export function getAgent(nameOrId: string): StoredAgent | undefined {
  const needle = nameOrId.trim().toLowerCase()
  if (!needle) return undefined
  return readAgents().agents.find(
    (agent) =>
      agent.id === nameOrId ||
      agent.slug === needle ||
      agent.name.toLowerCase() === needle
  )
}

export function getOrCreateAgent(name: string): StoredAgent {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error('Agent name is required.')
  }
  const existing = getAgent(trimmed)
  if (existing) {
    const thread = getThread(existing.threadId) || findThreadByAgentId(existing.id)
    if (thread) {
      return { ...existing, threadId: thread.id }
    }
  }

  const id = randomUUID()
  const slug = uniqueSlug(slugifyAgentName(trimmed))
  const thread = createThread(trimmed, { agentId: id })
  const now = Date.now()
  const agent: StoredAgent = {
    id,
    name: trimmed,
    slug,
    threadId: thread.id,
    attachmentPaths: [],
    createdAt: now,
    updatedAt: now
  }
  const data = readAgents()
  data.agents.unshift(agent)
  writeAgents(data)
  mkdirSync(agentStateDir(slug), { recursive: true })
  return agent
}

function uniqueSlug(base: string): string {
  const agents = readAgents().agents
  if (!agents.some((agent) => agent.slug === base)) return base
  let index = 2
  while (agents.some((agent) => agent.slug === `${base}-${index}`)) {
    index += 1
  }
  return `${base}-${index}`
}

export function setActiveAgent(nameOrId: string | null): StoredAgent | null {
  if (!nameOrId) {
    updateSettings({ activeAgentId: undefined })
    return null
  }
  const agent = getAgent(nameOrId) || getOrCreateAgent(nameOrId)
  touchAgent(agent.id)
  updateSettings({ activeAgentId: agent.id })
  return getAgent(agent.id) || agent
}

export function clearActiveAgent(): void {
  updateSettings({ activeAgentId: undefined })
}

export function getActiveAgent(): StoredAgent | undefined {
  const id = getSettings().activeAgentId
  if (!id) return undefined
  return getAgent(id)
}

export function getAgentThread(agent: StoredAgent): HistoryThread | undefined {
  return getThread(agent.threadId) || findThreadByAgentId(agent.id)
}

export function touchAgent(agentId: string): void {
  const data = readAgents()
  const agent = data.agents.find((item) => item.id === agentId)
  if (!agent) return
  agent.updatedAt = Date.now()
  writeAgents(data)
}

export function attachPathToAgent(agentId: string, path: string): StoredAgent {
  const data = readAgents()
  const agent = data.agents.find((item) => item.id === agentId)
  if (!agent) {
    throw new Error('Agent was not found.')
  }
  const value = path.trim()
  if (!value || !existsSync(value)) {
    throw new Error('That file or folder was not found.')
  }
  if (!agent.attachmentPaths.includes(value)) {
    agent.attachmentPaths.push(value)
  }
  agent.updatedAt = Date.now()
  writeAgents(data)
  return agent
}

export async function pickAndAttachToAgent(
  agentId: string,
  sender?: Electron.WebContents
): Promise<StoredAgent | undefined> {
  const window = sender ? BrowserWindow.fromWebContents(sender) : BrowserWindow.getFocusedWindow()
  const options: Electron.OpenDialogOptions = {
    title: 'Attach to agent',
    buttonLabel: 'Attach',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    securityScopedBookmarks: process.platform === 'darwin'
  }
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths.length) {
    return undefined
  }
  let agent = getAgent(agentId)
  if (!agent) {
    throw new Error('Agent was not found.')
  }
  for (let i = 0; i < result.filePaths.length; i += 1) {
    const path = result.filePaths[i]
    const bookmark = result.bookmarks?.[i]
    if (bookmark) {
      rememberFolderBookmark(path, bookmark)
    }
    agent = attachPathToAgent(agent.id, path)
  }
  return agent
}

/** Bounded text summary of agent attachments for the ask prompt. */
export async function buildAgentAttachmentContext(agent: StoredAgent): Promise<string> {
  if (!agent.attachmentPaths.length) return ''
  const parts: string[] = [`Agent "${agent.name}" attachments:`]
  let budget = 12_000

  for (const path of agent.attachmentPaths.slice(0, 12)) {
    if (budget <= 0) break
    try {
      const stats = await withFolderAccess(path, () => statSync(path))
      if (stats.isDirectory()) {
        const line = `- folder: ${path}`
        parts.push(line)
        budget -= line.length
        continue
      }
      if (stats.size > 200_000) {
        const line = `- file: ${basename(path)} (${Math.round(stats.size / 1024)} KB, too large to inline)`
        parts.push(line)
        budget -= line.length
        continue
      }
      const text = await withFolderAccess(path, () =>
        readFileSync(path, 'utf8').slice(0, Math.min(4000, budget))
      )
      const block = `- file: ${basename(path)}\n\`\`\`\n${text}\n\`\`\``
      parts.push(block)
      budget -= block.length
    } catch {
      parts.push(`- missing: ${path}`)
    }
  }

  return parts.join('\n')
}

export function agentStatePath(slug: string): string {
  mkdirSync(agentStateDir(slug), { recursive: true })
  return join(agentStateDir(slug), 'state.json')
}

export function deleteAgent(nameOrId: string): StoredAgent[] {
  const agent = getAgent(nameOrId)
  if (!agent) return listAgents()
  const data = readAgents()
  data.agents = data.agents.filter((item) => item.id !== agent.id)
  writeAgents(data)
  if (getSettings().activeAgentId === agent.id) {
    clearActiveAgent()
  }
  return listAgents()
}
