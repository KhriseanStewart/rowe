import { FormEvent, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './assets/main.css'
import ChatMarkdown from './components/ChatMarkdown'
import RoweMark from './components/RoweMark'
import VoiceOrb from './components/VoiceOrb'

type JarvisState = {
  status: 'pulse' | 'pick' | 'compose' | 'searching' | 'answer' | 'error'
  text: string
  appName: string
  source?: 'mail' | 'outlook' | 'ax' | 'selection' | 'clipboard' | 'pin' | 'app' | 'empty'
  canPin?: boolean
  canInsert?: boolean
  canReply?: boolean
  cursorReady?: boolean
  ragReady?: boolean
  engine?: 'cursor' | 'system'
  pickError?: string
}

const SOURCE_LABEL: Record<NonNullable<JarvisState['source']>, string> = {
  mail: 'Read from Mail',
  outlook: 'Read from Outlook',
  ax: 'Read from this window',
  selection: 'Highlighted',
  clipboard: 'Clipboard',
  pin: 'Pinned thread',
  app: 'From this app',
  empty: 'No text found'
}

const headerBtn =
  'grid size-6 place-items-center rounded-md text-agent-text-soft hover:bg-agent-fill hover:text-agent-text [-webkit-app-region:no-drag]'

function Jarvis(): React.JSX.Element {
  const [state, setState] = useState<JarvisState>({
    status: 'pulse',
    text: '',
    appName: ''
  })
  const [note, setNote] = useState('')
  const [includeScreen, setIncludeScreen] = useState(false)
  const [pin, setPin] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return window.api.onJarvisState((next) => {
      setState(next)
      if (next.status === 'compose') {
        setNote('')
        setIncludeScreen(false)
        setPin(next.source === 'pin')
      }
      if (next.status === 'searching') {
        setNote('')
      }
    })
  }, [])

  useEffect(() => {
    if (state.status === 'compose') {
      inputRef.current?.focus()
    }
  }, [state.status])

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    const extra = note.trim()
    if (state.status === 'answer' && !extra) {
      return
    }
    void window.api.submitJarvisNote(extra, { includeScreen, pin })
  }

  const noteField = (placeholder: string): React.JSX.Element => (
    <div className="flex min-h-10 items-center gap-2 rounded-lg border border-agent-stroke bg-agent-fill py-1 pr-1 pl-3">
      <input
        ref={inputRef}
        className="min-w-0 flex-1 border-0 bg-transparent text-[14px] tracking-tight text-agent-text outline-none placeholder:text-agent-text-soft"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            void window.api.hideJarvis()
          }
        }}
        placeholder={placeholder}
        aria-label="Add a note"
      />
      <button
        type="submit"
        aria-label="Ask Rowe"
        className="grid size-8 place-items-center rounded-md bg-agent-accent text-white"
      >
        <svg className="size-3.5 rotate-180" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 2.6a.7.7 0 0 1 .7.7v8.2l2.45-2.45a.7.7 0 1 1 1 1L8.5 14.2a.7.7 0 0 1-1 0L3.85 10.05a.7.7 0 0 1 1-1L7.3 11.5V3.3a.7.7 0 0 1 .7-.7Z" />
        </svg>
      </button>
    </div>
  )

  return (
    <div className="panel-fill flex h-full flex-col overflow-hidden rounded-2xl border border-agent-stroke p-3">
      <header className="flex items-center gap-2 px-0.5 pb-2 [-webkit-app-region:drag]">
        <RoweMark className="size-5.5" />
        <span className="text-[13px] font-semibold tracking-tight">Rowe</span>
        <div className="min-w-3 flex-1" />
        <button
          type="button"
          className={`${headerBtn} hover:bg-[#ff453a]/15 hover:text-[#ff453a]`}
          title="Close"
          aria-label="Close"
          onClick={() => {
            void window.api.hideJarvis()
          }}
        >
          <svg className="size-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M4.05 3.35 3.35 4.05 7.3 8l-3.95 3.95.7.7L8 8.7l3.95 3.95.7-.7L8.7 8l3.95-3.95-.7-.7L8 7.3 4.05 3.35Z" />
          </svg>
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto [-webkit-app-region:no-drag]">
        {state.status === 'pulse' ? (
          <div className="flex flex-col gap-2">
            <VoiceOrb className="h-36 w-36" label="Companion ready" />
            <p className="px-0.5 text-[12px] text-agent-text-soft">
              {state.text ? `${state.text} · ` : ''}
              Press {window.api.platform === 'darwin' ? 'Control-Command-T' : 'Ctrl+Alt+T'} to ask
            </p>
          </div>
        ) : null}

        {state.status === 'pick' ? (
          <div className="flex flex-col gap-2 [-webkit-app-region:no-drag]">
            <p className="px-0.5 text-[13px] font-semibold text-agent-text">Which AI should Companion use?</p>
            <p className="px-0.5 text-[12px] leading-4 text-agent-text-soft">
              Cursor can edit and see your workspace. System AI searches your selected reference projects (same RAG as chat), then answers with the screen context.
            </p>
            {state.pickError ? (
              <p className="px-0.5 text-[12px] font-semibold text-agent-danger">{state.pickError}</p>
            ) : null}
            <button
              type="button"
              className={`rounded-xl border px-3 py-2.5 text-left ${
                state.engine === 'cursor'
                  ? 'border-agent-accent bg-agent-fill'
                  : 'border-agent-stroke bg-agent-bg hover:bg-agent-fill'
              }`}
              onClick={() => {
                void window.api.selectCompanionAi('cursor')
              }}
            >
              <p className="text-[13px] font-semibold">Cursor</p>
              <p className="mt-0.5 text-[11px] text-agent-text-soft">
                {state.cursorReady ? 'Composer on your Cursor key' : 'Connect Cursor in Rowe first'}
              </p>
            </button>
            <button
              type="button"
              className={`rounded-xl border px-3 py-2.5 text-left ${
                state.engine === 'system'
                  ? 'border-agent-accent bg-agent-fill'
                  : 'border-agent-stroke bg-agent-bg hover:bg-agent-fill'
              }`}
              onClick={() => {
                void window.api.selectCompanionAi('system')
              }}
            >
              <p className="text-[13px] font-semibold">System AI</p>
              <p className="mt-0.5 text-[11px] text-agent-text-soft">
                {state.ragReady ? 'RAG over selected reference projects' : 'Select projects and add a System AI key'}
              </p>
            </button>
          </div>
        ) : null}

        {state.status === 'compose' ? (
          <form className="flex flex-col gap-2" onSubmit={onSubmit}>
            <p className="line-clamp-2 select-text px-0.5 text-[12px] text-agent-text-soft">
              {state.source ? SOURCE_LABEL[state.source] : 'Ready'}
              {state.text ? ` · ${state.text}` : ''}
            </p>
            <div className="flex gap-3 px-0.5 text-[11px] text-agent-text-soft">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={includeScreen}
                  onChange={(event) => setIncludeScreen(event.target.checked)}
                />
                Include screen
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={pin}
                  disabled={!state.canPin && state.source !== 'pin'}
                  onChange={(event) => {
                    setPin(event.target.checked)
                    if (event.target.checked) {
                      void window.api.pinJarvisContext()
                    }
                  }}
                />
                Pin thread
              </label>
            </div>
            {noteField('Ask a question, or say reply')}
          </form>
        ) : null}

        {state.status === 'searching' ? (
          <div className="flex flex-col gap-2">
            <VoiceOrb className="h-36 w-36" label="Searching" />
            <p className="px-0.5 text-[13px] text-agent-text-soft">Searching…</p>
          </div>
        ) : null}

        {state.status === 'answer' && state.text ? (
          <div className="flex h-full flex-col gap-2">
            <div className="min-h-0 flex-1 overflow-auto text-[13px] leading-snug">
              <ChatMarkdown text={state.text} tone="assistant" />
            </div>
            {state.canInsert ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  className="flex-1 rounded-md border border-agent-stroke bg-agent-fill px-2 py-1.5 text-[12px] text-agent-text"
                  onClick={() => {
                    void window.api.copyJarvisDraft()
                  }}
                >
                  Copy
                </button>
                <button
                  type="button"
                  className="flex-1 rounded-md border border-agent-stroke bg-agent-fill px-2 py-1.5 text-[12px] text-agent-text"
                  onClick={() => {
                    void window.api.insertJarvisDraft('paste')
                  }}
                >
                  Paste
                </button>
                {state.canReply ? (
                  <button
                    type="button"
                    className="flex-1 rounded-md bg-agent-accent px-2 py-1.5 text-[12px] text-white"
                    onClick={() => {
                      void window.api.insertJarvisDraft('reply')
                    }}
                  >
                    Reply
                  </button>
                ) : null}
              </div>
            ) : null}
            <form className="shrink-0" onSubmit={onSubmit}>
              {noteField('Add details, or type a reply')}
            </form>
          </div>
        ) : null}

        {state.status === 'error' ? (
          <p className="select-text px-0.5 text-[13px] text-agent-text-soft">{state.text}</p>
        ) : null}
      </div>
    </div>
  )
}

document.documentElement.dataset.platform = window.api.platform

createRoot(document.getElementById('root')!).render(<Jarvis />)
