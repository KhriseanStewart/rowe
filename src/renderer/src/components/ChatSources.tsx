import { useState } from 'react'

export type ChatCitation = {
  projectName: string
  path: string
  startLine: number | null
  endLine: number | null
  content?: string
}

type ChatSourcesProps = {
  citations: ChatCitation[]
  active?: number | null
  onSelect?: (index: number | null) => void
}

export function uniqueCitations(citations: ChatCitation[]): Array<ChatCitation & { n: number }> {
  const seen = new Set<string>()
  const result: Array<ChatCitation & { n: number }> = []
  citations.forEach((citation, index) => {
    const key = `${citation.projectName}/${citation.path}:${citation.startLine ?? ''}-${citation.endLine ?? ''}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    result.push({ ...citation, n: index + 1 })
  })
  return result.slice(0, 16)
}

export function splitMessageSources(text: string): { body: string; citations: ChatCitation[] } {
  const match = text.match(/\n+Sources:\s*\n/i)
  if (!match || match.index == null) {
    return { body: text, citations: [] }
  }
  const body = text.slice(0, match.index).trimEnd()
  const rest = text.slice(match.index + match[0].length)
  const citations: ChatCitation[] = []
  for (const line of rest.split('\n')) {
    const parsed =
      line.trim().match(/^\[(\d+)\]\s+([^/\]]+)\/(.+):(\d+)-(\d+)\s*$/) ||
      line.trim().match(/^\[([^/\]]+)\/(.+):(\d+)-(\d+)\]\s*$/)
    if (!parsed) {
      continue
    }
    if (parsed.length === 6) {
      citations.push({
        projectName: parsed[2],
        path: parsed[3],
        startLine: Number(parsed[4]),
        endLine: Number(parsed[5])
      })
      continue
    }
    citations.push({
      projectName: parsed[1],
      path: parsed[2],
      startLine: Number(parsed[3]),
      endLine: Number(parsed[4])
    })
  }
  return { body, citations }
}

function fileName(path: string): string {
  return path.split('/').pop() || path
}

function folderHint(path: string): string {
  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2) {
    return path
  }
  return parts.slice(0, -1).join('/')
}

function lineLabel(citation: ChatCitation): string {
  if (citation.startLine == null) {
    return ''
  }
  if (citation.endLine == null || citation.endLine === citation.startLine) {
    return `L${citation.startLine}`
  }
  return `L${citation.startLine}–${citation.endLine}`
}

function ChatSources({ citations, active, onSelect }: ChatSourcesProps): React.JSX.Element | null {
  const items = uniqueCitations(citations)
  const [internal, setInternal] = useState<number | null>(null)
  const selected = active ?? internal

  if (!items.length) {
    return null
  }

  const open = (index: number): void => {
    const next = selected === index ? null : index
    setInternal(next)
    onSelect?.(next)
  }

  const current = selected != null ? items[selected] : undefined

  return (
    <div className="chat-sources mt-3 w-full min-w-0">
      <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-agent-text-soft">
        <svg className="size-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <path d="M3.2 2.4h6.1l3.5 3.5v7.7a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1Zm6.4 1.1v2.7h2.7Z" />
        </svg>
        Sources
        <span className="rounded-full bg-agent-fill px-1.5 py-0.5 text-[10px] font-bold">
          {items.length}
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
        {items.map((citation, index) => {
          const on = selected === index
          return (
            <button
              key={`${citation.projectName}/${citation.path}:${citation.startLine}-${citation.endLine}/${index}`}
              id={`source-${citation.n}`}
              type="button"
              className={`w-54 shrink-0 rounded-2xl border p-3 text-left transition-colors ${
                on
                  ? 'border-agent-accent bg-agent-fill'
                  : 'border-agent-stroke bg-agent-bg hover:bg-agent-fill'
              }`}
              onClick={() => open(index)}
            >
              <div className="flex items-center gap-2">
                <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-agent-fill text-[11px] font-bold text-agent-text-soft">
                  {citation.n}
                </span>
                <span className="min-w-0 truncate text-[11px] font-semibold text-agent-text-soft">
                  {citation.projectName}
                </span>
              </div>
              <p className="mt-2 line-clamp-2 text-[13px] font-semibold leading-4 text-agent-text">
                {fileName(citation.path)}
              </p>
              <p className="mt-1 truncate text-[11px] text-agent-text-soft">
                {folderHint(citation.path)}
                {lineLabel(citation) ? ` · ${lineLabel(citation)}` : ''}
              </p>
            </button>
          )
        })}
      </div>
      {current ? (
        <div className="mt-2 rounded-2xl border border-agent-stroke bg-agent-bg px-3.5 py-3">
          <p className="text-[12px] font-semibold text-agent-text">
            {current.projectName}/{current.path}
            {lineLabel(current) ? ` ${lineLabel(current)}` : ''}
          </p>
          {current.content ? (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[12px] leading-5 text-agent-text-soft">
              {current.content.trim()}
            </pre>
          ) : (
            <p className="mt-1 text-[12px] text-agent-text-soft">
              Used as context for this answer.
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}

export default ChatSources
