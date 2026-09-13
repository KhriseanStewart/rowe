import { Agent, Cursor, CursorAgentError, type SDKAgent } from '@cursor/sdk'
import { prepareSnipRuntime } from './snip'
import { getSettings, updateSettings } from './settings'
import { appendMessage, getThread, setThreadAgent, updateMessage } from './history'

export type CursorConnection = {
  apiKeyName: string
  email?: string
  models: string[]
}

const agents = new Map<string, SDKAgent>()
let connectedApiKey: string | undefined
let selectedModel = 'composer-2.5'
let sending = false

export function getCursorApiKey(): string | undefined {
  return connectedApiKey ?? getSettings().cursorKey
}

export async function connectCursor(apiKey?: string): Promise<CursorConnection> {
  const key = resolveCursorApiKey(apiKey)

  try {
    const [me, models] = await Promise.all([
      Cursor.me({ apiKey: key }),
      Cursor.models.list({ apiKey: key })
    ])

    connectedApiKey = key
    selectedModel = pickModel(models.map((model) => model.id))
    updateSettings({ cursorKey: key })
    await disposeCursor()

    return {
      apiKeyName: me.apiKeyName,
      email: me.userEmail,
      models: models.map((model) => model.id)
    }
  } catch (error) {
    connectedApiKey = undefined
    throw toError(error, 'Failed to connect Cursor API key')
  }
}

export function disconnectCursor(): void {
  connectedApiKey = undefined
  updateSettings({ cursorKey: undefined })
  void disposeCursor()
}

export type CursorImage = {
  data: string
  mimeType: string
}

export async function sendCursorPrompt(
  text: string,
  onDelta: (chunk: string) => void,
  images?: CursorImage[],
  threadId?: string
): Promise<string> {
  const prompt = text.trim()
  if (!prompt) {
    throw new Error('Message is empty')
  }
  if (sending) {
    throw new Error('Rowe is still answering')
  }

  sending = true
  let assistantId: string | undefined

  try {
    if (threadId) {
      const user = appendMessage(threadId, { role: 'user', text: prompt })
      const assistant = appendMessage(threadId, { role: 'assistant', text: '' })
      assistantId = assistant.id
      void user
    }

    const current = await getOrCreateAgent(threadId)
    const run = await current.send(
      images?.length
        ? {
            text: prompt,
            images: images.map((image) => ({
              data: image.data.replace(/^data:[^;]+;base64,/, ''),
              mimeType: image.mimeType
            }))
          }
        : prompt
    )
    let output = ''

    if (run.supports('stream')) {
      for await (const event of run.stream()) {
        if (event.type !== 'assistant') {
          continue
        }

        const chunk = event.message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')

        const delta = chunk.startsWith(output) ? chunk.slice(output.length) : chunk
        if (!delta) {
          continue
        }

        output = chunk.startsWith(output) ? chunk : output + chunk
        if (threadId && assistantId) {
          updateMessage(threadId, assistantId, output)
        }
        onDelta(delta)
      }
    }

    const result = await run.wait()
    if (result.status === 'error') {
      throw new Error(result.error?.message ?? 'The agent run failed')
    }

    const finalText = result.result ?? output
    if (!output && finalText) {
      onDelta(finalText)
    }
    if (threadId && assistantId) {
      updateMessage(threadId, assistantId, finalText)
    }

    return finalText
  } catch (error) {
    throw toError(error, 'Failed to send message')
  } finally {
    sending = false
  }
}

export async function disposeCursor(): Promise<void> {
  const open = [...agents.values()]
  agents.clear()
  await Promise.all(
    open.map(async (current) => {
      try {
        await current[Symbol.asyncDispose]()
      } catch {
        // ignore dispose errors
      }
    })
  )
}

async function getOrCreateAgent(threadId?: string): Promise<SDKAgent> {
  if (!connectedApiKey) {
    await connectCursor()
  }

  const key = threadId ?? 'ephemeral'
  const existing = agents.get(key)
  if (existing) {
    return existing
  }

  const snip = prepareSnipRuntime()
  const local = {
    cwd: process.cwd(),
    dirs: snip ? [snip.workspace] : undefined,
    settingSources: ['project'] as Array<'project'>
  }

  const savedId = threadId ? getThread(threadId)?.agentId : undefined
  let created: SDKAgent
  if (savedId) {
    try {
      created = await Agent.resume(savedId, {
        apiKey: connectedApiKey!,
        model: { id: selectedModel },
        local
      })
    } catch {
      created = await Agent.create({
        apiKey: connectedApiKey!,
        model: { id: selectedModel },
        local
      })
    }
  } else {
    created = await Agent.create({
      apiKey: connectedApiKey!,
      model: { id: selectedModel },
      local
    })
  }

  agents.set(key, created)
  if (threadId) {
    setThreadAgent(threadId, created.agentId)
  }
  return created
}

function pickModel(models: string[]): string {
  if (models.includes('composer-2.5')) {
    return 'composer-2.5'
  }
  if (models.includes('auto')) {
    return 'auto'
  }
  return models[0] ?? 'composer-2.5'
}

function resolveCursorApiKey(apiKey?: string): string {
  const key =
    apiKey?.trim() ||
    getSettings().cursorKey?.trim() ||
    process.env.CURSOR_API_KEY?.trim() ||
    String(import.meta.env.CURSOR_API_KEY ?? '').trim()

  if (!key) {
    throw new Error('Missing Cursor API key. Connect one in Rowe.')
  }

  return key
}

function toError(error: unknown, fallback: string): Error {
  if (error instanceof CursorAgentError || error instanceof Error) {
    return new Error(error.message)
  }
  return new Error(fallback)
}
