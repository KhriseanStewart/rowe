import type { ChatFileEdit } from '../components/EditProposals'

const EDIT_FENCE = /```rowe-edit[^\n]*\r?\n?([\s\S]*?)```/gi
const TOOL_FENCE = /```rowe-tool[^\n]*\r?\n?([\s\S]*?)```/gi
const TASK_FENCE = /```rowe-tasks[^\n]*\r?\n?([\s\S]*?)```/gi

/**
 * Client-side parse of rowe-edit fences so the tray/main UI can show Accept/Decline
 * even when streamed text still contains the raw block (or main process is on an older build).
 */
export function parseRoweEditsFromText(text: string): { text: string; edits: ChatFileEdit[] } {
  const edits: ChatFileEdit[] = []
  const withoutTools = text.replace(TOOL_FENCE, '').replace(/\[?(?:list_dir|read_file|write_file|mkdir|delete_path|path_exists|run_shell)\s*\([^\)]*\)\]?/gi, '').replace(TASK_FENCE, '')
  const cleaned = withoutTools.replace(EDIT_FENCE, (_full, body: string) => {
    const parsed = parseEditBody(String(body).trim())
    if (!parsed) return _full
    edits.push({
      id: crypto.randomUUID(),
      path: parsed.path,
      absolutePath: '',
      oldText: parsed.oldText,
      newText: parsed.newText,
      description: parsed.description,
      before: parsed.oldText,
      after: parsed.newText
    })
    return ''
  })

  const summary =
    edits.length === 1
      ? `Proposed an edit to \`${edits[0].path}\`. Review the diff below, then Accept or Decline.`
      : edits.length > 1
        ? `Proposed ${edits.length} file edits. Review each diff below, then Accept or Decline.`
        : ''

  const body = cleaned.replace(/\n{3,}/g, '\n\n').trim()
  return {
    text: [body, summary].filter(Boolean).join('\n\n'),
    edits
  }
}

function parseEditBody(body: string): {
  path: string
  oldText: string
  newText: string
  description?: string
} | null {
  const jsonCandidate = body.trim()
  if (jsonCandidate.startsWith('{')) {
    try {
      const data = JSON.parse(jsonCandidate) as {
        path?: string
        old?: string
        new?: string
        oldText?: string
        newText?: string
        description?: string
      }
      const path = data.path?.trim()
      const oldText = data.oldText ?? data.old
      const newText = data.newText ?? data.new
      if (!path || typeof oldText !== 'string' || typeof newText !== 'string') return null
      return { path, oldText, newText, description: data.description?.trim() }
    } catch {
      // try to recover common model mistakes (raw newlines inside strings)
      try {
        const repaired = jsonCandidate
          .replace(/\r\n/g, '\\n')
          .replace(/("(?:old|new|oldText|newText|description)"\s*:\s*")([\s\S]*?)(")/g, (_m, a, mid, c) => {
            return a + String(mid).replace(/\n/g, '\\n').replace(/\r/g, '') + c
          })
        const data = JSON.parse(repaired) as {
          path?: string
          old?: string
          new?: string
          oldText?: string
          newText?: string
          description?: string
        }
        const path = data.path?.trim()
        const oldText = data.oldText ?? data.old
        const newText = data.newText ?? data.new
        if (!path || typeof oldText !== 'string' || typeof newText !== 'string') return null
        return { path, oldText, newText, description: data.description?.trim() }
      } catch {
        // fall through
      }
    }
  }

  const pathMatch = body.match(/^path:\s*(.+)$/im)
  const descMatch = body.match(/^description:\s*(.+)$/im)
  const marker = body.match(
    /<<<<<<<\s*OLD\s*\r?\n([\s\S]*?)\r?\n=======\s*\r?\n([\s\S]*?)\r?\n>>>>>>>\s*NEW\s*$/i
  )
  if (pathMatch && marker) {
    return {
      path: pathMatch[1].trim().replace(/^["']|["']$/g, ''),
      oldText: marker[1],
      newText: marker[2],
      description: descMatch?.[1]?.trim()
    }
  }
  return null
}
