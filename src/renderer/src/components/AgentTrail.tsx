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
  task: 'Task'
}

const MAX_LINES = 36

function shortenPath(message: string): string {
  return message
    .replace(/\/Users\/[^/\s]+\/dev\/projects\//i, '…/')
    .replace(/\/Users\/[^/\s]+\//i, '…/')
    .replace(/\s*\(\d+\s*chars[^)]*\)/i, '')
    .trim()
}

function looksLikeNoise(message: string): boolean {
  return /response\s+safety|user\s+safety|^\s*safety\s*:/i.test(message)
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
        at: Date.now()
      }

      setLines((current) => {
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
            const mark =
              line.ok === false ? '✗' : line.ok === true || line.phase === 'reading' || line.phase === 'writing'
                ? '✓'
                : '·'
            return (
              <li key={line.id} className={`agent-trail-line is-${line.phase}`}>
                <span className="agent-trail-mark" aria-hidden>
                  {mark}
                </span>
                <span className="agent-trail-phase">{PHASE_LABEL[line.phase] || line.phase}</span>
                <span className="agent-trail-msg">{line.message}</span>
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
