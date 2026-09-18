import { FormEvent, useEffect, useRef, useState } from 'react'
import AuthScreens from './auth/AuthScreens'
import { signOutRowe } from './auth/authActions'
import { readPresenceStats, type PresenceStats } from './auth/presence'
import { useFirebaseUser } from './auth/useFirebaseUser'
import { syncTokensSaved } from './auth/profile'
import ChatMarkdown from './components/ChatMarkdown'
import ChatSources, { splitMessageSources, uniqueCitations, type ChatCitation } from './components/ChatSources'
import AgentTrail from './components/AgentTrail'
import ToolConfirmCards from './components/ToolConfirmCards'
import OsActionToast from './components/OsActionToast'
import EditProposals, { type ChatFileEdit } from './components/EditProposals'
import { formatAskError } from './lib/formatAskError'
import { parseRoweEditsFromText } from './lib/parseRoweEdits'
import ProjectLibrary, { type ReferenceProject } from './components/ProjectLibrary'
import RoweMark from './components/RoweMark'
import SettingsPanel from './components/SettingsPanel'
import {
  getUserPlan,
  planAllowsAsk,
  remainingBudgetUsd,
  syncUsageAfterAsk,
  type UserPlan
} from './auth/plan'

type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  image?: string
  citations?: ChatCitation[]
  edits?: ChatFileEdit[]
  question?: string
}

type SnipGain = {
  ready: boolean
  commands: number
  tokensSaved: number
  avgSavings: number
  top: Array<{ command: string; runs: number; tokensSaved: number; avgSavings: number }>
}

type AuthStatus = {
  trayAsked: boolean
  trayEnabled: boolean
  trayFileAccess?: boolean
  github?: { login: string; name?: string; avatar?: string }
  cursor: boolean
  platform: string
  githubOAuth?: boolean
  ragConfigured?: boolean
}

type Thread = {
  id: string
  title: string
  agentId?: string
  updatedAt: number
  preview?: string
}

type AssistantMode = 'cursor' | 'system'

