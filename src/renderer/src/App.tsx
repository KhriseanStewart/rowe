import { FormEvent, useEffect, useRef, useState } from 'react'
import ChatMarkdown from './components/ChatMarkdown'

type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  image?: string
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
  github?: { login: string; name?: string; avatar?: string }
  cursor: boolean
  platform: string
}

type Thread = {
  id: string
  title: string
  updatedAt: number
  preview?: string
}

export default function App(): React.JSX.Element {
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [githubToken, setGithubToken] = useState('')
  const [cursorKey, setCursorKey] = useState('')
  const [authError, setAuthError] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [threads, setThreads] = useState<Thread[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [gain, setGain] = useState<SnipGain | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
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
  }, [])

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: 'end' })
  }, [messages])

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const next = await window.api.getSnipGain()
        if (!cancelled) {
          setGain(next)
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
  }, [])

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

  const connected = Boolean(auth?.github && auth.cursor)

  const openThread = async (id: string): Promise<void> => {
    const thread = await window.api.getHistory(id)
    setThreadId(id)
    setMessages(
      (thread?.messages ?? []).map((item) => ({
        id: item.id,
        role: item.role,
        text: item.text,
        image: item.image
      }))
    )
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

    const activeId = threadIdRef.current ?? (await startThread())
    const assistantId = crypto.randomUUID()
    streamingIdRef.current = assistantId
    busyRef.current = true
    setBusy(true)
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: 'user', text },
      { id: assistantId, role: 'assistant', text: '' }
    ])

    try {
      await window.api.sendCursorPrompt(text, undefined, activeId)
      setThreads(await window.api.listHistory())
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Something went wrong'
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

  const connect = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setAuthError('')
    setAuthBusy(true)
    try {
      await window.api.connectGithub(githubToken)
      const next = auth?.cursor
        ? await window.api.getAuthStatus()
        : await window.api.connectCursorKey(cursorKey)
      setAuth(next)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Could not connect')
    } finally {
      setAuthBusy(false)
    }
  }

  const trayLabel = auth?.platform === 'darwin' ? 'menu bar' : 'system tray'

  return (
    <div className="app-shell flex h-full min-h-0 overflow-hidden">
      <aside
        className={`${
          sidebarOpen ? 'flex' : 'hidden md:flex'
        } w-[min(100%,16.5rem)] shrink-0 flex-col border-r border-agent-stroke bg-agent-fill/40 pt-[2.4rem] md:pt-12`}
      >
        <div className="flex items-center justify-between px-3 pb-3">
          <div>
            <p className="text-[15px] font-semibold tracking-tight">Rowe</p>
            <p className="text-[11px] text-agent-text-soft">History</p>
          </div>
          <button
            type="button"
            className="rounded-md bg-agent-accent px-2 py-1 text-[11px] font-medium text-white"
            onClick={() => {
              void startThread()
            }}
          >
            New
          </button>
        </div>
        <ul className="min-h-0 flex-1 list-none overflow-auto px-2">
          {threads.length === 0 ? (
            <li className="px-2 py-3 text-[12px] text-agent-text-soft">No chats yet.</li>
          ) : (
            threads.map((thread) => (
              <li key={thread.id}>
                <button
                  type="button"
                  className={`mb-1 w-full rounded-lg px-2.5 py-2 text-left ${
                    thread.id === threadId ? 'bg-agent-fill-strong' : 'hover:bg-agent-fill'
                  }`}
                  onClick={() => {
                    void openThread(thread.id)
                  }}
                >
                  <span className="block truncate text-[13px] font-medium">{thread.title}</span>
                  <span className="block truncate text-[11px] text-agent-text-soft">
                    {thread.preview || 'Empty chat'}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="border-t border-agent-stroke p-3">
          <p className="text-[11px] font-medium text-agent-text-soft">Tokens saved</p>
          <p className="pt-1 text-[20px] font-semibold tracking-tight">
            {formatTokens(gain?.tokensSaved ?? 0)}
          </p>
          <p className="text-[11px] text-agent-text-soft">{gainLabel(gain)}</p>
          {auth?.github ? (
            <div className="mt-3 flex items-center gap-2">
              {auth.github.avatar ? (
                <img
                  src={auth.github.avatar}
                  alt=""
                  className="size-6 rounded-full"
                  referrerPolicy="no-referrer"
                />
              ) : null}
              <span className="truncate text-[12px]">{auth.github.login}</span>
            </div>
          ) : null}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col pt-[2.4rem] md:pt-12">
        <header className="flex items-center gap-2 px-4 pb-3">
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[12px] text-agent-text-soft hover:bg-agent-fill md:hidden"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            History
          </button>
          <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">
            {threads.find((thread) => thread.id === threadId)?.title ?? 'Ask Rowe'}
          </h1>
          {auth?.trayEnabled ? (
            <span className="hidden text-[11px] text-agent-text-soft sm:inline">In {trayLabel}</span>
          ) : null}
        </header>

        <div
          className={`flex min-h-0 flex-1 px-4 ${messages.length === 0 ? 'items-center justify-center' : ''}`}
        >
          {messages.length === 0 ? (
            <p className="text-center text-[28px] font-semibold tracking-tight text-agent-text-soft">
              What can I help with?
            </p>
          ) : (
            <ul className="mx-auto flex w-full max-w-3xl flex-1 list-none flex-col gap-3 overflow-auto pb-4" ref={listRef}>
              {messages.map((message) => (
                <li
                  key={message.id}
                  className={`flex w-full ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[min(78%,40rem)] px-3.5 py-2.5 text-[14px] leading-relaxed select-text ${
                      message.role === 'user'
                        ? 'rounded-2xl rounded-br-md bg-agent-accent text-white'
                        : 'rounded-2xl rounded-bl-md bg-agent-bubble text-agent-text'
                    }`}
                  >
                    {message.text ? (
                      <ChatMarkdown text={message.text} tone={message.role} />
                    ) : busy && message.role === 'assistant' ? (
                      <span aria-label="Thinking">…</span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <form
          className="mx-auto mb-4 flex w-[min(100%-2rem,48rem)] items-center gap-2 rounded-xl border border-agent-stroke bg-agent-fill py-1.5 pr-1.5 pl-4"
          onSubmit={onSubmit}
        >
          <input
            className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-agent-text outline-none placeholder:text-agent-text-soft"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={busy ? 'Rowe is answering…' : 'Ask Rowe'}
            disabled={!connected}
            aria-label="Ask Rowe"
          />
          <button
            type="submit"
            disabled={!connected || !value.trim() || busy}
            aria-label="Send"
            className="grid size-9 place-items-center rounded-lg bg-agent-accent text-white disabled:bg-agent-fill-strong disabled:text-agent-text-soft"
          >
            <svg className="size-3.5 rotate-180" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 2.6a.7.7 0 0 1 .7.7v8.2l2.45-2.45a.7.7 0 1 1 1 1L8.5 14.2a.7.7 0 0 1-1 0L3.85 10.05a.7.7 0 0 1 1-1L7.3 11.5V3.3a.7.7 0 0 1 .7-.7Z" />
            </svg>
          </button>
        </form>
      </section>

      {!connected ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <form
            className="w-full max-w-md rounded-2xl border border-agent-stroke bg-[#1c1c1e] p-5 text-agent-text shadow-xl"
            onSubmit={connect}
          >
            <h2 className="text-[20px] font-semibold tracking-tight">Connect Rowe</h2>
            <p className="mt-1 text-[13px] text-agent-text-soft">
              Sign in with GitHub, then add your Cursor API key.
            </p>
            <label className="mt-4 block text-[12px] font-medium">GitHub token</label>
            <input
              className="mt-1 w-full rounded-lg border border-agent-stroke bg-agent-fill px-3 py-2 text-[13px] outline-none"
              value={githubToken}
              onChange={(event) => setGithubToken(event.target.value)}
              placeholder="ghp_…"
              autoComplete="off"
            />
            <button
              type="button"
              className="mt-1 text-[12px] text-agent-accent"
              onClick={() => {
                void window.api.openGithubToken()
              }}
            >
              Create a read:user token on GitHub
            </button>
            {auth?.cursor ? (
              <p className="mt-3 text-[12px] text-agent-text-soft">Cursor API key already saved.</p>
            ) : (
              <>
                <label className="mt-3 block text-[12px] font-medium">Cursor API key</label>
                <input
                  className="mt-1 w-full rounded-lg border border-agent-stroke bg-agent-fill px-3 py-2 text-[13px] outline-none"
                  value={cursorKey}
                  onChange={(event) => setCursorKey(event.target.value)}
                  placeholder="key_…"
                  type="password"
                  autoComplete="off"
                />
              </>
            )}
            {authError ? <p className="mt-2 text-[12px] text-[#ff453a]">{authError}</p> : null}
            <button
              type="submit"
              disabled={
                authBusy || !githubToken.trim() || (!auth?.cursor && !cursorKey.trim())
              }
              className="mt-4 w-full rounded-lg bg-agent-accent py-2 text-[13px] font-medium text-white disabled:opacity-50"
            >
              {authBusy ? 'Connecting…' : 'Connect'}
            </button>
          </form>
        </div>
      ) : null}

      {connected && auth && !auth.trayAsked ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-agent-stroke bg-[#1c1c1e] p-5">
            <h2 className="text-[20px] font-semibold tracking-tight">Keep Rowe in the {trayLabel}?</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-agent-text-soft">
              Rowe can stay in your {trayLabel} for quick asks and Companion. You can still open the
              full app anytime.
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                className="flex-1 rounded-lg bg-agent-accent py-2 text-[13px] font-medium text-white"
                onClick={() => {
                  void window.api.setTray(true).then(setAuth)
                }}
              >
                Add to {trayLabel}
              </button>
              <button
                type="button"
                className="flex-1 rounded-lg bg-agent-fill py-2 text-[13px] font-medium"
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
