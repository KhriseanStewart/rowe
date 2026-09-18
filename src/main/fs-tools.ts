import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { basename, dirname, isAbsolute, normalize, resolve, sep } from 'path'

const execFileAsync = promisify(execFile)
import { getWorkspaceRoots, isPathGranted, requestTrayFileAccess, withFolderAccess } from './local-folder'
import { resolveEditPath, applySnippetReplacement } from './file-edits'

export type FsToolName =
  | 'list_dir'
  | 'read_file'
  | 'write_file'
  | 'mkdir'
  | 'delete_path'
  | 'path_exists'
  | 'run_shell'
  | 'patch_file'

export type FsToolCall = {
  name: FsToolName
  args: Record<string, unknown>
}

export type FsToolResult = {
  name: FsToolName
  ok: boolean
  path?: string
  summary: string
  data?: unknown
}

const TOOL_FENCE = /```rowe-tool[^\n]*\r?\n?([\s\S]*?)```/gi
const MAX_READ_CHARS = 120_000
const MAX_LIST_ENTRIES = 400

export const FS_TOOL_POLICY = [
  'You can manage local files under the user\'s granted folders using rowe-tool fences.',
  'You have full CRUD plus non-admin shell: list_dir, read_file, write_file, mkdir, delete_path, path_exists, run_shell.',
  'For complex work, first emit a rowe-tasks fence with a short ordered checklist, then execute tools for each task.',
  'When the user asks you to create, edit, update, or delete files/folders, DO IT with tools — do not ask them to run shell commands or paste file contents.',
  'Prefer speed: smallest tools that finish the job. Use deeper multi-step reasoning only when the task needs it.',
  'Match patterns from selected/reference projects when available; otherwise match the user\'s coding style from retrieved code and solid best practices.',
  'For filesystem work, emit one or more tools, then stop and wait for tool results. Do not claim a write succeeded until a tool result says ok.',
  'Available tools:',
  '- list_dir { "path": "relative/or/absolute" }',
  '- read_file { "path": "...", "maxChars"?: number }',
  '- write_file { "path": "...", "content": "full file contents" }',
  '- patch_file { "path": "...", "old": "exact snippet", "new": "replacement" } — preferred for small edits like adding a comment',
  '- mkdir { "path": "..." }',
  '- delete_path { "path": "..." }',
  '- path_exists { "path": "..." }',
  '- run_shell { "command": "bash -lc style command", "cwd"?: "project/subdir" } — non-admin only; blocked: sudo/su/pkexec and paths outside granted folders',
  'Always use a rowe-tool JSON fence (preferred). Do not narrate tool calls as XML tags in the reply. Loose forms like [read_file(path=\'...\')] are also accepted but fences are more reliable.',
  'Emit tools as:',
  '```rowe-tool',
  '{"name":"read_file","args":{"path":"lib/main.dart"}}',
  '```',
  'Optional task breakdown:',
  '```rowe-tasks',
  '[{"id":"1","title":"Read main.dart"},{"id":"2","title":"Add comment"}]',
  '```',
  'For small edits (comments, one-line changes), use patch_file after read_file — do not stop after reading. Prefer write_file for create/full rewrite. Use delete_path only when asked. Stay inside granted project folders.'
].join(' ')