export default function App(): React.JSX.Element {
  const { user: firebaseUser } = useFirebaseUser()
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [cloudTokensSaved, setCloudTokensSaved] = useState(0)
  const [showSettings, setShowSettings] = useState(false)
  const [userPlan, setUserPlan] = useState<UserPlan | null>(null)
  const [threads, setThreads] = useState<Thread[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [gain, setGain] = useState<SnipGain | null>(null)
  const [presence, setPresence] = useState<PresenceStats | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [projects, setProjects] = useState<ReferenceProject[]>([])
  const [showProjects, setShowProjects] = useState(false)
  const [librarySource, setLibrarySource] = useState<'github' | 'local'>('github')
  const [assistantMode, setAssistantMode] = useState<AssistantMode>(() => {
    return window.localStorage.getItem('rowe-assistant-mode') === 'system' ? 'system' : 'cursor'
  })
  const [activeAgentName, setActiveAgentName] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const streamingIdRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const threadIdRef = useRef<string | null>(null)

  useEffect(() => {
    threadIdRef.current = threadId
  }, [threadId])

  useEffect(() => {
    void window.api.getAuthStatus().then(setAuth)
    void window.api.listHistory().then(setThreads)
    void window.api.listProjects().then(setProjects).catch(() => undefined)
    void window.api
      .getActiveAgent()
      .then((agent) => setActiveAgentName(agent?.name ?? null))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!showProjects) return
    void window.api.listProjects().then(setProjects).catch(() => undefined)
  }, [showProjects])

  const openThread = async (id: string): Promise<void> => {
    const thread = await window.api.getHistory(id)
    setThreadId(id)
    setShowProjects(false)
    setMessages(
      (thread?.messages ?? []).map((item) => {
        const parsed = splitMessageSources(item.text)
        return {
          id: item.id,
          role: item.role,
          text: parsed.body,
          image: item.image,
          citations: parsed.citations
        }
      })
    )
    if (thread?.agentId) {
      const agent = await window.api.setActiveAgent(thread.agentId)
      setActiveAgentName(agent?.name ?? null)
      if (agent) setAssistantMode('system')
    } else {
      await window.api.clearActiveAgent()
      setActiveAgentName(null)
    }
  }
  useEffect(() => window.api.onRagDelta((chunk) => {
    const id = streamingIdRef.current
    if (!id) return
    setMessages((current) => current.map((message) => message.id === id ? { ...message, text: message.text + chunk } : message))
  }), [])

  useEffect(
    () =>
      window.api.onRagProgress((payload) => {
        setProjects((current) =>
          current.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  status: payload.status,
                  filesSeen: payload.filesSeen,
                  filesTotal: payload.filesTotal,
                  chunksWritten: payload.chunksWritten,
                  files: payload.status === 'ready' ? payload.filesSeen : project.files,
                  chunks: payload.status === 'ready' ? payload.chunksWritten : project.chunks,
                  error: payload.error
                }
              : project
          )
        )
      }),
    []
  )

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: 'end' })
  }, [messages])

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  useEffect(() => {
    if (!firebaseUser) {
      setUserPlan(null)
      return
    }
    let cancelled = false
    void getUserPlan(firebaseUser)
      .then((next) => {
        if (!cancelled) setUserPlan(next)
      })
      .catch(() => {
        if (!cancelled) setUserPlan(null)
      })
    return () => {
      cancelled = true
    }
  }, [firebaseUser, showSettings])

  useEffect(() => {
    if (!firebaseUser) {
      return
    }
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const next = await readPresenceStats()
        if (!cancelled) {
          setPresence(next)
        }
      } catch {
        if (!cancelled) {
          setPresence(null)
        }
      }
    }
    void load()
    const timer = window.setInterval(() => {
      void load()
    }, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [firebaseUser])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const next = await window.api.getSnipGain()
        if (cancelled) return
        setGain(next)
        if (firebaseUser && next.ready) {
          const synced = await syncTokensSaved(firebaseUser, next.tokensSaved).catch(() => next.tokensSaved)
          if (!cancelled) setCloudTokensSaved(synced)
        }
      } catch {
        if (!cancelled) {
          setGain(null)
        }
      }
    }
    const timer = window.setInterval(() => {
      void load()
    }, 4000)
    const start = window.setTimeout(() => {
      void load()
    }, 0)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.clearTimeout(start)
    }
  }, [firebaseUser])

  useEffect(() => {
    return window.api.onCursorDelta((chunk) => {
      const id = streamingIdRef.current
      if (!id) {
        return
      }
      setMessages((current) =>
        current.map((message) =>
          message.id === id ? { ...message, text: message.text + chunk } : message
        )
      )
    })
  }, [])

  const connected = Boolean(firebaseUser && auth?.github && auth.cursor)
  const displayedPresence = firebaseUser ? presence : null
  const readyProjects = projects.filter((project) => project.status === 'ready')
  const selectedProjects = readyProjects.filter((project) => project.selected)
  const canAsk =
    assistantMode === 'system'
      ? Boolean(auth?.ragConfigured)
      : selectedProjects.length >= 3 && connected
  const askBlockedReason =
    assistantMode === 'system' && !auth?.ragConfigured
      ? 'Add AI provider credentials in .env, then restart Rowe'
      : assistantMode === 'cursor' && selectedProjects.length < 3
        ? 'Add 3 selected projects to start'
        : assistantMode === 'cursor' && !connected
          ? 'Connect Cursor to ask in Cursor mode'
          : null

  const exampleQuestions = [
    'How do these projects handle authentication?',
    'Compare how they structure API routes.',
    'Which error-handling approach fits a new feature best?'
  ]

  const switchAssistant = (mode: AssistantMode): void => {
    if (busyRef.current) return
    setAssistantMode(mode)
    window.localStorage.setItem('rowe-assistant-mode', mode)
  }

  const startThread = async (): Promise<string> => {
    const thread = await window.api.createHistory()
    setThreads(await window.api.listHistory())
    setThreadId(thread.id)
    setMessages([])
    return thread.id
  }

  const askRowe = async (text: string): Promise<void> => {
    if (!text || busyRef.current) {
      return
    }

    const agentMatch = text.trim().match(/^\/agent(?:\s+(.+))?$/i)
    if (agentMatch) {
      const arg = (agentMatch[1] || '').trim()
      if (!arg) {
        const active = await window.api.getActiveAgent()
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            text: active ? `Active agent: ${active.name}` : 'No active agent. Use /agent <name>.'
          }
        ])
        return
      }
      if (arg.toLowerCase() === 'off') {
        await window.api.clearActiveAgent()
        setActiveAgentName(null)
        setMessages((current) => [
          ...current,
          { id: crypto.randomUUID(), role: 'assistant', text: 'Agent cleared.' }
        ])
        return
      }
      const agent = await window.api.setActiveAgent(arg)
      if (agent) {
        setActiveAgentName(agent.name)
        setAssistantMode('system')
        setThreadId(agent.threadId)
        await openThread(agent.threadId)
        setThreads(await window.api.listHistory())
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            text: `Switched to agent ${agent.name}.`
          }
        ])
      }
      return
    }

    if (/^\/agents$/i.test(text.trim())) {
      const agents = await window.api.listAgents()
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: agents.length
            ? `Agents: ${agents.map((agent) => agent.name).join(', ')}`
            : 'No agents yet. Use /agent <name>.'
        }
      ])
      return
    }

    if (/^\/agent-file$/i.test(text.trim())) {
      try {
        const agent = await window.api.attachToAgent()
        if (agent) {
          setActiveAgentName(agent.name)
          setMessages((current) => [
            ...current,
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              text: `Attached to ${agent.name} (${agent.attachmentPaths.length} attachments).`
            }
          ])
        }
      } catch (error) {
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            text: error instanceof Error ? error.message : 'Could not attach.'
          }
        ])
      }
      return
    }

    const runMatch = text.trim().match(/^\/agent-run(?:\s+(.+))?$/i)
    if (runMatch) {
      const goal = (runMatch[1] || '').trim()
      if (!goal) {
        setMessages((current) => [
          ...current,
          { id: crypto.randomUUID(), role: 'assistant', text: 'Usage: /agent-run <goal>' }
        ])
        return
      }
      try {
        await window.api.runAgent({ goal })
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            text: `Background run started: ${goal}`
          }
        ])
      } catch (error) {
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            text: error instanceof Error ? error.message : 'Could not start run.'
          }
        ])
      }
      return
    }

    if (/^\/agent-stop$/i.test(text.trim())) {
      const result = await window.api.stopAgent()
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: result.stopped ? 'Background agent stopped.' : 'No running agent to stop.'
        }
      ])
      return
    }

    const allowed = planAllowsAsk(userPlan)
    if (!allowed.ok) {
      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: 'user', text },
        { id: crypto.randomUUID(), role: 'assistant', text: allowed.message, question: text }
      ])
      setShowSettings(true)
      return
    }

    const activeId = threadIdRef.current ?? (await startThread())
    const assistantId = crypto.randomUUID()
    streamingIdRef.current = assistantId
    busyRef.current = true
    setBusy(true)
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: 'user', text },
      { id: assistantId, role: 'assistant', text: '', question: text }
    ])

    try {
      if (assistantMode === 'system') {
        const currentAuth = await window.api.getAuthStatus()
        const activeAgent = await window.api.getActiveAgent()
        // Attachments are already user-approved local context for named agents.
        // Otherwise ask once here, then continue this same ask after the picker closes.
        if (!currentAuth.trayFileAccess && !activeAgent?.attachmentPaths.length) {
          const access = await window.api.requestTrayFileAccess({ question: text })
          if (!access.granted) {
            throw new Error('Folder access was not granted. Use /files when you are ready to add a folder.')
          }
          setAuth(await window.api.getAuthStatus())
        }
        const result = await window.api.askRag(
          text,
          selectedProjects.map((project) => project.id),
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
        const cleanedText = (parsedEdits.edits.length ? parsedEdits.text : result.text).trim()
        setMessages((current) =>
          current.map((item) =>
            item.id === assistantId
              ? {
                  ...item,
                  question: text,
                  text: cleanedText || item.text,
                  citations: result.citations.length
                    ? result.citations.map((citation) => ({
                        projectName: citation.projectName,
                        path: citation.path,
                        startLine: citation.startLine,
                        endLine: citation.endLine,
                        content: citation.content
                      }))
                    : item.citations,
                  edits: edits.length ? edits : item.edits
                }
              : item
          )
        )
        if (firebaseUser && result.usage) {
          const next = await syncUsageAfterAsk(firebaseUser, {
            openRouterSpendUsd: result.usage.costUsd,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            askCount: 1,
            source: 'app-system'
          }).catch(() => null)
          if (next) setUserPlan(next)
        } else if (firebaseUser) {
          const next = await syncUsageAfterAsk(firebaseUser, {
            askCount: 1,
            source: 'app-system'
          }).catch(() => null)
          if (next) setUserPlan(next)
        }
      } else {
        await window.api.sendCursorPrompt(text, undefined, activeId)
        if (firebaseUser) {
          const next = await syncUsageAfterAsk(firebaseUser, {
            askCount: 1,
            source: 'app-cursor'
          }).catch(() => null)
          if (next) setUserPlan(next)
        }
      }
      setThreads(await window.api.listHistory())
    } catch (error) {
      const message = formatAskError(error)
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantId
            ? { ...item, text: item.text ? `${item.text}\n\n${message}` : message }
            : item
        )
      )
      if (/plan|budget|AI usage/i.test(message)) {
        setShowSettings(true)
      }
    } finally {
      streamingIdRef.current = null
      busyRef.current = false
      setBusy(false)
    }
  }

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const text = value.trim()
    if (!text) {
      return
    }
    setValue('')
    await askRowe(text)
  }

  const trayLabel = auth?.platform === 'darwin' ? 'menu bar' : 'system tray'
  const visibleThreads = threads.filter(
    (thread) => thread.id === threadId || Boolean(thread.preview?.trim())
  )
  const emptyThreadCount = threads.length - visibleThreads.length
  const planSpent = userPlan ? Math.max(0, userPlan.usage.openRouterSpendUsd) : 0
  const planBudget = userPlan ? Math.max(userPlan.openRouterBudgetUsd, 0.01) : 1
  const planRemaining = userPlan ? remainingBudgetUsd(userPlan) : 0
  const planSpendPct = userPlan ? Math.min(100, (planSpent / planBudget) * 100) : 0

  return (
    <div className="app-shell desktop-shell flex h-full min-h-0 overflow-hidden bg-agent-bg">
      <aside
        className={`${
          sidebarOpen ? 'flex' : 'hidden md:flex'
        } desktop-sidebar w-[min(100%,17.5rem)] shrink-0 flex-col pt-14`}
      >
        <div className="desktop-drag-rail flex items-center justify-between gap-3 px-4 pb-4">
          <div className="flex min-w-0 items-center gap-3">
            <RoweMark className="size-8" />
            <div className="min-w-0">
              <p className="text-[15px] font-semibold tracking-tight">Rowe</p>
              <p className="pt-0.5 text-[12px] text-agent-text-soft">
                {userPlan ? `${userPlan.planName}` : 'Workspace'}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="desktop-new-btn"
            onClick={() => {
              void startThread()
              setShowProjects(false)
            }}
          >
            New chat
          </button>
        </div>
        <button
          type="button"
          className={`desktop-nav-card mx-3 mb-3 flex items-center gap-3 rounded-2xl px-3 py-3 text-left ${showProjects ? 'is-active' : ''}`}
          onClick={() => setShowProjects(true)}
        >
          <span className="grid size-8 place-items-center rounded-lg bg-agent-accent/15 text-agent-accent">
            <svg
              className="size-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path d="m4 7 8-4 8 4-8 4-8-4Z" />
              <path d="m4 12 8 4 8-4M4 17l8 4 8-4" />
            </svg>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-bold">Reference projects</span>
            <span className="mt-0.5 block text-[12px] text-agent-text-soft">
              {readyProjects.length} ready · {selectedProjects.length} selected
            </span>
          </span>
          <span className="rounded-full bg-agent-fill-strong px-2 py-0.5 text-[11px] font-bold text-agent-text-soft">
            {projects.length}
          </span>
        </button>
        <ul className="min-h-0 flex-1 list-none overflow-auto px-3 pb-2">
          {visibleThreads.length === 0 ? (
            <li className="px-3 py-6 text-center text-[13px] text-agent-text-soft">
              No chats yet. Start one with New.
            </li>
          ) : (
            visibleThreads.map((thread) => (
              <li key={thread.id} className="pb-1">
                <button
                  type="button"
                  className={`desktop-thread w-full rounded-xl px-3 py-2.5 text-left ${
                    thread.id === threadId ? 'is-active' : ''
                  }`}
                  onClick={() => {
                    void openThread(thread.id)
                  }}
                >
                  <span className="flex items-center gap-2 truncate text-[14px] font-semibold tracking-tight">
                    <span className="truncate">{thread.title}</span>
                    {thread.agentId ? (
                      <span className="shrink-0 rounded-md bg-agent-fill px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-agent-text-soft">
                        Agent
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-agent-text-soft">
                    {thread.preview || 'Just started'}
                  </span>
                </button>
              </li>
            ))
          )}
          {emptyThreadCount > 0 ? (
            <li className="px-3 pt-2 text-[11px] font-medium text-agent-text-soft">
              {emptyThreadCount} empty chat{emptyThreadCount === 1 ? '' : 's'} hidden
            </li>
          ) : null}
        </ul>
        <div className="border-t border-[color:var(--desktop-hairline)] px-3 py-3">
          <button
            type="button"
            className="desktop-credits mb-3 flex w-full flex-col gap-2.5 text-left transition-opacity hover:opacity-95"
            onClick={() => setShowSettings(true)}
          >
            <span className="flex w-full items-center justify-between gap-2">
              <span className="text-[11px] font-semibold tracking-[0.06em] text-agent-text-soft uppercase">
                Credits
              </span>
              <span className="text-[12px] font-medium text-agent-accent">Manage</span>
            </span>
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-[13px] font-semibold tracking-tight">
                {userPlan ? userPlan.planName : 'No plan yet'}
              </span>
              <span className="text-[12px] tabular-nums text-agent-text-soft">
                {userPlan
                  ? `$${planSpent.toFixed(2)} / $${userPlan.openRouterBudgetUsd.toFixed(0)}`
                  : 'Choose a plan'}
              </span>
            </span>
            <span className="desktop-credits-meter" aria-hidden>
              <span style={{ width: `${userPlan ? planSpendPct : 0}%` }} />
            </span>
            <span className="flex items-center justify-between gap-2 text-[12px] text-agent-text-soft">
              <span>
                {userPlan
                  ? `$${planRemaining.toFixed(2)} left`
                  : 'Usage unlocks after you pick a plan'}
              </span>
              <span className="tabular-nums font-medium text-agent-text">
                {formatTokens(Math.max(gain?.tokensSaved ?? 0, cloudTokensSaved))} saved
              </span>
            </span>
            <span className="text-[11px] leading-4 text-agent-text-soft">{gainLabel(gain)}</span>
          </button>
          {displayedPresence ? (
            <p className="pt-3 text-[12px] text-agent-text-soft">
              {displayedPresence.activeLast5m} active · {displayedPresence.users} signed up
            </p>
          ) : null}
          {firebaseUser || auth?.github ? (
            <div className="desktop-account mt-1 flex flex-col gap-3">
              <div className="flex items-center gap-3">
                {auth?.github?.avatar ? (
                  <img
                    src={auth.github.avatar}
                    alt=""
                    className="size-9 rounded-full"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <span className="grid size-9 place-items-center rounded-full bg-agent-fill text-[13px] font-bold">
                    {(auth?.github?.login ?? firebaseUser?.email ?? 'R').slice(0, 1).toUpperCase()}
                  </span>
                )}
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold">
                    {auth?.github?.login ?? firebaseUser?.email}
                  </p>
                  {firebaseUser ? (
                    <p className="truncate text-[12px] text-agent-text-soft">
                      {firebaseUser.email || 'Signed in'}
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                <button
                  type="button"
                  className="ui-link text-[13px]"
                  onClick={() => setShowSettings(true)}
                >
                  Settings
                </button>
                {firebaseUser ? (
                  <button
                    type="button"
                    className="ui-link text-[13px]"
                    onClick={() => signOutRowe()}
                  >
                    Log out
                  </button>
                ) : null}
                {auth?.github || auth?.cursor ? (
                  <button
                    type="button"
                    className="ui-link text-[13px]"
                    onClick={() => {
                      void window.api.disconnect().then(setAuth)
                    }}
                  >
                    Disconnect keys
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </aside>

      <section className="desktop-main flex min-w-0 flex-1 flex-col pt-14">
        <header className="desktop-topbar flex h-12 items-center gap-3 border-b border-agent-stroke/60 px-5">
          <button
            type="button"
            className="rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-agent-text-soft hover:bg-agent-fill md:hidden"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            Chats
          </button>
          <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight">
            {showProjects
              ? 'Reference projects'
              : (activeAgentName
                  ? `Agent · ${activeAgentName}`
                  : (threads.find((thread) => thread.id === threadId)?.title ?? 'Ask Rowe'))}
          </h1>
          <div className="desktop-mode-toggle flex shrink-0 items-center rounded-full p-0.5" aria-label="Assistant mode">
            <button
              type="button"
              className={`rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors ${assistantMode === 'cursor' ? 'bg-agent-surface text-agent-text shadow-sm' : 'text-agent-text-soft hover:text-agent-text'}`}
              aria-pressed={assistantMode === 'cursor'}
              onClick={() => switchAssistant('cursor')}
            >
              Cursor
            </button>
            <button
              type="button"
              className={`rounded-full px-3 py-1.5 text-[12px] font-semibold transition-colors ${assistantMode === 'system' ? 'bg-agent-accent text-white shadow-sm' : 'text-agent-text-soft hover:text-agent-text'}`}
              aria-pressed={assistantMode === 'system'}
              onClick={() => switchAssistant('system')}
            >
              System AI
            </button>
          </div>
          <button
            type="button"
            className="rounded-full border border-[color:var(--desktop-hairline)] px-3 py-1.5 text-[12px] font-semibold text-agent-text-soft hover:bg-agent-fill hover:text-agent-text"
            onClick={() => setShowSettings(true)}
          >
            Settings
          </button>
          {auth?.trayEnabled ? (
            <span className="hidden text-[12px] text-agent-text-soft sm:inline">
              In {trayLabel}
            </span>
          ) : null}
        </header>

        {showProjects ? (
          <ProjectLibrary
            projects={projects}
            onProjectsChange={setProjects}
            onClose={() => setShowProjects(false)}
            initialSource={librarySource}
            github={auth?.github}
            githubOAuth={auth?.githubOAuth}
            onGithubConnected={async () => {
              setAuth(await window.api.getAuthStatus())
            }}
          />
        ) : (
          <>
            <div
              className={`flex min-h-0 flex-1 px-6 ${messages.length === 0 ? 'items-center justify-center' : ''}`}
            >
              {messages.length === 0 ? (
                <div className="mx-auto w-full max-w-xl px-2 text-center">
                  {selectedProjects.length < 3 ? (
                    <>
                      <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-agent-accent/15 text-agent-accent">
                        <svg
                          className="size-7"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                        >
                          <path d="m4 7 8-4 8 4-8 4-8-4Z" />
                          <path d="m4 12 8 4 8-4M4 17l8 4 8-4" />
                        </svg>
                      </div>
                      <p className="desktop-empty-title mt-6 text-[34px] font-semibold tracking-tight">
                        Build your reference library
                      </p>
                      <p className="mx-auto mt-3 max-w-md text-[15px] leading-6 text-agent-text-soft">
                        Add at least three GitHub repositories (including private) or local apps so
                        Rowe can compare patterns across codebases.
                      </p>
                      <div className="mt-5 flex items-center justify-center gap-2 text-[13px] font-semibold text-agent-text-soft">
                        {Array.from({ length: 3 }).map((_, index) => (
                          <span
                            key={index}
                            className={`size-2.5 rounded-full ${index < selectedProjects.length ? 'bg-agent-accent' : 'bg-agent-fill-strong'}`}
                          />
                        ))}
                        <span className="ml-1">{selectedProjects.length} of 3 selected</span>
                      </div>
                      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
                        <button
                          type="button"
                          className="ui-btn ui-btn-primary"
                          onClick={() => {
                            void (async () => {
                              try {
                                if (!auth?.github) {
                                  await window.api.connectGithubOAuth()
                                  setAuth(await window.api.getAuthStatus())
                                }
                              } catch {
                                // Open the library so a token can be used if OAuth is cancelled.
                              }
                              setLibrarySource('github')
                              setShowProjects(true)
                            })()
                          }}
                        >
                          {auth?.github ? 'Select a GitHub project' : 'Connect GitHub'}
                        </button>
                        <button
                          type="button"
                          className="ui-btn ui-btn-secondary"
                          onClick={() => {
                            setLibrarySource('local')
                            setShowProjects(true)
                          }}
                        >
                          Browse a folder
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="desktop-empty-title text-[34px] font-semibold tracking-tight">Ask across your projects</p>
                      <p className="mx-auto mt-3 max-w-md text-[15px] leading-6 text-agent-text-soft">
                        {assistantMode === 'system'
                          ? 'System AI searches the selected repos, then answers with file and line citations.'
                          : 'Cursor uses those projects as context for edits in your workspace.'}
                      </p>
                      {canAsk ? (
                        <div className="mt-8 flex flex-col gap-2">
                          {exampleQuestions.map((question) => (
                            <button
                              key={question}
                              type="button"
                              className="desktop-nav-card rounded-2xl px-4 py-3 text-left text-[14px] font-medium hover:opacity-95"
                              onClick={() => {
                                void askRowe(question)
                              }}
                            >
                              {question}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-5 text-[13px] font-semibold text-agent-text-soft">
                          {askBlockedReason}
                        </p>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <ul
                  className="mx-auto flex w-full max-w-3xl flex-1 list-none flex-col gap-2 overflow-auto pb-4"
                  ref={listRef}
                >
                  {messages.map((message) => (
                    <li
                      key={message.id}
                      className={`flex w-full ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                      {message.role === 'assistant' ? (
                        <AssistantBubble
                          text={message.text}
                          userRequest={message.question}
                          citations={message.citations}
                          edits={message.edits}
                          thinking={busy && !message.text}
                          showTrail={
                            message.id ===
                              [...messages].reverse().find((item) => item.role === 'assistant')?.id
                          }
                          trailActive={busy}
                          canHandoff={assistantMode === 'system' && Boolean(message.citations?.length)}
                          onHandoff={() => {
                            void (async () => {
                              if (busyRef.current) return
                              busyRef.current = true
                              setBusy(true)
                              try {
                                await window.api.handoffToCursor({
                                  task: message.question || message.text.slice(0, 500),
                                  projectIds: selectedProjects.map((project) => project.id),
                                  sendToCursor: true
                                })
                              } catch (error) {
                                const err = error instanceof Error ? error.message : 'Handoff failed'
                                setMessages((current) => [
                                  ...current,
                                  {
                                    id: crypto.randomUUID(),
                                    role: 'assistant',
                                    text: err
                                  }
                                ])
                              } finally {
                                busyRef.current = false
                                setBusy(false)
                              }
                            })()
                          }}
                        />
                      ) : (
                        <div className="desktop-bubble-user max-w-[min(78%,40rem)] rounded-[18px] rounded-br-md px-4 py-2.5 text-[15px] leading-5 text-white select-text">
                          {message.text ? <ChatMarkdown text={message.text} tone="user" /> : null}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <OsActionToast />
            <ToolConfirmCards />
            {(messages.length > 0 || selectedProjects.length > 0) ? (
            <div className="mx-auto mb-2 flex w-[min(100%-48px,48rem)] items-center gap-2 overflow-auto pb-0.5 text-[12px] text-agent-text-soft">
              <span className="shrink-0">Using:</span>
              {selectedProjects.length ? (
                selectedProjects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    className="desktop-chip shrink-0 rounded-full px-2.5 py-1 font-semibold hover:bg-agent-fill-strong"
                    onClick={() => setShowProjects(true)}
                  >
                    {project.name}
                  </button>
                ))
              ) : (
                <button
                  type="button"
                  className="ui-link shrink-0 text-[12px]"
                  onClick={() => setShowProjects(true)}
                >
                  Select reference projects
                </button>
              )}
            </div>
            ) : null}
            {messages.length > 0 || selectedProjects.length >= 3 ? (
            <form
              className="desktop-composer mx-auto mb-7 flex w-[min(100%-48px,48rem)] items-center gap-2 rounded-[22px] py-1.5 pr-1.5 pl-4"
              onSubmit={onSubmit}
            >
              <input
                className="min-h-10 min-w-0 flex-1 border-0 bg-transparent text-[15px] text-agent-text outline-none placeholder:text-agent-text-soft"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={
                  busy
                    ? 'Rowe is answering…'
                    : canAsk
                      ? 'Message Rowe'
                      : (askBlockedReason ?? 'Ask Rowe')
                }
                disabled={!canAsk}
                aria-label="Ask Rowe about reference projects"
              />
              <button
                type="submit"
                disabled={!canAsk || !value.trim() || busy}
                aria-label="Send"
                className="desktop-send grid size-10 place-items-center rounded-full bg-agent-accent text-white disabled:bg-agent-fill disabled:text-agent-text-soft"
              >
                <svg className="size-4 rotate-180" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 2.6a.7.7 0 0 1 .7.7v8.2l2.45-2.45a.7.7 0 1 1 1 1L8.5 14.2a.7.7 0 0 1-1 0L3.85 10.05a.7.7 0 1 1 1-1L7.3 11.5V3.3a.7.7 0 0 1 .7-.7Z" />
                </svg>
              </button>
            </form>
            ) : null}
          </>
        )}
      </section>

      <AuthScreens status={auth} onStatus={setAuth} />

      {showSettings ? (
        <SettingsPanel
          user={firebaseUser}
          onClose={() => {
            setShowSettings(false)
            if (firebaseUser) {
              void getUserPlan(firebaseUser).then(setUserPlan).catch(() => undefined)
            }
          }}
        />
      ) : null}

      {connected && auth && !auth.trayAsked ? (
        <div className="ui-overlay z-30">
          <div className="ui-card">
            <h2 className="ui-title">Keep Rowe in the {trayLabel}?</h2>
            <p className="ui-copy">
              Rowe can stay in your {trayLabel} for quick asks and Companion. You can still open the
              full app anytime.
            </p>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                className="ui-btn ui-btn-primary flex-1"
                onClick={() => {
                  void window.api.setTray(true).then(setAuth)
                }}
              >
                Add to {trayLabel}
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-secondary flex-1"
                onClick={() => {
                  void window.api.setTray(false).then(setAuth)
                }}
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function gainLabel(gain: SnipGain | null): string {
  if (!gain?.ready) {
    return 'Waiting for snip'
  }
  if (gain.commands === 0) {
    return 'No filtered commands yet'
  }
  return `${formatPercent(gain.avgSavings)} across ${gain.commands} commands`
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`
  }
  return String(Math.round(value))
}

function formatPercent(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`
}

function AssistantBubble({
  text,
  userRequest,
  citations,
  edits,
  thinking,
  showTrail,
  trailActive,
  canHandoff,
  onHandoff
}: {
  text: string
  userRequest?: string
  citations?: ChatCitation[]
  edits?: ChatFileEdit[]
  thinking: boolean
  showTrail?: boolean
  trailActive?: boolean
  canHandoff?: boolean
  onHandoff?: () => void
}): React.JSX.Element {
  const [active, setActive] = useState<number | null>(null)
  const parsed = citations?.length ? { body: text, citations } : splitMessageSources(text)
  const displayBody = parseRoweEditsFromText(parsed.body || '').text

  return (
    <div className="flex w-full min-w-0 max-w-3xl flex-col">
      {showTrail ? <AgentTrail active={Boolean(trailActive)} /> : null}
      <div className="desktop-bubble-assistant max-w-[min(78%,40rem)] rounded-[18px] rounded-bl-md px-4 py-2.5 text-[15px] leading-6 text-agent-text select-text">
        {displayBody ? (
          <ChatMarkdown
            text={displayBody}
            tone="assistant"
            userRequest={userRequest}
            onCite={(index) => {
              const target = parsed.citations[index]
              if (!target) {
                return
              }
              const next = uniqueCitations(parsed.citations).findIndex(
                (item) =>
                  item.projectName === target.projectName &&
                  item.path === target.path &&
                  item.startLine === target.startLine &&
                  item.endLine === target.endLine
              )
              setActive(next >= 0 ? next : null)
            }}
          />
        ) : thinking ? (
          <span aria-label="Thinking">…</span>
        ) : null}
      </div>
      <ChatSources
        citations={parsed.citations}
        active={active}
        onSelect={setActive}
      />
      {canHandoff && onHandoff ? (
        <button type="button" className="ui-link mt-2 self-start text-[12px]" onClick={onHandoff}>
          Send selected references to Cursor
        </button>
      ) : null}
      {edits?.length ? <EditProposals edits={edits} /> : null}
    </div>
  )
}
