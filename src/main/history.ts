import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'

export type HistoryMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  image?: string
  createdAt: number
}

export type HistoryThread = {
  id: string
  title: string
  agentId?: string
  createdAt: number
  updatedAt: number
  messages: HistoryMessage[]
}

type HistoryFile = {
  threads: HistoryThread[]
}

function historyPath(): string {
  return join(app.getPath('userData'), 'history.json')
}

function readHistory(): HistoryFile {
  const path = historyPath()
  if (!existsSync(path)) {
    return { threads: [] }
  }
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as HistoryFile
    return { threads: Array.isArray(data.threads) ? data.threads : [] }
  } catch {
    return { threads: [] }
  }
}

function writeHistory(data: HistoryFile): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(historyPath(), JSON.stringify(data, null, 2))
}

export function listThreads(): Array<Omit<HistoryThread, 'messages'> & { preview: string }> {
  return readHistory()
    .threads.slice()
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map(({ messages, ...thread }) => ({
      ...thread,
      preview: messages.at(-1)?.text.trim().slice(0, 80) ?? ''
    }))
}

export function getThread(id: string): HistoryThread | undefined {
  return readHistory().threads.find((thread) => thread.id === id)
}

export function createThread(
  title = 'New chat',
  options?: { agentId?: string }
): HistoryThread {
  const now = Date.now()
  const thread: HistoryThread = {
    id: randomUUID(),
    title,
    agentId: options?.agentId,
    createdAt: now,
    updatedAt: now,
    messages: []
  }
  const data = readHistory()
  data.threads.unshift(thread)
  writeHistory(data)
  return thread
}

export function findThreadByAgentId(agentId: string): HistoryThread | undefined {
  return readHistory().threads.find((thread) => thread.agentId === agentId)
}

export function deleteThread(id: string): void {
  const data = readHistory()
  data.threads = data.threads.filter((thread) => thread.id !== id)
  writeHistory(data)
}

export function appendMessage(
  threadId: string,
  message: Omit<HistoryMessage, 'id' | 'createdAt'> & { id?: string }
): HistoryMessage {
  const data = readHistory()
  const thread = data.threads.find((item) => item.id === threadId)
  if (!thread) {
    throw new Error('Chat not found')
  }

  const saved: HistoryMessage = {
    id: message.id ?? randomUUID(),
    role: message.role,
    text: message.text,
    image: message.image,
    createdAt: Date.now()
  }
  thread.messages.push(saved)
  thread.updatedAt = saved.createdAt
  if (thread.title === 'New chat' && message.role === 'user' && message.text.trim()) {
    thread.title = message.text.trim().slice(0, 42)
  }
  writeHistory(data)
  return saved
}

export function updateMessage(threadId: string, messageId: string, text: string): void {
  const data = readHistory()
  const thread = data.threads.find((item) => item.id === threadId)
  const message = thread?.messages.find((item) => item.id === messageId)
  if (!thread || !message) {
    return
  }
  message.text = text
  thread.updatedAt = Date.now()
  writeHistory(data)
}

export function setThreadAgent(threadId: string, agentId: string): void {
  const data = readHistory()
  const thread = data.threads.find((item) => item.id === threadId)
  if (!thread) {
    return
  }
  thread.agentId = agentId
  writeHistory(data)
}