export function extractToolCalls(text: string): { text: string; calls: FsToolCall[] } {
  const calls: FsToolCall[] = []
  let cleaned = text.replace(TOOL_FENCE, (_full, body: string) => {
    const parsed = parseToolBody(String(body).trim())
    if (!parsed) return _full
    calls.push(parsed)
    return ''
  })

  // XML-style tool calls some models emit:
  // <tool_call>list_dir\n<arg_key>path</arg_key>\n<arg_value>...</arg_value></tool_call>
  cleaned = cleaned.replace(/<tool_call>\s*([\s\S]*?)<\/tool_call>/gi, (_full, body: string) => {
    const parsed = parseXmlToolBody(String(body))
    if (!parsed) return ''
    if (parsed.name === 'write_file' && typeof parsed.args.content !== 'string') return ''
    if (parsed.name === 'patch_file' && (parsed.args.old == null || parsed.args.new == null) && (parsed.args.oldText == null || parsed.args.newText == null)) {
      // still attempt — patchFileTool validates
    }
    calls.push(parsed)
    return ''
  })

  // Models sometimes emit pseudo-calls instead of fences, e.g.
  // [read_file(path='payemm_mobile_app/lib/main.dart')]
  // or read_file(path="...")
  cleaned = cleaned.replace(
    /\[?(list_dir|read_file|write_file|mkdir|delete_path|path_exists|run_shell|patch_file)\s*\(([^\)]*)\)\]?/gi,
    (full, name: string, argStr: string) => {
      const args = parseLooseArgs(argStr)
      const toolName = name.toLowerCase() as FsToolName
      if (!isToolName(toolName)) return full
      // write_file needs content — skip incomplete loose forms
      if (toolName === 'write_file' && typeof args.content !== 'string') return full
      calls.push({ name: toolName, args })
      return ''
    }
  )

  cleaned = cleaned
    .replace(/<\/?tool_call>|<\/?arg_key>|<\/?arg_value>|<\/?parameter>|<\/?parameters>/gi, '')
    .replace(/\b[\w./-]+\.(dart|tsx?|jsx?|py|json|md|swift|kt)\'\)\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return {
    text: cleaned,
    calls
  }
}


