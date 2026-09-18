import { randomUUID } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'path'
import {
  getWorkspaceRoots,
  isPathGranted,
  requestTrayFileAccess,
  withFolderAccess
} from './local-folder'

export type ProposedFileEdit = {
  id: string
  path: string
  /** Resolved when known; may be empty until Accept (then Rowe resolves / asks access). */
  absolutePath: string
  oldText: string
  newText: string
  description?: string
  /** Unified-ish preview lines for the UI. */
  before: string
  after: string
}

export type ApplyEditResult =
  | { ok: true; absolutePath: string }
  | { ok: false; error: string }

const EDIT_FENCE = /```rowe-edit[^\n]*\r?\n?([\s\S]*?)```/gi

/**
 * Pull machine-readable edit proposals out of a model reply and return the
 * cleaned chat text plus structured edits (nothing is written yet).
 */
export function extractProposedEdits(text: string): { text: string; edits: ProposedFileEdit[] } {
  const edits: ProposedFileEdit[] = []
  const cleaned = text.replace(EDIT_FENCE, (_full, body: string) => {
    const parsed = parseEditBody(String(body).trim())
    if (!parsed) return _full
    const absolutePath = resolveEditPath(parsed.path) || ''
    edits.push({
      id: randomUUID(),
      path: parsed.path,
      absolutePath,
      oldText: parsed.oldText,
      newText: parsed.newText,
      description: parsed.description,
      before: parsed.oldText,
      after: parsed.newText
    })
    // Always strip the machine fence from chat — the Accept/Decline card shows the change.
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
  // JSON object form
  if (body.startsWith('{')) {
    try {
      const data = JSON.parse(body) as {
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
      // fall through to marker form
    }
  }

  // Marker form:
  // path: src/App.tsx
  // description: optional
  // <<<<<<< OLD
  // ...
  // =======
  // ...
  // >>>>>>> NEW
  const pathMatch = body.match(/^path:\s*(.+)$/im)
  const descMatch = body.match(/^description:\s*(.+)$/im)
  const marker = body.match(/<<<<<<<\s*OLD\s*\n([\s\S]*?)\n=======\s*\n([\s\S]*?)\n>>>>>>>\s*NEW\s*$/i)
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

export function resolveEditPath(pathValue: string, preferHints: string[] = []): string | undefined {
  const raw = pathValue.trim().replace(/^["']|["']$/g, '')
  if (!raw) return undefined

  if (isAbsolute(raw) && existsSync(raw) && isUsableProjectFile(raw)) {
    return resolve(raw)
  }

  const roots = getWorkspaceRoots()
  const candidates: string[] = []

  for (const root of roots) {
    const candidate = resolve(root, raw)
    if (existsSync(candidate) && isUsableProjectFile(candidate)) {
      candidates.push(resolve(candidate))
    }
  }

  const leaf = basename(raw).toLowerCase()
  const normalizedRel = raw.replace(/\\/g, '/').toLowerCase()
  for (const root of roots) {
    candidates.push(...shallowFindAllByRelative(root, normalizedRel, 8))
  }
  if (!candidates.length) {
    for (const root of roots) {
      candidates.push(...shallowFindAllFiles(root, leaf, 8))
    }
  }

  const unique = [...new Set(candidates)]
  if (!unique.length) return undefined
  unique.sort((a, b) => scoreEditPath(b, preferHints, raw) - scoreEditPath(a, preferHints, raw))
  return unique[0]
}

function isUsableProjectFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false
  } catch {
    return false
  }
  const normalized = filePath.replace(/\\/g, '/')
  if (/\/flutter\/(bin|dev|examples|packages|engine|artifacts)\b/i.test(normalized)) return false
  if (/\/(manual_tests|robot_tester|flutter_tools|customer_testing)\b/i.test(normalized)) return false
  if (/\/Library\/Application Support\/rowe\/rag\/github\//i.test(normalized)) return false
  return true
}

function scoreEditPath(filePath: string, preferHints: string[], requested: string): number {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  let score = 0
  if (/\/projects\//.test(normalized)) score += 50
  if (!/\/flutter\/(examples|dev|packages)\//.test(normalized)) score += 20
  for (const hint of preferHints) {
    const h = hint.trim().toLowerCase()
    if (h && normalized.includes(h)) score += 80
  }
  const req = requested.replace(/\\/g, '/').toLowerCase()
  if (req && normalized.endsWith('/' + req)) score += 40
  score -= Math.min(20, normalized.split('/').length)
  return score
}

function shallowFindAllByRelative(root: string, relativeLower: string, maxDepth: number): string[] {
  const found: string[] = []
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  const started = Date.now()
  while (stack.length) {
    if (Date.now() - started > 2500 || found.length >= 40) break
    const current = stack.pop()
    if (!current || current.depth > maxDepth) continue
    const normalizedDir = current.dir.replace(/\\/g, '/')
    if (/\/flutter\/(bin|dev|examples|packages|engine)\b/i.test(normalizedDir)) continue
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') {
        continue
      }
      const next = join(current.dir, entry.name)
      if (entry.isFile()) {
        const full = resolve(next).replace(/\\/g, '/').toLowerCase()
        if ((full.endsWith('/' + relativeLower) || full.endsWith(relativeLower)) && isUsableProjectFile(next)) {
          found.push(resolve(next))
        }
      } else if (entry.isDirectory() && current.depth < maxDepth) {
        stack.push({ dir: next, depth: current.depth + 1 })
      }
    }
  }
  return found
}

function shallowFindAllFiles(root: string, leafLower: string, maxDepth: number): string[] {
  const found: string[] = []
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  const started = Date.now()
  while (stack.length) {
    if (Date.now() - started > 2000 || found.length >= 40) break
    const current = stack.pop()
    if (!current || current.depth > maxDepth) continue
    const normalizedDir = current.dir.replace(/\\/g, '/')
    if (/\/flutter\/(bin|dev|examples|packages|engine)\b/i.test(normalizedDir)) continue
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue
      const next = join(current.dir, entry.name)
      if (entry.isFile() && entry.name.toLowerCase() === leafLower && isUsableProjectFile(next)) {
        found.push(resolve(next))
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        stack.push({ dir: next, depth: current.depth + 1 })
      }
    }
  }
  return found
}

/** Ensure write access for the file's parent folder, prompting if needed. */
export async function ensureWriteAccess(
  absolutePath: string,
  sender?: Electron.WebContents
): Promise<{ granted: boolean }> {
  const folder = dirname(absolutePath)
  if (isPathGranted(folder) || isPathGranted(absolutePath)) {
    return { granted: true }
  }
  const access = await requestTrayFileAccess(sender, {
    targetLabel: basename(folder),
    defaultPath: folder,
    reason: `Rowe needs write access to “${basename(folder)}” to apply your accepted edit to ${basename(absolutePath)}.`,
    wantFile: false
  })
  return { granted: access.granted }
}

export async function applyProposedEdit(
  edit: {
    path?: string
    absolutePath: string
    oldText: string
    newText: string
  },
  sender?: Electron.WebContents
): Promise<ApplyEditResult> {
  const preferHints = hintTokens(edit.path || '')
  let absolutePath = edit.absolutePath?.trim() ? normalize(edit.absolutePath) : ''
  if (!absolutePath || !existsSync(absolutePath) || !isUsableProjectFile(absolutePath)) {
    absolutePath = resolveEditPath(edit.path || edit.absolutePath || '', preferHints) || ''
  }
  if (!absolutePath) {
    const access = await requestTrayFileAccess(sender, {
      question: `edit ${edit.path || 'file'}`,
      targetLabel: basename(edit.path || 'file'),
      reason: `Rowe needs access to “${edit.path || 'that file'}” to apply your accepted edit.`,
      wantFile: true
    })
    if (!access.granted) {
      return { ok: false, error: 'Folder access was not granted, so the file could not be found.' }
    }
    absolutePath = resolveEditPath(edit.path || '', preferHints) || ''
  }
  if (!absolutePath || !existsSync(absolutePath) || !isUsableProjectFile(absolutePath)) {
    return {
      ok: false,
      error: `Could not find “${edit.path || absolutePath || 'file'}” under your granted folders. Use /files to add the project folder, then Accept again.`
    }
  }

  const access = await ensureWriteAccess(absolutePath, sender)
  if (!access.granted) {
    return { ok: false, error: 'Write access was not granted for that folder.' }
  }

  try {
    const oldText = unescapeEditText(edit.oldText)
    const newText = unescapeEditText(edit.newText)
    const current = await withFolderAccess(dirname(absolutePath), () =>
      readFileSync(absolutePath, 'utf8')
    )
    const next = applySnippetReplacement(current, oldText, newText)
    if (!next.ok) return next

    await withFolderAccess(dirname(absolutePath), () => {
      writeFileSync(absolutePath, next.text, 'utf8')
    })
    const verify = await withFolderAccess(dirname(absolutePath), () =>
      readFileSync(absolutePath, 'utf8')
    )
    if (verify !== next.text) {
      return { ok: false, error: `Write did not stick on ${absolutePath}.` }
    }
    return { ok: true, absolutePath }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to write file'
    return { ok: false, error: message }
  }
}

function hintTokens(pathValue: string): string[] {
  return pathValue
    .replace(/\\/g, '/')
    .split('/')
    .flatMap((part) => part.split(/[^a-zA-Z0-9]+/))
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 3 && !['lib', 'src', 'app', 'dart', 'tsx', 'ts', 'js'].includes(part))
}

function unescapeEditText(value: string): string {
  if (value.includes('\n') || value.includes('\r')) return value
  if (!value.includes('\\n') && !value.includes('\\t')) return value
  return value.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
}

export function applySnippetReplacement(
  current: string,
  oldText: string,
  newText: string
): { ok: true; text: string } | { ok: false; error: string } {
  if (current.includes(oldText)) {
    return { ok: true, text: current.replace(oldText, newText) }
  }
  const normCurrent = current.replace(/\r\n/g, '\n')
  const normOld = oldText.replace(/\r\n/g, '\n')
  if (normCurrent.includes(normOld)) {
    const replaced = normCurrent.replace(normOld, newText.replace(/\r\n/g, '\n'))
    const useCrlf = current.includes('\r\n')
    return { ok: true, text: useCrlf ? replaced.replace(/\n/g, '\r\n') : replaced }
  }
  return {
    ok: false,
    error:
      'The file changed since this proposal, or the exact snippet was not found. Decline and ask again.'
  }
}

export function buildEditPolicy(): string {
  return [
    'Prefer autonomous filesystem tools (patch_file, write_file, mkdir, delete_path, read_file, list_dir) via rowe-tool fences when the user asks you to create, edit, update, or delete files or folders under granted access.',
    'Only use a rowe-edit fence when the user explicitly wants a before/after review card (Accept/Decline) before writing.',
    'When using rowe-edit, do NOT claim the file was saved — Rowe writes only after Accept.',
    'Emit one fence per file change:',
    '```rowe-edit',
    '{"path":"relative/or/absolute/file.ts","description":"short why","old":"exact existing snippet","new":"replacement snippet"}',
    '```',
    'old must be an exact contiguous snippet from the current file. Prefer the smallest unique snippet.',
    'For brand-new files via review cards, set old to an empty string and new to the full file contents.'
  ].join(' ')
}
