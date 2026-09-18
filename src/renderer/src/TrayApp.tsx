import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import ChatMarkdown from './components/ChatMarkdown'
import VoiceOrb from './components/VoiceOrb'
import { getUserPlan, planAllowsAsk, syncUsageAfterAsk } from './auth/plan'
import { useFirebaseUser } from './auth/useFirebaseUser'
import AgentTrail from './components/AgentTrail'
import ToolConfirmCards from './components/ToolConfirmCards'
import OsActionToast from './components/OsActionToast'
import EditProposals, { type ChatFileEdit } from './components/EditProposals'
import { formatAskError } from './lib/formatAskError'
import { parseRoweEditsFromText } from './lib/parseRoweEdits'

type Message = {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  edits?: ChatFileEdit[]
}

type Engine = 'cursor' | 'system'

type SlashCommand = {
  id: string
  label: string
  description: string
  engine?: Engine
  insert: string
}

const STORAGE_KEY = 'rowe-tray-engine'

const COMMANDS: SlashCommand[] = [
  {
    id: 'systemai',
    label: '/systemai',
    description: 'Answer with System AI over reference projects',
    engine: 'system',
    insert: '/systemai '
  },
  {
    id: 'cursor',
    label: '/cursor',
    description: 'Ask Cursor with your workspace context',
    engine: 'cursor',
    insert: '/cursor '
  },
  {
    id: 'agent',
    label: '/agent',
    description: 'Switch or create a named agent session',
    insert: '/agent '
  },
  {
    id: 'agents',
    label: '/agents',
    description: 'List named agents',
    insert: '/agents'
  },
  {
    id: 'agent-file',
    label: '/agent-file',
    description: 'Attach a file or folder to the active agent',
    insert: '/agent-file'
  },
  {
    id: 'agent-run',
    label: '/agent-run',
    description: 'Run the active agent in the background',
    insert: '/agent-run '
  },
  {
    id: 'agent-stop',
    label: '/agent-stop',
    description: 'Stop a background agent run',
    insert: '/agent-stop'
  },
  {
    id: 'clear',
    label: '/clear',
    description: 'Clear this quick-ask thread',
    insert: '/clear'
  },
  {
    id: 'hide',
    label: '/hide',
    description: 'Hide this panel (show again with Control-Command-S)',
    insert: '/hide'
  },
  {
    id: 'files',
    label: '/files',
    description: 'Allow Rowe to access a folder on this device',
    insert: '/files'
  },
  {
    id: 'app',
    label: '/app',
    description: 'Open the full Rowe window',
    insert: '/app'
  },
  {
    id: 'close',
    label: '/close',
    description: 'Quit Rowe completely',
    insert: '/close'
  }
]

function readEngine(): Engine {
  return window.localStorage.getItem(STORAGE_KEY) === 'system' ? 'system' : 'cursor'
}

function parseSlash(raw: string): {
  engine?: Engine
  text: string
  notice?: string
  command?: string
  arg?: string
} {
  const trimmed = raw.trim()
  const match = trimmed.match(
    /^\/(systemai|system|cursor|agent-file|agent-run|agent-stop|agents|agent|clear|hide|files|app|close)(?:\s+([\s\S]*))?$/i
  )
  if (!match) {
    return { text: raw }
  }
  const command = match[1].toLowerCase()
  const rest = (match[2] || '').trim()
  if (
    command === 'clear' ||
    command === 'app' ||
    command === 'hide' ||
    command === 'close' ||
    command === 'files' ||
    command === 'agents' ||
    command === 'agent-file' ||
    command === 'agent-stop'
  ) {
    return { text: '', command }
  }
  if (command === 'agent' || command === 'agent-run') {
    return { text: '', command, arg: rest }
  }
  const engine: Engine = command === 'cursor' ? 'cursor' : 'system'
  return {
    engine,
    text: rest,
    command,
    notice: engine === 'system' ? 'System AI' : 'Cursor'
  }
}