function parseXmlToolBody(body: string): FsToolCall | null {
  const trimmed = body.trim()
  if (!trimmed) return null

  // First non-empty line / token is the tool name
  const nameMatch = trimmed.match(/^\s*([a-zA-Z_][\w]*)/m)
  const name = nameMatch?.[1]?.toLowerCase() as FsToolName | undefined
  if (!name || !isToolName(name)) return null

  const args: Record<string, unknown> = {}
  const kv = trimmed.matchAll(/<arg_key>\s*([^<]+?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi)
  for (const match of kv) {
    args[match[1].trim()] = match[2]
  }
  // Also support <parameter name="path">value</parameter>
  const params = trimmed.matchAll(/<parameter\s+name=["']([^"']+)["']\s*>\s*([\s\S]*?)\s*<\/parameter>/gi)
  for (const match of params) {
    args[match[1].trim()] = match[2]
  }
  return { name, args }
}

function parseLooseArgs(argStr: string): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  const trimmed = argStr.trim()
  if (!trimmed) return args
  // JSON object inside parens
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      // fall through
    }
  }
  const re = /([a-zA-Z_][\w]*)\s*=\s*(['"])([\s\S]*?)\2/g
  let match: RegExpExecArray | null
  while ((match = re.exec(trimmed))) {
    args[match[1]] = match[3]
  }
  // bare path positional: read_file('x')
  if (!Object.keys(args).length) {
    const bare = trimmed.match(/^(['"])([\s\S]*?)\1$/)
    if (bare) args.path = bare[2]
  }
  return args
}

function parseToolBody(body: string): FsToolCall | null {
  try {
    const data = JSON.parse(body) as { name?: string; args?: Record<string, unknown>; parameters?: Record<string, unknown> }
    const name = data.name?.trim() as FsToolName | undefined
    if (!name || !isToolName(name)) return null
    return { name, args: data.args || data.parameters || {} }
  } catch {
    return null
  }
}

function isToolName(name: string): name is FsToolName {
  return ['list_dir', 'read_file', 'write_file', 'mkdir', 'delete_path', 'path_exists', 'run_shell', 'patch_file'].includes(name)
}

export async function executeFsTool(
  call: FsToolCall,
  opts?: { preferHints?: string[]; sender?: Electron.WebContents }
): Promise<FsToolResult> {
  try {
    switch (call.name) {
      case 'list_dir':
        return await listDir(String(call.args.path || ''), opts)
      case 'read_file':
        return await readFileTool(String(call.args.path || ''), Number(call.args.maxChars) || MAX_READ_CHARS, opts)
      case 'write_file':
        return await writeFileTool(String(call.args.path || ''), String(call.args.content ?? ''), opts)
      case 'mkdir':
        return await mkdirTool(String(call.args.path || ''), opts)
      case 'delete_path':
        return await deleteTool(String(call.args.path || ''), opts)
      case 'path_exists':
        return await existsTool(String(call.args.path || ''), opts)
      case 'run_shell':
        return await runShellTool(String(call.args.command || ''), call.args.cwd != null ? String(call.args.cwd) : undefined, opts)
      case 'patch_file':
        return await patchFileTool(
          String(call.args.path || ''),
          String(call.args.old ?? call.args.oldText ?? ''),
          String(call.args.new ?? call.args.newText ?? ''),
          opts
        )
      default:
        return { name: call.name, ok: false, summary: `Unknown tool: ${call.name}` }
    }
  } catch (error) {
    return {
      name: call.name,
      ok: false,
      summary: error instanceof Error ? error.message : 'Tool failed'
    }
  }
}

async function resolveWritablePath(
  pathValue: string,
  opts?: { preferHints?: string[]; sender?: Electron.WebContents; createParents?: boolean }
): Promise<string> {
  const hints = opts?.preferHints || []
  let absolute = resolveEditPath(pathValue, hints) || ''
  if (!absolute && pathValue.trim()) {
    // Allow creating new files under an existing granted parent.
    absolute = resolveNewPathUnderRoots(pathValue, hints) || ''
  }
  if (!absolute) {
    const access = await requestTrayFileAccess(opts?.sender, {
      question: pathValue,
      targetLabel: basename(pathValue || 'folder'),
      reason: `Rowe needs folder access to work with “${pathValue || 'that path'}”.`,
      wantFile: false
    })
    if (!access.granted) {
      throw new Error('Folder access was not granted.')
    }
    absolute = resolveEditPath(pathValue, hints) || resolveNewPathUnderRoots(pathValue, hints) || ''
  }
  if (!absolute) {
    throw new Error(`Could not resolve “${pathValue}” under granted folders.`)
  }
  assertUnderGrantedRoots(absolute)
  return absolute
}

function resolveNewPathUnderRoots(pathValue: string, preferHints: string[]): string | undefined {
  const raw = pathValue.trim().replace(/^["']|["']$/g, '')
  if (!raw) return undefined
  if (isAbsolute(raw)) {
    assertUnderGrantedRoots(raw)
    return normalize(raw)
  }
  const roots = getWorkspaceRoots()
  const scored = roots
    .map((root) => {
      const candidate = resolve(root, raw)
      let score = 0
      for (const hint of preferHints) {
        if (candidate.toLowerCase().includes(hint.toLowerCase())) score += 80
      }
      if (/\/projects\//i.test(candidate)) score += 40
      return { candidate, score }
    })
    .sort((a, b) => b.score - a.score)
  return scored[0]?.candidate
}

function assertUnderGrantedRoots(absolutePath: string): void {
  const normalized = resolve(absolutePath)
  const roots = getWorkspaceRoots()
  const ok = roots.some((root) => {
    const base = root.endsWith(sep) ? root : root + sep
    return normalized === root || normalized.startsWith(base) || isPathGranted(normalized)
  })
  if (!ok) {
    throw new Error(`Blocked path outside granted folders: ${normalized}`)
  }
}

async function listDir(
  pathValue: string,
  opts?: { preferHints?: string[]; sender?: Electron.WebContents }
): Promise<FsToolResult> {
  const absolute = await resolveWritablePath(pathValue || '.', opts)
  const entries = await withFolderAccess(absolute, () => {
    const stats = statSync(absolute)
    if (!stats.isDirectory()) throw new Error('Not a directory')
    return readdirSync(absolute, { withFileTypes: true })
      .slice(0, MAX_LIST_ENTRIES)
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other'
      }))
  })
  return {
    name: 'list_dir',
    ok: true,
    path: absolute,
    summary: `Listed ${entries.length} entries in ${absolute}`,
    data: { entries }
  }
}

async function readFileTool(
  pathValue: string,
  maxChars: number,
  opts?: { preferHints?: string[]; sender?: Electron.WebContents }
): Promise<FsToolResult> {
  const absolute = await resolveWritablePath(pathValue, opts)
  const content = await withFolderAccess(dirname(absolute), () => {
    if (!statSync(absolute).isFile()) throw new Error('Not a file')
    return readFileSync(absolute, 'utf8')
  })
  const clipped = content.length > maxChars ? content.slice(0, maxChars) : content
  return {
    name: 'read_file',
    ok: true,
    path: absolute,
    summary: `Read ${absolute} (${content.length} chars${content.length > maxChars ? ', truncated' : ''})`,
    data: { content: clipped, truncated: content.length > maxChars, bytes: content.length }
  }
}

async function writeFileTool(
  pathValue: string,
  content: string,
  opts?: { preferHints?: string[]; sender?: Electron.WebContents }
): Promise<FsToolResult> {
  const absolute = await resolveWritablePath(pathValue, opts)
  await withFolderAccess(dirname(absolute), () => {
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content, 'utf8')
  })
  const verify = await withFolderAccess(dirname(absolute), () => readFileSync(absolute, 'utf8'))
  if (verify !== content) {
    throw new Error(`Write did not stick on ${absolute}`)
  }
  return {
    name: 'write_file',
    ok: true,
    path: absolute,
    summary: `Wrote ${absolute} (${content.length} chars)`,
    data: { bytes: content.length }
  }
}

async function mkdirTool(
  pathValue: string,
  opts?: { preferHints?: string[]; sender?: Electron.WebContents }
): Promise<FsToolResult> {
  const absolute = await resolveWritablePath(pathValue, opts)
  await withFolderAccess(dirname(absolute), () => {
    mkdirSync(absolute, { recursive: true })
  })
  return {
    name: 'mkdir',
    ok: true,
    path: absolute,
    summary: `Created directory ${absolute}`
  }
}

async function deleteTool(
  pathValue: string,
  opts?: { preferHints?: string[]; sender?: Electron.WebContents }
): Promise<FsToolResult> {
  const absolute = await resolveWritablePath(pathValue, opts)
  await withFolderAccess(dirname(absolute), () => {
    rmSync(absolute, { recursive: true, force: true })
  })
  return {
    name: 'delete_path',
    ok: true,
    path: absolute,
    summary: `Deleted ${absolute}`
  }
}

async function existsTool(
  pathValue: string,
  opts?: { preferHints?: string[]; sender?: Electron.WebContents }
): Promise<FsToolResult> {
  let absolute = ''
  try {
    absolute = await resolveWritablePath(pathValue, opts)
  } catch {
    return {
      name: 'path_exists',
      ok: true,
      summary: `Path not found under granted folders: ${pathValue}`,
      data: { exists: false }
    }
  }
  const exists = existsSync(absolute)
  return {
    name: 'path_exists',
    ok: true,
    path: absolute,
    summary: exists ? `Exists: ${absolute}` : `Missing: ${absolute}`,
    data: { exists }
  }
}


const SHELL_TIMEOUT_MS = 60_000
const BLOCKED_SHELL = /\b(sudo|pkexec|doas|su\b|chmod\s+[0-7]{3,4}\s+\/|chown\s+|launchctl|diskutil|csrutil|nvram|kextload|dscl|systemsetup)\b/i
const BLOCKED_PATH = /(?:^|\s)(\/etc|\/System|\/private\/var|\/usr\/sbin|\/sbin)(?:\/|\s|$)/


async function patchFileTool(
  pathValue: string,
  oldText: string,
  newText: string,
  opts?: { preferHints?: string[]; sender?: Electron.WebContents }
): Promise<FsToolResult> {
  if (!pathValue.trim()) {
    return { name: 'patch_file', ok: false, summary: 'patch_file needs a path' }
  }
  if (typeof oldText !== 'string' || typeof newText !== 'string') {
    return { name: 'patch_file', ok: false, summary: 'patch_file needs old and new snippets' }
  }
  const absolute = await resolveWritablePath(pathValue, opts)
  const current = await withFolderAccess(dirname(absolute), () => readFileSync(absolute, 'utf8'))
  const next = applySnippetReplacement(current, oldText, newText)
  if (!next.ok) {
    return { name: 'patch_file', ok: false, path: absolute, summary: next.error }
  }
  await withFolderAccess(dirname(absolute), () => {
    writeFileSync(absolute, next.text, 'utf8')
  })
  const verify = await withFolderAccess(dirname(absolute), () => readFileSync(absolute, 'utf8'))
  if (verify !== next.text) {
    return { name: 'patch_file', ok: false, path: absolute, summary: `Patch did not stick on ${absolute}` }
  }
  return {
    name: 'patch_file',
    ok: true,
    path: absolute,
    summary: `Patched ${absolute}`,
    data: { bytes: next.text.length }
  }
}

async function runShellTool(
  command: string,
  cwdArg: string | undefined,
  opts?: { preferHints?: string[]; sender?: Electron.WebContents }
): Promise<FsToolResult> {
  const trimmed = command.trim()
  if (!trimmed) {
    return { name: 'run_shell', ok: false, summary: 'Empty shell command' }
  }
  if (BLOCKED_SHELL.test(trimmed) || /\|\s*sudo\b/i.test(trimmed)) {
    return {
      name: 'run_shell',
      ok: false,
      summary: 'Blocked: admin / privilege-escalation commands are not allowed.'
    }
  }
  if (BLOCKED_PATH.test(trimmed) && !getWorkspaceRoots().some((root) => trimmed.includes(root))) {
    return {
      name: 'run_shell',
      ok: false,
      summary: 'Blocked: command targets a protected system path.'
    }
  }

  let cwd = getWorkspaceRoots()[0]
  if (!cwd) {
    throw new Error('No granted folders. Rowe needs folder access before running shell commands.')
  }
  if (cwdArg) {
    cwd = await resolveWritablePath(cwdArg, opts)
  }
  assertUnderGrantedRoots(cwd)

  try {
    const { stdout, stderr } = await withFolderAccess(cwd, async () =>
      execFileAsync('/bin/bash', ['-lc', trimmed], {
        cwd,
        timeout: SHELL_TIMEOUT_MS,
        maxBuffer: 2_000_000,
        env: {
          ...process.env,
          HOME: process.env.HOME,
          PATH: process.env.PATH
        }
      })
    )
    const out = [stdout, stderr].filter(Boolean).join('\n').trim()
    const clipped = out.length > 40_000 ? out.slice(0, 40_000) + '\n…(truncated)' : out
    return {
      name: 'run_shell',
      ok: true,
      path: cwd,
      summary: `Shell ok in ${cwd}: ${trimmed.slice(0, 80)}`,
      data: { stdout: clipped, exitCode: 0 }
    }
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number; message?: string }
    const out = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n').trim()
    return {
      name: 'run_shell',
      ok: false,
      path: cwd,
      summary: `Shell failed (code ${err.code ?? 1}): ${trimmed.slice(0, 80)}`,
      data: { stdout: out.slice(0, 40_000), exitCode: err.code ?? 1 }
    }
  }
}


/**
 * Deterministic fallback when the model only reads and never writes.
 * Handles "add a comment at the top of X saying Y" style asks.
 */
export async function fulfillSimpleFileEdit(
  question: string,
  opts?: { preferHints?: string[]; sender?: Electron.WebContents; lastReadPath?: string }
): Promise<FsToolResult | null> {
  const comment = extractCommentText(question)
  if (!comment) return null

  const pathHint =
    extractFileHint(question) ||
    opts?.lastReadPath ||
    ''
  if (!pathHint) return null

  const wantsTop = /\b(top|beginning|start|header)\b/i.test(question) || /\bcomment\b/i.test(question)
  if (!wantsTop && !/\badd\b/i.test(question)) return null

  const absolute = await resolveWritablePath(pathHint, opts)
  const current = await withFolderAccess(dirname(absolute), () => readFileSync(absolute, 'utf8'))

  const commentLine = commentStyleFor(absolute, comment)
  if (current.includes(comment) || current.includes(commentLine.trim())) {
    return {
      name: 'patch_file',
      ok: true,
      path: absolute,
      summary: `Comment already present in ${absolute}`
    }
  }

  // Insert after a leading shebang / encoding comment if present; else at byte 0.
  let next = current
  const bomOrShebang = current.match(/^(#!.*\n|\/\/\s*@.*\n|\/\*[\s\S]*?\*\/\s*\n)/)
  if (bomOrShebang) {
    const idx = bomOrShebang[0].length
    next = current.slice(0, idx) + commentLine + current.slice(idx)
  } else {
    next = commentLine + current
  }

  await withFolderAccess(dirname(absolute), () => {
    writeFileSync(absolute, next, 'utf8')
  })
  const verify = await withFolderAccess(dirname(absolute), () => readFileSync(absolute, 'utf8'))
  if (!verify.startsWith(commentLine) && !verify.includes(commentLine.trim())) {
    return {
      name: 'patch_file',
      ok: false,
      path: absolute,
      summary: `Failed to verify comment write on ${absolute}`
    }
  }
  return {
    name: 'patch_file',
    ok: true,
    path: absolute,
    summary: `Wrote comment at top of ${absolute}`,
    data: { comment }
  }
}

function extractCommentText(question: string): string | null {
  const patterns = [
    /saying\s+["']([^"']+)["']/i,
    /saying\s+([^\n,]+?)(?:,\s*)?(?:\s+at\s+the\s+top\b|\s+at\s+the\s+beginning\b|\s+at\s+|\s+in\s+|$)/i,
    /comment\s+(?:that\s+says\s+)?["']([^"']+)["']/i,
    /comment\s+(?:at\s+the\s+top\s+)?(?:of\s+\S+\s+)?(?:file\s+)?saying\s+(.+?)$/i,
    /add\s+a\s+comment[^\n]*?\bsaying\s+(.+?)$/i
  ]
  for (const re of patterns) {
    const m = question.match(re)
    if (m?.[1]) return m[1].trim().replace(/\s+/g, ' ')
  }
  return null
}

function extractFileHint(question: string): string | null {
  const m =
    question.match(/\b([\w./-]+\.(?:dart|tsx?|jsx?|py|swift|kt|java|go|rs|css|html|md))\b/i) ||
    question.match(/\bin\s+([\w./-]+)\b/i)
  return m?.[1] || null
}

function commentStyleFor(filePath: string, text: string): string {
  const lower = filePath.toLowerCase()
  if (/\.(py|sh|rb|yaml|yml)$/.test(lower)) return `# ${text}\n`
  if (/\.(css|scss)$/.test(lower)) return `/* ${text} */\n`
  if (/\.(html|xml)$/.test(lower)) return `<!-- ${text} -->\n`
  return `// ${text}\n`
}

export function formatToolResultsForModel(results: FsToolResult[]): string {
  return results
    .map((result) => {
      const payload = {
        name: result.name,
        ok: result.ok,
        path: result.path,
        summary: result.summary,
        data: result.data
      }
      return `Tool result (${result.name}):\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``
    })
    .join('\n\n')
}
