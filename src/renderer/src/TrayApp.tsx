import { FormEvent, useEffect, useRef, useState } from 'react'
import ChatMarkdown from './components/ChatMarkdown'

type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  image?: string
}

const headerBtn =
  'grid size-6 place-items-center rounded-md text-agent-text-soft hover:bg-agent-fill hover:text-agent-text'

function HeaderIcon({ d }: { d: string }): React.JSX.Element {
  return (
    <svg className="size-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

export default function TrayApp(): React.JSX.Element {
  const [value, setValue] = useState('')
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [companionOn, setCompanionOn] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  const streamingIdRef = useRef<string | null>(null)
  const busyRef = useRef(false)

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: 'end' })
  }, [messages])

  useEffect(() => {
    busyRef.current = busy
  }, [busy])

  const askRowe = async (text: string): Promise<void> => {
    if (!text || busyRef.current) {
      return
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

    try {
      await window.api.sendCursorPrompt(text)
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

  useEffect(() => {
    return window.api.onCompanionStatus(setCompanionOn)
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

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const text = value.trim()
    if (!text) {
      return
    }
    setValue('')
    await askRowe(text)
  }

  return (
    <div className="panel-fill flex h-full flex-col overflow-hidden rounded-2xl border border-agent-stroke p-3">
      <header className="flex items-center gap-2 px-0.5 pb-2.5 pt-0.5">
        <span className="text-[13px] font-semibold tracking-tight">Rowe</span>
        {companionOn ? (
          <span className="rounded-md bg-agent-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-agent-accent">
            Companion
          </span>
        ) : null}
        <div className="min-w-3 flex-1" />
        <button
          type="button"
          className={headerBtn}
          aria-label="Open app"
          onClick={() => {
            void window.api.showApp()
          }}
        >
          <HeaderIcon d="M3.2 3.2h9.6v9.6H3.2V3.2Zm1.4 1.4v6.8h6.8V4.6H4.6Z" />
        </button>
        <button
          type="button"
          className={`${headerBtn} hover:bg-[#ff453a]/15 hover:text-[#ff453a]`}
          aria-label="Close"
          onClick={() => {
            void window.api.closeWindow()
          }}
        >
          <HeaderIcon d="M4.05 3.35 3.35 4.05 7.3 8l-3.95 3.95.7.7L8 8.7l3.95 3.95.7-.7L8.7 8l3.95-3.95-.7-.7L8 7.3 4.05 3.35Z" />
        </button>
      </header>

      <div className={`flex min-h-0 flex-1 ${messages.length === 0 ? 'items-center justify-center' : ''}`}>
        {messages.length === 0 ? (
          <p className="text-center text-[18px] font-semibold tracking-tight text-agent-text-soft">
            Quick ask
          </p>
        ) : (
          <ul className="flex flex-1 list-none flex-col gap-2 overflow-auto py-1" ref={listRef}>
            {messages.map((message) => (
              <li
                key={message.id}
                className={`flex w-full ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[78%] px-3 py-2 text-[13px] leading-snug select-text ${
                    message.role === 'user'
                      ? 'rounded-xl rounded-br-sm bg-agent-accent text-white'
                      : 'rounded-xl rounded-bl-sm bg-agent-bubble text-agent-text'
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
        className="flex min-h-10 items-center gap-2 rounded-lg border border-agent-stroke bg-agent-fill py-1 pr-1 pl-3"
        onSubmit={onSubmit}
      >
        <input
          className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-agent-text outline-none placeholder:text-agent-text-soft"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={busy ? 'Rowe is answering…' : 'Ask Rowe'}
          aria-label="Ask Rowe"
        />
        <button
          type="submit"
          disabled={!value.trim() || busy}
          aria-label="Send"
          className="grid size-8 place-items-center rounded-md bg-agent-accent text-white disabled:bg-agent-fill-strong disabled:text-agent-text-soft"
        >
          <svg className="size-3.5 rotate-180" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 2.6a.7.7 0 0 1 .7.7v8.2l2.45-2.45a.7.7 0 1 1 1 1L8.5 14.2a.7.7 0 0 1-1 0L3.85 10.05a.7.7 0 0 1 1-1L7.3 11.5V3.3a.7.7 0 0 1 .7-.7Z" />
          </svg>
        </button>
      </form>
    </div>
  )
}