export default function TrayApp(): React.JSX.Element {
  const { user: firebaseUser } = useFirebaseUser()
  const [value, setValue] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [engine, setEngine] = useState<Engine>(readEngine)
  const [commandIndex, setCommandIndex] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [activeAgent, setActiveAgentState] = useState<{ name: string; slug: string } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const streamingIdRef = useRef<string | null>(null)
  const busyRef = useRef(false)

  const loadAgentMessages = async (nameOrId?: string): Promise<number> => {
    const thread = await window.api.getAgentThread(nameOrId)
    const next =
      (thread?.messages ?? []).map((item) => ({
        id: item.id,
        role: item.role as 'user' | 'assistant',
        text: item.text
      })) ?? []
    setMessages(next)
    return next.length
  }

  const switchAgent = async (name: string): Promise<void> => {
    const agent = await window.api.setActiveAgent(name)
    if (!agent) return
    setActiveAgentState({ name: agent.name, slug: agent.slug })
    setEngine('system')
    const count = await loadAgentMessages(agent.id)
    setMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role: 'system',
        text: `Switched to agent ${agent.name}${count ? ` (${count} messages)` : ' (new session)'}${
          agent.attachmentPaths.length ? ` · ${agent.attachmentPaths.length} attachments` : ''
        }`
      }
    ])
  }

  const clearInput = (): void => {
    setValue('')
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.style.height = 'auto'
    })
  }

  const slashQuery = useMemo(() => {
    if (!value.startsWith('/')) return null
    if (value.includes('\n')) return null
    const space = value.indexOf(' ')
    if (space !== -1) return null
    return value.slice(1).toLowerCase()
  }, [value])

  const filteredCommands = useMemo(() => {
    if (slashQuery == null) return []
    return COMMANDS.filter(
      (item) =>
        item.label.slice(1).startsWith(slashQuery) ||
        item.id.startsWith(slashQuery) ||
        item.description.toLowerCase().includes(slashQuery)
    )
  }, [slashQuery])

  const showCommands = filteredCommands.length > 0

  useEffect(() => {
    setCommandIndex(0)
  }, [slashQuery])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  useEffect(() => {
    inputRef.current?.focus()
    void window.api.isTrayExpanded().then(setExpanded).catch(() => undefined)
    void window.api
      .getActiveAgent()
      .then(async (agent) => {
        if (!agent) return
        setActiveAgentState({ name: agent.name, slug: agent.slug })
        await loadAgentMessages(agent.id)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, engine)
    void window.api.selectCompanionAi(engine).catch(() => undefined)
  }, [engine])

  useEffect(() => {
    const append = (chunk: string): void => {
      const id = streamingIdRef.current
      if (!id) return
      setMessages((current) =>
        current.map((message) =>
          message.id === id ? { ...message, text: message.text + chunk } : message
        )
      )
    }
    const offCursor = window.api.onCursorDelta(append)
    const offRag = window.api.onRagDelta(append)
    const offAgent = window.api.onAgentProgress((payload) => {
      const label = payload.name || 'agent'
      if (payload.status === 'done') {
        pushSystem(`${label} finished background run.`)
        void loadAgentMessages(payload.agentId)
      } else if (payload.status === 'failed') {
        pushSystem(`${label} failed: ${payload.error || 'unknown error'}`)
      } else if (payload.status === 'running' && payload.progress === 'Starting…') {
        pushSystem(`${label} is running in the background…`)
      }
    })
    return () => {
      offCursor()
      offRag()
      offAgent()
    }
  }, [])

  const pushSystem = (text: string): void => {
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'system', text }])
  }

  const askRowe = async (text: string, active: Engine): Promise<void> => {
    if (!text || busyRef.current) return

    if (firebaseUser) {
      const plan = await getUserPlan(firebaseUser).catch(() => null)
      const allowed = planAllowsAsk(plan)
      if (!allowed.ok) {
        setMessages((current) => [
          ...current,
          { id: crypto.randomUUID(), role: 'user', text },
          { id: crypto.randomUUID(), role: 'assistant', text: allowed.message }
        ])
        return
      }
    } else {
      const local = await window.api.getPlanStatus().catch(() => null)
      if (!local) {
        setMessages((current) => [
          ...current,
          { id: crypto.randomUUID(), role: 'user', text },
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            text: 'Choose a Rowe plan in the app Settings before asking from the tray.'
          }
        ])
        return
      }
    }

    const assistantId = crypto.randomUUID()
    streamingIdRef.current = assistantId
    busyRef.current = true
    setBusy(true)
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: 'user', text },
      { id: assistantId, role: 'assistant', text: '' }
    ])

    const finalize = (finalText: string): void => {
      setMessages((current) =>
        current.map((item) => {
          if (item.id !== assistantId) return item
          // Prefer the final cleaned reply (edit fences stripped) over streamed raw text.
          const next = finalText.trim() || item.text.trim()
          return { ...item, text: next || 'No response received.' }
        })
      )
    }

    try {
      if (active === 'system') {
        const auth = await window.api.getAuthStatus()
        if (!auth.ragConfigured) {
          throw new Error('System AI isn’t configured yet. Open the full Rowe app to finish setup.')
        }
        const activeAgent = await window.api.getActiveAgent()
        if (!auth.trayFileAccess && !activeAgent?.attachmentPaths.length) {
          pushSystem('System AI needs folder access on this device before it can use your files.')
          const access = await window.api.requestTrayFileAccess({ question: text })
          if (!access.granted) {
            throw new Error('Folder access was not granted. Use /files when you are ready to add a folder.')
          }
          pushSystem(
            access.path
              ? `File access allowed for ${access.path}. Local apps inside this folder can be found by name (including close misspellings).`
              : 'File access allowed. Local apps inside granted folders can be found by name.'
          )
        }
        const projects = await window.api.listProjects()
        const selected = projects
          .filter((project) => project.selected && project.status === 'ready')
          .map((project) => project.id)
        const result = await window.api.askRag(
          text,
          selected,
          messages
            .filter((message) => message.role === 'user' || message.role === 'assistant')
            .filter((message) => message.text.trim())
            .map((message) => ({
              role: message.role as 'user' | 'assistant',
              content: message.text
            }))
        )
        const parsedEdits = parseRoweEditsFromText(result.text || '')
        const edits = result.edits?.length ? result.edits : parsedEdits.edits
        finalize(parsedEdits.edits.length ? parsedEdits.text : result.text)
        if (edits.length) {
          setMessages((current) =>
            current.map((item) => (item.id === assistantId ? { ...item, edits } : item))
          )
        }
        if (firebaseUser && result.usage) {
          await syncUsageAfterAsk(firebaseUser, {
            openRouterSpendUsd: result.usage.costUsd,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            askCount: 1,
            source: 'tray-system'
          }).catch(() => undefined)
        } else if (firebaseUser) {
          await syncUsageAfterAsk(firebaseUser, {
            askCount: 1,
            source: 'tray-system'
          }).catch(() => undefined)
        }
      } else {
        const reply = await window.api.sendCursorPrompt(text)
        finalize(reply)
        if (firebaseUser) {
          await syncUsageAfterAsk(firebaseUser, {
            askCount: 1,
            source: 'tray-cursor'
          }).catch(() => undefined)
        }
      }
    } catch (error) {
      const message = formatAskError(error)
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantId
            ? { ...item, text: item.text ? `${item.text}\n\n${message}` : message }
            : item
        )
      )
    } finally {
      streamingIdRef.current = null
      busyRef.current = false
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  const applyCommand = (command: SlashCommand): void => {
    if (command.id === 'clear') {
      setMessages([])
      clearInput()
      return
    }
    if (command.id === 'hide') {
      clearInput()
      void window.api.closeWindow()
      return
    }
    if (command.id === 'files') {
      clearInput()
      void (async () => {
        const result = await window.api.requestTrayFileAccess()
        pushSystem(
          result.granted
            ? result.path
              ? `File access allowed for ${result.path}. Apps inside this folder are discoverable by name.`
              : 'File access already allowed. Use /files again to add another folder.'
            : 'File access was not granted. Use /files when you’re ready.'
        )
      })()
      return
    }
    if (command.id === 'agents') {
      clearInput()
      void (async () => {
        const agents = await window.api.listAgents()
        pushSystem(
          agents.length
            ? `Agents: ${agents.map((agent) => agent.name).join(', ')}`
            : 'No agents yet. Use /agent <name> to create one.'
        )
      })()
      return
    }
    if (command.id === 'agent-file') {
      clearInput()
      void (async () => {
        try {
          const agent = await window.api.attachToAgent()
          if (!agent) {
            pushSystem('Attach cancelled.')
            return
          }
          setActiveAgentState({ name: agent.name, slug: agent.slug })
          pushSystem(
            `Attached to ${agent.name}. ${agent.attachmentPaths.length} attachment${
              agent.attachmentPaths.length === 1 ? '' : 's'
            }.`
          )
        } catch (error) {
          pushSystem(error instanceof Error ? error.message : 'Could not attach file.')
        }
      })()
      return
    }
    if (command.id === 'agent-stop') {
      clearInput()
      void (async () => {
        const result = await window.api.stopAgent()
        pushSystem(result.stopped ? 'Background agent stopped.' : 'No running agent to stop.')
      })()
      return
    }
    if (command.id === 'app') {
      clearInput()
      void window.api.showApp()
      return
    }
    if (command.id === 'close') {
      clearInput()
      void window.api.quitApp()
      return
    }
    if (command.engine) {
      const next = command.engine
      if (next !== engine) {
        setEngine(next)
        pushSystem(next === 'system' ? 'Switched to System AI' : 'Switched to Cursor')
      } else {
        pushSystem(next === 'system' ? 'System AI' : 'Cursor')
      }
      clearInput()
      requestAnimationFrame(() => inputRef.current?.focus())
      return
    }
    setValue(command.insert)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 72)}px`
      el.setSelectionRange(command.insert.length, command.insert.length)
    })
  }

  const submit = async (raw: string): Promise<void> => {
    const parsed = parseSlash(raw)
    if (parsed.command === 'clear') {
      setMessages([])
      clearInput()
      return
    }
    if (parsed.command === 'hide') {
      clearInput()
      void window.api.closeWindow()
      return
    }
    if (parsed.command === 'files') {
      clearInput()
      const result = await window.api.requestTrayFileAccess()
      pushSystem(
        result.granted
          ? result.path
            ? `File access allowed for ${result.path}. Apps inside this folder are discoverable by name.`
            : 'File access already allowed. Use /files again to add another folder.'
          : 'File access was not granted. Use /files when you’re ready.'
      )
      return
    }
    if (parsed.command === 'agents') {
      clearInput()
      const agents = await window.api.listAgents()
      pushSystem(
        agents.length
          ? `Agents: ${agents.map((agent) => agent.name).join(', ')}`
          : 'No agents yet. Use /agent <name> to create one.'
      )
      return
    }
    if (parsed.command === 'agent') {
      clearInput()
      const arg = (parsed.arg || '').trim()
      if (!arg) {
        const active = await window.api.getActiveAgent()
        pushSystem(active ? `Active agent: ${active.name}` : 'No active agent. Use /agent <name>.')
        return
      }
      if (arg.toLowerCase() === 'off') {
        await window.api.clearActiveAgent()
        setActiveAgentState(null)
        pushSystem('Agent cleared. Asks use the quick tray thread again.')
        return
      }
      await switchAgent(arg)
      return
    }
    if (parsed.command === 'agent-file') {
      clearInput()
      try {
        const agent = await window.api.attachToAgent()
        if (!agent) {
          pushSystem('Attach cancelled.')
          return
        }
        setActiveAgentState({ name: agent.name, slug: agent.slug })
        pushSystem(
          `Attached to ${agent.name}. ${agent.attachmentPaths.length} attachment${
            agent.attachmentPaths.length === 1 ? '' : 's'
          }.`
        )
      } catch (error) {
        pushSystem(error instanceof Error ? error.message : 'Could not attach file.')
      }
      return
    }
    if (parsed.command === 'agent-run') {
      clearInput()
      const goal = (parsed.arg || '').trim()
      if (!goal) {
        pushSystem('Usage: /agent-run <goal>')
        return
      }
      try {
        const status = await window.api.runAgent({ goal })
        pushSystem(`Background run started${status.goal ? `: ${status.goal}` : ''}`)
      } catch (error) {
        pushSystem(error instanceof Error ? error.message : 'Could not start agent run.')
      }
      return
    }
    if (parsed.command === 'agent-stop') {
      clearInput()
      const result = await window.api.stopAgent()
      pushSystem(result.stopped ? 'Background agent stopped.' : 'No running agent to stop.')
      return
    }
    if (parsed.command === 'app') {
      clearInput()
      void window.api.showApp()
      return
    }
    if (parsed.command === 'close') {
      clearInput()
      void window.api.quitApp()
      return
    }

    let active = engine
    if (parsed.engine) {
      active = parsed.engine
      if (parsed.engine !== engine) {
        setEngine(parsed.engine)
        if (parsed.notice) pushSystem(`Switched to ${parsed.notice}`)
      }
    }
    if (!parsed.text) {
      // `/systemai` alone = switch engine, don't send an empty ask
      if (parsed.engine && parsed.engine === engine) {
        pushSystem(parsed.engine === 'system' ? 'System AI' : 'Cursor')
      }
      clearInput()
      return
    }
    clearInput()
    await askRowe(parsed.text, active)
  }

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (showCommands && filteredCommands[commandIndex]) {
      applyCommand(filteredCommands[commandIndex])
      return
    }
    const text = value.trim()
    if (!text || busy) return
    await submit(text)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (showCommands) {
        clearInput()
        return
      }
      void window.api.closeWindow()
      return
    }

    if (showCommands) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setCommandIndex((index) => (index + 1) % filteredCommands.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setCommandIndex((index) => (index - 1 + filteredCommands.length) % filteredCommands.length)
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        applyCommand(filteredCommands[commandIndex] || filteredCommands[0])
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (showCommands && filteredCommands[commandIndex]) {
        applyCommand(filteredCommands[commandIndex])
        return
      }
      const text = value.trim()
      if (!text || busy) return
      void submit(text)
    }
  }

  return (
    <div
      className="tray-hud flex h-full flex-col overflow-hidden"
      onMouseEnter={() => {
        inputRef.current?.focus()
      }}
    >
      <form className="tray-composer shrink-0" onSubmit={onSubmit}>
        <div className="tray-input-shell">
          <div
            className={`tray-brand ${engine === 'system' ? 'is-system' : 'is-cursor'}${busy ? ' is-thinking' : ''}`}
            aria-hidden={!busy}
          >
            {busy ? <VoiceOrb className="tray-brand-orb" label="Rowe thinking" /> : null}
            <span className="tray-brand-label">
              {activeAgent ? `Agent · ${activeAgent.name}` : engine === 'system' ? 'System' : 'Cursor'}
            </span>
          </div>
          <textarea
            ref={inputRef}
            rows={1}
            className="tray-input"
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              const el = event.target
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 72)}px`
            }}
            onKeyDown={onKeyDown}
            placeholder={busy ? 'Thinking…' : 'Ask Rowe…'}
            aria-label="Ask Rowe"
            disabled={busy}
          />
          <button
            type="button"
            className="tray-expand"
            aria-label={expanded ? 'Collapse tray' : 'Expand tray'}
            aria-pressed={expanded}
            onClick={() => {
              void window.api.toggleTrayExpand().then(setExpanded)
            }}
          >
            {expanded ? (
              <svg className="size-2.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M4.5 3.5h3v1.2h-1.8V6.5H4.5V3.5Zm4 0h3V6.5h-1.2V4.7H8.5V3.5Zm-4 6h1.2v1.8H8.5v1.2h-3V9.5Zm5.8 0H12.5v3h-3v-1.2h1.8V9.5Z" />
              </svg>
            ) : (
              <svg className="size-2.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <path d="M3.5 3.5h3.2v1.2H4.7v1.8H3.5V3.5Zm5.8 0H12.5V6.5h-1.2V4.7H9.3V3.5ZM3.5 9.5h1.2v1.8h1.8v1.2H3.5V9.5Zm7.8 0H12.5v3H9.3v-1.2h1.8V9.5Z" />
              </svg>
            )}
          </button>
          <button type="submit" disabled={(!value.trim() && !showCommands) || busy} aria-label="Send" className="tray-send">
            <svg className="size-2.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M8 2.4a.7.7 0 0 1 .7.7v7.9l2.3-2.3a.7.7 0 1 1 1 1L8.5 13.7a.7.7 0 0 1-1 0L3.95 9.7a.7.7 0 0 1 1-1l2.35 2.35V3.1A.7.7 0 0 1 8 2.4Z" />
            </svg>
          </button>
        </div>
      </form>

      {showCommands ? (
        <div className="tray-commands" role="listbox" aria-label="Commands">
          {filteredCommands.map((command, index) => (
            <button
              key={command.id}
              type="button"
              role="option"
              aria-selected={index === commandIndex}
              className={`tray-command ${index === commandIndex ? 'is-active' : ''}`}
              onMouseEnter={() => setCommandIndex(index)}
              onClick={() => applyCommand(command)}
            >
              <span className="tray-command-label">{command.label}</span>
              <span className="tray-command-desc">{command.description}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div
        ref={listRef}
        className={`tray-stream min-h-0 flex-1 overflow-auto ${
          messages.length === 0 ? 'flex items-start' : ''
        }`}
      >
        {messages.length === 0 && !showCommands ? (
          <p className="tray-hint">
            Type / for commands · /agent name · /files · /hide ·{' '}
            {window.api.platform === 'darwin' ? '⌃⌘S' : 'Ctrl+Alt+S'} to show
          </p>
        ) : messages.length === 0 ? (
          <>
            <OsActionToast compact />
            <ToolConfirmCards compact />
          </>
        ) : (
          <>
          <OsActionToast compact />
          <ToolConfirmCards compact />
          <div className="tray-messages">
            {messages.map((message, index) => {
              const parsed =
                message.role === 'assistant' && !message.edits?.length && message.text.includes('```rowe-edit')
                  ? parseRoweEditsFromText(message.text)
                  : null
              const displayText = parsed?.edits.length ? parsed.text : message.text
              const displayEdits = message.edits?.length ? message.edits : parsed?.edits
              const emptyAssistant =
                message.role === 'assistant' && !displayText && !displayEdits?.length
              if (emptyAssistant && !busy) return null
              const userRequest =
                message.role === 'assistant'
                  ? [...messages].slice(0, index).reverse().find((item) => item.role === 'user')?.text
                  : undefined

              return (
                <div
                  key={message.id}
                  className={
                    message.role === 'user'
                      ? 'tray-line tray-line-user'
                      : message.role === 'system'
                        ? 'tray-line tray-line-meta'
                        : 'tray-line tray-line-assistant'
                  }
                >
                  {message.role === 'assistant' &&
                  message.id ===
                    [...messages].reverse().find((item) => item.role === 'assistant')?.id ? (
                    <AgentTrail active={busy} compact />
                  ) : null}
                  {emptyAssistant && busy ? (
                    <div className="tray-thinking" aria-label="Thinking">
                      <span className="tray-pulse" aria-hidden />
                    </div>
                  ) : displayText || displayEdits?.length ? (
                    message.role === 'assistant' ? (
                      <>
                        {displayText ? (
                          <ChatMarkdown
                            text={displayText}
                            tone="assistant"
                            hideCopy
                            userRequest={userRequest}
                          />
                        ) : null}
                        {displayEdits?.length ? <EditProposals edits={displayEdits} compact /> : null}
                      </>
                    ) : (
                      <p className="whitespace-pre-wrap">{message.text}</p>
                    )
                  ) : null}
                </div>
              )
            })}
          </div>
          </>
        )}
      </div>
    </div>
  )
}
