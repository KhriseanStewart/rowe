import { useEffect, useRef, useState } from 'react'

export type AgentTrailPhase =
  | 'planning'
  | 'thinking'
  | 'reading'
  | 'writing'
  | 'shell'
  | 'indexing'
  | 'task'
  | string

export type AgentTrailEvent = {
  id: string
  phase: AgentTrailPhase
  message: string
  taskId?: string
  ok?: boolean
  at: number
  repeats?: number
}

type TaskChip = {
  id: string
  title: string
  status: 'running' | 'done' | 'failed'
}

type Props = {
  active: boolean
  compact?: boolean
}

const PHASE_LABEL: Record<string, string> = {
  planning: 'Plan',
  thinking: 'Think',
  reading: 'Read',
  writing: 'Write',
  shell: 'Shell',
  indexing: 'Index',
  task: 'Task',
  tool: 'Tool'
}

const MAX_LINES = 24

function shortenPath(message: string): string {
  return message
    .replace(/\/Users\/[^/\s]+\/dev\/projects\//i, '…/')
    .replace(/\/Users\/[^/\s]+\//i, '…/')
    .replace(/\s*\(\d+\s*chars[^)]*\)/i, '')
    .trim()
}

function looksLikeNoise(message: string): boolean {
  return /response\s+safety|user\s+safety|^\s*safety\s*:|dots_function_call|function_call/i.test(
    message
  )
}

/** Intermediate write thrash — collapse instead of stacking. */
function isWriteThrash(message: string): boolean {
  return /^(applying edit|requesting write\/?patch|edit still pending|applying edit directly)/i.test(
    message
  )
}

function sameTrailKey(a: AgentTrailEvent, b: Pick<AgentTrailEvent, 'phase' | 'message' | 'ok'>): boolean {
  return a.phase === b.phase && a.message === b.message && a.ok === b.ok
}

function markFor(line: AgentTrailEvent): string {
  if (line.ok === false) return '✗'
  if (line.ok === true) return '✓'
  if (line.phase === 'reading' && /^(read\b|✓)/i.test(line.message)) return '✓'
  return '·'
}

export default function AgentTrail({ active, compact }: Props): React.JSX.Element | null {
  const [lines, setLines] = useState<AgentTrailEvent[]>([])
  const [tasks, setTasks] = useState<TaskChip[]>([])
  const wasActive = useRef(false)
  const listRef = useRef<HTMLOListElement | null>(null)

  useEffect(() => {
    if (active && !wasActive.current) {
      setLines([])
      setTasks([])
    }
    wasActive.current = active
  }, [active])

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest' })
  }, [lines])

  useEffect(() => {
    return window.api.onAgentTrail((payload) => {
      const phase = payload.phase || 'thinking'
      const message = shortenPath((payload.message || '').trim())
      if (!message || looksLikeNoise(message)) return

      const entry: AgentTrailEvent = {
        id: crypto.randomUUID(),
        phase,
        message,
        taskId: payload.taskId,
        ok: payload.ok,
        at: Date.now(),
        repeats: 1
      }

      setLines((current) => {
        const last = current[current.length - 1]

        // Collapse identical consecutive lines
        if (last && sameTrailKey(last, entry)) {
          const next = [...current]
          next[next.length - 1] = {
            ...last,
            repeats: (last.repeats || 1) + 1,
            at: entry.at
          }
          return next
        }

        // Collapse write thrash ping-pong (Applying ↔ Requesting) into one live row
        if (
          last &&
          last.phase === 'writing' &&
          phase === 'writing' &&
          isWriteThrash(last.message) &&
          isWriteThrash(message) &&
          entry.ok !== true
        ) {
          const next = [...current]
          next[next.length - 1] = {
            ...last,
            id: entry.id,
            message: entry.ok === false ? message : last.message,
            ok: entry.ok === false ? false : last.ok,
            repeats: (last.repeats || 1) + 1,
            at: entry.at
          }
          return next
        }

        // A final success/failure after thrash replaces the thrash row
        if (
          last &&
          last.phase === 'writing' &&
          phase === 'writing' &&
          isWriteThrash(last.message) &&
          !isWriteThrash(message)
        ) {
          const next = [...current]
          next[next.length - 1] = { ...entry, repeats: 1 }
          return next
        }

        const next = [...current, entry]
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
      })

      if (phase === 'task') {
        const id = payload.taskId || message
        setTasks((current) => {
          const status: TaskChip['status'] =
            payload.ok === false ? 'failed' : payload.ok === true ? 'done' : 'running'
          const existing = current.find((task) => task.id === id)
          if (existing) {
            return current.map((task) =>
              task.id === id
                ? {
                    ...task,
                    title: message || task.title,
                    status:
                      status === 'running' && task.status !== 'running' ? task.status : status
                  }
                : task
            )
          }
          return [...current, { id, title: message, status }]
        })
      } else if (payload.taskId) {
        setTasks((current) =>
          current.map((task) =>
            task.id === payload.taskId && task.status === 'running'
              ? {
                  ...task,
                  status: payload.ok === false ? 'failed' : payload.ok === true ? 'done' : task.status
                }
              : task
          )
        )
      }
    })
  }, [])

  if (!lines.length && !tasks.length && !active) return null

  return (
    <div
      className={`agent-trail ${compact ? 'is-compact' : ''}${active ? ' is-live' : ' is-settled'}`}
      aria-live="polite"
    >
      {tasks.length ? (
        <div className="agent-trail-tasks">
          {tasks.map((task) => (
            <span key={task.id} className={`agent-trail-chip is-${task.status}`}>
              <span className="agent-trail-chip-dot" aria-hidden />
              {task.title}
            </span>
          ))}
        </div>
      ) : null}
      {lines.length ? (
        <ol className="agent-trail-list" ref={listRef}>
          {lines.map((line) => {
            const mark = markFor(line)
            const repeats = line.repeats && line.repeats > 1 ? ` ×${line.repeats}` : ''
            return (
              <li
                key={line.id}
                className={`agent-trail-line is-${line.phase}${line.ok === false ? ' is-failed' : ''}${
                  line.ok === true ? ' is-ok' : ''
                }`}
              >
                <span className="agent-trail-mark" aria-hidden>
                  {mark}
                </span>
                <span className="agent-trail-phase">{PHASE_LABEL[line.phase] || line.phase}</span>
                <span className="agent-trail-msg">
                  {line.message}
                  {repeats ? <span className="agent-trail-repeats">{repeats}</span> : null}
                </span>
              </li>
            )
          })}
        </ol>
      ) : active ? (
        <p className="agent-trail-waiting">Working…</p>
      ) : null}
    </div>
  )
}
