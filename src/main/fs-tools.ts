import { execFile, spawn } from 'child_process'
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
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'path'

const execFileAsync = promisify(execFile)
import { getWorkspaceRoots, isPathGranted, requestTrayFileAccess, withFolderAccess } from './local-folder'
import { resolveEditPath, applySnippetReplacement, ensureWriteAccess } from './file-edits'

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
const INLINE_TOOL_FENCE = /```rowe-tool[ \t]+([\s\S]*?)\s*```/gi
const MAX_READ_CHARS = 120_000
const MAX_LIST_ENTRIES = 400

function env(name: string): string | undefined {
  const value = process.env[name]
  return value && value.trim() ? value.trim() : undefined
}

/** Console + structured detail so failures are pasteable from logs/trail. */
function logFsToolError(
  where: string,
  error: unknown,
  extra?: Record<string, unknown>
): string {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : undefined
  const detail = {
    where,
    message,
    stack,
    ...extra,
    at: new Date().toISOString()
  }
  console.error('[rowe:fs]', JSON.stringify(detail, null, 2))
  if (stack) console.error('[rowe:fs] stack:', stack)
  return message
}

function formatFsFailure(summary: string, error?: unknown, extra?: Record<string, unknown>): string {
  const parts = [summary]
  if (error) {
    const message = logFsToolError('fs-failure', error, extra)
    if (message && !summary.includes(message)) parts.push(`Error: ${message}`)
  } else if (extra && Object.keys(extra).length) {
    console.error('[rowe:fs]', JSON.stringify({ where: 'fs-failure', ...extra, at: new Date().toISOString() }, null, 2))
  }
  return parts.join(' | ')
}

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
  '- run_shell { "command": "bash -lc style command", "cwd"?: "project/subdir" } — non-admin only; blocked: sudo/su/pkexec and paths outside granted folders.',
  '- For git/branch/commit/push/PR/npm/test/build/typecheck/CLI asks: use run_shell (or github.* tools). Do NOT call write_file unless the user named a file to edit. When shell/github succeeds, the ask is done — do not invent a write_file.',
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
  // Some gateways emit the JSON immediately after the fence label instead of
  // putting it on the next line. Parse that form before the multiline form;
  // otherwise the multiline regex treats the JSON as fence metadata.
  let cleaned = text.replace(INLINE_TOOL_FENCE, (_full, body: string) => {
    const parsed = parseToolBody(String(body).trim())
    if (!parsed) return _full
    calls.push(parsed)
    return ''
  })
  cleaned = cleaned.replace(TOOL_FENCE, (_full, body: string) => {
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

  // OmniRoute / Dots-style tool wrappers
  cleaned = cleaned.replace(/<dots_function_call>\s*([\s\S]*?)<\/dots_function_call>/gi, (_full, body: string) => {
    const parsed = parseXmlToolBody(String(body)) || parseDotsToolBody(String(body))
    if (!parsed) return ''
    if (parsed.name === 'write_file' && typeof parsed.args.content !== 'string') return ''
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
    .replace(/<dots_function_call>[\s\S]*?<\/dots_function_call>/gi, '')
    .replace(/<\/?tool_call>|<\/?dots_function_call>|<\/?arg_key>|<\/?arg_value>|<\/?parameter>|<\/?parameters>/gi, '')
    .replace(/<dots_function_call>/gi, '')
    .replace(/\b[\w./-]+\.(dart|tsx?|jsx?|py|json|md|swift|kt)\'\)\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return {
    text: cleaned,
    calls
  }
}



function parseDotsToolBody(body: string): FsToolCall | null {
  const trimmed = body.trim()
  if (!trimmed) return null
  // JSON form
  if (trimmed.startsWith('{')) {
    return parseToolBody(trimmed)
  }
  // name then key=value / key: value lines
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return null
  const name = lines[0].replace(/^tool\s*[:=]\s*/i, '').toLowerCase() as FsToolName
  if (!isToolName(name)) {
    // maybe "invoke tool_name"
    const m = trimmed.match(/\b(list_dir|read_file|write_file|mkdir|delete_path|path_exists|run_shell|patch_file)\b/i)
    if (!m) return null
    const toolName = m[1].toLowerCase() as FsToolName
    const args = parseLooseArgs(trimmed.slice(m.index! + m[0].length))
    // also arg_key style
    const kv = trimmed.matchAll(/<arg_key>\s*([^<]+?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi)
    for (const match of kv) args[match[1].trim()] = match[2]
    return { name: toolName, args }
  }
  const args: Record<string, unknown> = {}
  for (const line of lines.slice(1)) {
    const m = line.match(/^([a-zA-Z_][\w]*)\s*[:=]\s*(.*)$/)
    if (m) args[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  const kv = trimmed.matchAll(/<arg_key>\s*([^<]+?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi)
  for (const match of kv) args[match[1].trim()] = match[2]
  return { name, args }
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
    const pythonResult = await executePythonFsTool(call, opts)
    if (pythonResult) return pythonResult
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
    const summary = formatFsFailure(
      `${call.name} failed`,
      error,
      { tool: call.name, args: call.args }
    )
    return {
      name: call.name,
      ok: false,
      summary,
      data: {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }
    }
  }
}

class PythonWorkerUnavailable extends Error {}

/** Run deterministic file operations through the editable Python worker. */
async function executePythonFsTool(
  call: FsToolCall,
  opts?: { preferHints?: string[]; sender?: Electron.WebContents }
): Promise<FsToolResult | null> {
  if (call.name === 'run_shell' || env('ROWE_FS_BACKEND') === 'typescript') return null

  const isWrite = ['write_file', 'patch_file', 'mkdir'].includes(call.name)
  const isDelete = call.name === 'delete_path'
  const rawPath = String(call.args.path || (call.name === 'list_dir' ? '.' : ''))
  let absolutePath = ''
  if (call.name !== 'path_exists') {
    absolutePath = await resolveWritablePath(rawPath, { ...opts, createParents: isWrite })
    if (isWrite || isDelete) {
      const access = await ensureWriteAccess(
        call.name === 'mkdir' ? absolutePath : absolutePath,
        opts?.sender
      )
      if (!access.granted) {
        return {
          name: call.name,
          ok: false,
          path: absolutePath,
          summary: 'Write access was not granted for that folder.'
        }
      }
    }
  }

  const args = { ...call.args }
  if (absolutePath) args.path = absolutePath
  const payload = { name: call.name, args, roots: getWorkspaceRoots() }
  const accessPath = absolutePath || getWorkspaceRoots()[0]
  try {
    const result = await withFolderAccess(accessPath || '.', () => runPythonWorker(payload))
    if (!result.ok) {
      console.error(
        '[rowe:fs]',
        JSON.stringify(
          {
            where: 'python-worker-result',
            tool: call.name,
            path: result.path || absolutePath,
            summary: result.summary,
            data: result.data,
            at: new Date().toISOString()
          },
          null,
          2
        )
      )
    }
    return result
  } catch (error) {
    if (error instanceof PythonWorkerUnavailable) {
      console.warn('[rowe:fs] Python worker unavailable; falling back to TypeScript path.', error)
      return null
    }
    const summary = formatFsFailure('Python filesystem worker failed', error, {
      tool: call.name,
      path: absolutePath,
      roots: getWorkspaceRoots()
    })
    return {
      name: call.name,
      ok: false,
      path: absolutePath || undefined,
      summary,
      data: {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }
    }
  }
}

function pythonWorkerPath(): string {
  const candidates = [
    join(process.resourcesPath || '', 'rowe_fs_agent.py'),
    join(process.cwd(), 'scripts', 'rowe_fs_agent.py'),
    join(__dirname, '../../scripts/rowe_fs_agent.py')
  ]
  const found = candidates.find((candidate) => candidate && existsSync(candidate))
  if (!found) throw new PythonWorkerUnavailable('Rowe Python filesystem worker is missing.')
  return found
}

async function runPythonWorker(payload: Record<string, unknown>): Promise<FsToolResult> {
  const script = pythonWorkerPath()
  const configured = env('ROWE_PYTHON')
  const interpreters = configured ? [configured] : process.platform === 'win32' ? ['python.exe', 'python'] : ['python3', 'python']
  let lastError: unknown

  for (const interpreter of interpreters) {
    try {
      const result = await spawnPython(interpreter, script, payload)
      return result
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
  }
  throw new PythonWorkerUnavailable(
    `Python is required for filesystem operations. Set ROWE_PYTHON to a Python 3 executable.${lastError ? ` ${String(lastError)}` : ''}`
  )
}

function spawnPython(interpreter: string, script: string, payload: Record<string, unknown>): Promise<FsToolResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(interpreter, [script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Python filesystem worker timed out.'))
    }, 30_000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        const detail = [
          `Python filesystem worker exited with code ${code ?? 1}`,
          stderr.trim() ? `stderr: ${stderr.trim()}` : '',
          stdout.trim() ? `stdout: ${stdout.trim().slice(0, 500)}` : ''
        ]
          .filter(Boolean)
          .join(' | ')
        console.error('[rowe:fs] python exit', detail)
        reject(new Error(detail))
        return
      }
      try {
        const result = JSON.parse(stdout) as FsToolResult
        if (!result.ok) {
          console.error('[rowe:fs] python ok:false', JSON.stringify(result, null, 2))
        }
        resolveResult(result)
      } catch (parseError) {
        const detail = `Python filesystem worker returned invalid JSON: ${stdout.slice(0, 500)}${
          stderr.trim() ? ` | stderr: ${stderr.trim()}` : ''
        }`
        console.error('[rowe:fs]', detail, parseError)
        reject(new Error(detail))
      }
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

async function resolveWritablePath(
  pathValue: string,
  opts?: { preferHints?: string[]; sender?: Electron.WebContents; createParents?: boolean }
): Promise<string> {
  const hints = opts?.preferHints || []
  // Prefer real on-disk matches (file or folder). Never invent a missing path.
  let absolute =
    resolveEditPath(pathValue, hints) ||
    resolveExistingPathUnderRoots(pathValue, hints) ||
    ''
  // Model often invents wrong absolute casing/structure (Flutter/... vs flutter/...).
  // Fall back to the leaf name under granted roots.
  if (!absolute && pathValue.trim()) {
    const leaf = basename(pathValue.trim().replace(/^["']|["']$/g, ''))
    if (leaf && leaf.toLowerCase() !== pathValue.trim().toLowerCase()) {
      absolute =
        resolveEditPath(leaf, hints) ||
        resolveExistingPathUnderRoots(leaf, hints) ||
        ''
    }
  }
  if (!absolute && pathValue.trim() && opts?.createParents) {
    absolute = resolveNewPathUnderRoots(pathValue, hints) || ''
    if (!absolute) {
      absolute = resolveNewFileBesideExistingLeaf(pathValue, hints) || ''
    }
  }
  if (!absolute) {
    const access = await requestTrayFileAccess(opts?.sender, {
      question: pathValue,
      targetLabel: basename(pathValue || 'folder'),
      defaultPath: guessDefaultPathForPicker(pathValue),
      reason: `Rowe needs folder access to work with “${pathValue || 'that path'}”. Choose the real project folder if the path looks wrong.`,
      wantFile: false
    })
    if (!access.granted) {
      throw new Error('Folder access was not granted.')
    }
    absolute =
      resolveEditPath(pathValue, hints) ||
      resolveExistingPathUnderRoots(pathValue, hints) ||
      ''
    if (!absolute) {
      const leaf = basename(pathValue.trim().replace(/^["']|["']$/g, ''))
      if (leaf && leaf.toLowerCase() !== pathValue.trim().toLowerCase()) {
        absolute =
          resolveEditPath(leaf, hints) ||
          resolveExistingPathUnderRoots(leaf, hints) ||
          ''
      }
    }
    if (!absolute && opts?.createParents) {
      absolute =
        resolveNewPathUnderRoots(pathValue, hints) ||
        resolveNewFileBesideExistingLeaf(pathValue, hints) ||
        ''
    }
  }
  if (!absolute) {
    throw new Error(
      `Could not find “${pathValue}” under granted folders. Named path must exist (or Allow the correct project folder).`
    )
  }
  if (!opts?.createParents && !existsSync(absolute)) {
    throw new Error(`Path does not exist: ${absolute}`)
  }
  assertUnderGrantedRoots(absolute)
  return absolute
}

function guessDefaultPathForPicker(pathValue: string): string | undefined {
  const existing = resolveExistingPathUnderRoots(pathValue, [])
  if (existing) return existing
  const leaf = basename(pathValue.trim())
  if (!leaf) return undefined
  const hit = resolveExistingPathUnderRoots(leaf, [])
  return hit || undefined
}

/** Find an existing file OR directory under granted roots (case-insensitive). */
function resolveExistingPathUnderRoots(
  pathValue: string,
  preferHints: string[]
): string | undefined {
  const raw = pathValue.trim().replace(/^["']|["']$/g, '')
  if (!raw) return undefined
  if (isAbsolute(raw)) {
    if (!existsSync(raw)) return undefined
    assertUnderGrantedRoots(raw)
    return resolve(raw)
  }

  const roots = getWorkspaceRoots()
  const candidates: string[] = []
  const rawLower = raw.replace(/\\/g, '/').toLowerCase()
  const leaf = basename(raw).toLowerCase()

  for (const root of roots) {
    const direct = resolve(root, raw)
    if (existsSync(direct)) candidates.push(resolve(direct))
  }

  // Case-insensitive / partial: search for the leaf name under roots.
  for (const root of roots) {
    candidates.push(...shallowFindExistingByLeaf(root, leaf, 10))
  }

  // Also try matching relative suffix ignoring case (flutter vs Flutter).
  for (const root of roots) {
    candidates.push(...shallowFindExistingByRelativeSuffix(root, rawLower, 10))
  }

  const unique = [...new Set(candidates)].filter((path) => existsSync(path))
  if (!unique.length) return undefined
  unique.sort(
    (a, b) =>
      scoreExistingPath(b, preferHints, raw) - scoreExistingPath(a, preferHints, raw)
  )
  return unique[0]
}

function scoreExistingPath(filePath: string, preferHints: string[], requested: string): number {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase()
  const req = requested.replace(/\\/g, '/').toLowerCase()
  let score = 0
  if (normalized.endsWith('/' + basename(req)) || normalized.endsWith(req)) score += 100
  if (normalized.includes(req)) score += 60
  for (const hint of preferHints) {
    const h = hint.trim().toLowerCase()
    if (h && normalized.includes(h)) score += 80
  }
  if (/\/projects\//.test(normalized)) score += 40
  // Prefer deeper real project folders over shallow wrong joins.
  score += Math.min(30, normalized.split('/').length)
  return score
}

function shallowFindExistingByLeaf(root: string, leafLower: string, maxDepth: number): string[] {
  if (!leafLower) return []
  const found: string[] = []
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  const started = Date.now()
  while (stack.length) {
    if (Date.now() - started > 2500 || found.length >= 40) break
    const current = stack.pop()
    if (!current || current.depth > maxDepth) continue
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'build') continue
      const next = join(current.dir, entry.name)
      if (entry.name.toLowerCase() === leafLower) found.push(resolve(next))
      if (entry.isDirectory() && current.depth < maxDepth) {
        stack.push({ dir: next, depth: current.depth + 1 })
      }
    }
  }
  return found
}

function shallowFindExistingByRelativeSuffix(
  root: string,
  relativeLower: string,
  maxDepth: number
): string[] {
  if (!relativeLower || !relativeLower.includes('/')) return []
  const found: string[] = []
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  const started = Date.now()
  const rootLower = root.replace(/\\/g, '/').toLowerCase()
  while (stack.length) {
    if (Date.now() - started > 2500 || found.length >= 40) break
    const current = stack.pop()
    if (!current || current.depth > maxDepth) continue
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'build') continue
      const next = join(current.dir, entry.name)
      const fullLower = resolve(next).replace(/\\/g, '/').toLowerCase()
      if (fullLower.endsWith('/' + relativeLower) || fullLower.endsWith(relativeLower)) {
        found.push(resolve(next))
      }
      if (entry.isDirectory() && current.depth < maxDepth) {
        stack.push({ dir: next, depth: current.depth + 1 })
      }
    }
  }
  // silence unused
  void rootLower
  return found
}

function resolveNewFileBesideExistingLeaf(
  pathValue: string,
  preferHints: string[]
): string | undefined {
  const raw = pathValue.trim().replace(/^["']|["']$/g, '')
  if (!raw || isAbsolute(raw)) return undefined
  const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length < 2) return undefined
  const fileName = parts[parts.length - 1]
  const parentLeaf = parts[parts.length - 2]
  const parentDir = resolveExistingPathUnderRoots(parentLeaf, preferHints)
  if (!parentDir || !existsSync(parentDir) || !statSync(parentDir).isDirectory()) return undefined
  return resolve(parentDir, fileName)
}

function resolveNewPathUnderRoots(pathValue: string, preferHints: string[]): string | undefined {
  const raw = pathValue.trim().replace(/^["']|["']$/g, '')
  if (!raw) return undefined
  if (isAbsolute(raw)) {
    // Only allow absolute new paths when the parent folder already exists.
    if (!existsSync(dirname(raw))) return undefined
    assertUnderGrantedRoots(raw)
    return normalize(raw)
  }
  const roots = getWorkspaceRoots()
  const scored = roots
    .map((root) => {
      const candidate = resolve(root, raw)
      const parent = dirname(candidate)
      if (!existsSync(parent)) return null
      let score = 0
      for (const hint of preferHints) {
        if (candidate.toLowerCase().includes(hint.toLowerCase())) score += 80
      }
      if (/\/projects\//i.test(candidate)) score += 40
      return { candidate, score }
    })
    .filter((item): item is { candidate: string; score: number } => Boolean(item))
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
    if (!stats.isDirectory()) throw new Error(`Not a directory: ${absolute}`)
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
  const absolute = await resolveWritablePath(pathValue, { ...opts, createParents: true })
  const access = await ensureWriteAccess(absolute, opts?.sender)
  if (!access.granted) {
    return { name: 'write_file', ok: false, path: absolute, summary: 'Write access was not granted for that folder.' }
  }
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
  const absolute = await resolveWritablePath(pathValue, { ...opts, createParents: true })
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
  const access = await ensureWriteAccess(absolute, opts?.sender)
  if (!access.granted) {
    return { name: 'patch_file', ok: false, path: absolute, summary: 'Write access was not granted for that folder.' }
  }
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

/** When the model stalls on a feature-flag ask, add the flag into feature_flags.dart (flag only). */
export async function fulfillFeatureFlagEdit(
  question: string,
  opts?: { preferHints?: string[]; sender?: Electron.WebContents; lastReadPath?: string }
): Promise<FsToolResult | null> {
  if (!/\bfeature\s*flag\b|\bpay\s*tab\b/i.test(question)) return null

  const flag = deriveFeatureFlagName(question)
  if (!flag) return null
  const enabled = !/\bdisable|turn off|false\b/i.test(question)

  const pathHint =
    opts?.lastReadPath && /feature_flags\.dart$/i.test(opts.lastReadPath)
      ? opts.lastReadPath
      : 'lib/feature_flags.dart'

  const preferHints = [
    ...(opts?.preferHints || []),
    'payemm',
    'payemm_mobile_app',
    'flutter',
    'feature_flags'
  ]
  let absolute = ''
  try {
    absolute = await resolveWritablePath(pathHint, { ...opts, preferHints })
  } catch {
    absolute = ''
  }
  // Stable fallback for the known Payemm app
  if (!absolute || !/feature_flags\.dart$/i.test(absolute)) {
    const known = [
      ...getWorkspaceRoots().flatMap((root) => [
        resolve(root, 'lib/feature_flags.dart'),
        resolve(root, 'src/feature_flags.dart'),
        resolve(root, 'flutter/payemm_mobile_app/lib/feature_flags.dart'),
        resolve(root, 'payemm_mobile_app/lib/feature_flags.dart')
      ]),
      '/Users/khriseanstewart/dev/projects/flutter/payemm_mobile_app/lib/feature_flags.dart'
    ]
    for (const candidate of known) {
      if (existsSync(candidate)) {
        absolute = candidate
        break
      }
    }
  }
  if (!absolute) {
    return {
      name: 'patch_file',
      ok: false,
      summary: 'Could not find feature_flags.dart under granted folders. Allow the payemm project folder once.'
    }
  }
  // Prompt for the project folder if this path is not granted yet.
  if (!isPathGranted(absolute) && !isPathGranted(dirname(absolute))) {
    const projectRoot = absolute.includes('payemm_mobile_app')
      ? absolute.slice(0, absolute.indexOf('payemm_mobile_app') + 'payemm_mobile_app'.length)
      : dirname(dirname(absolute))
    const access = await requestTrayFileAccess(opts?.sender, {
      targetLabel: basename(projectRoot),
      defaultPath: projectRoot,
      reason:
        'Rowe needs write access to this project folder to add the feature flag. After you Allow, it can write under that project.',
      wantFile: false
    })
    if (!access.granted) {
      return {
        name: 'patch_file',
        ok: false,
        path: absolute,
        summary: 'Write access was not granted for that project folder.'
      }
    }
  }
  const writeGate = await ensureWriteAccess(absolute, opts?.sender)
  if (!writeGate.granted) {
    return {
      name: 'patch_file',
      ok: false,
      path: absolute,
      summary: 'Write access was not granted for that folder.'
    }
  }
  const current = await withFolderAccess(dirname(absolute), () => readFileSync(absolute, 'utf8'))

  if (current.includes(`FeatureFlagKey.${flag}`) || new RegExp(`\\b${flag}\\b`).test(current)) {
    return {
      name: 'patch_file',
      ok: true,
      path: absolute,
      summary: `Feature flag ${flag} already exists in ${absolute}`
    }
  }

  let next = current

  // 1) defaults map — insert before the last entry's closing brace of _defaults
  if (!next.includes(`FeatureFlagKey.${flag}:`)) {
    const mapStart = next.indexOf('static const Map<FeatureFlagKey')
    const mapOpen = mapStart === -1 ? -1 : next.indexOf('{', mapStart)
    const mapClose = mapOpen === -1 ? -1 : next.indexOf('\n  }', mapOpen)
    if (mapClose === -1) {
      return { name: 'patch_file', ok: false, path: absolute, summary: 'Could not find _defaults map to patch' }
    }
    next =
      next.slice(0, mapClose) +
      `\n    FeatureFlagKey.${flag}: ${enabled ? 'true' : 'false'},` +
      next.slice(mapClose)
  }

  // 2) getter — insert before enum FeatureFlagKey
  if (!next.includes(`static bool get ${flag}`)) {
    const enumIdx = next.indexOf('\nenum FeatureFlagKey')
    if (enumIdx === -1) {
      return { name: 'patch_file', ok: false, path: absolute, summary: 'Could not find FeatureFlagKey enum' }
    }
    // insert before the closing brace of the class (just before enum)
    const classClose = next.lastIndexOf('}', enumIdx)
    const getter =
      `  static bool get ${flag} =>\n` +
      `      _getBool(FeatureFlagKey.${flag});\n\n`
    next = next.slice(0, classClose) + getter + next.slice(classClose)
  }

  // 3) enum value — append before closing of enum
  if (!new RegExp(`\\b${flag},`).test(next.split('enum FeatureFlagKey')[1] || '')) {
    const enumBlockStart = next.indexOf('enum FeatureFlagKey')
    const enumOpen = next.indexOf('{', enumBlockStart)
    const enumClose = next.indexOf('}', enumOpen)
    // insert before last enum entry's closing — after last comma line
    next = next.slice(0, enumClose) + `  ${flag},\n` + next.slice(enumClose)
  }

  await withFolderAccess(dirname(absolute), () => {
    writeFileSync(absolute, next, 'utf8')
  })
  const verify = await withFolderAccess(dirname(absolute), () => readFileSync(absolute, 'utf8'))
  if (!verify.includes(`FeatureFlagKey.${flag}`)) {
    return {
      name: 'patch_file',
      ok: false,
      path: absolute,
      summary: `Failed to verify feature flag write for ${flag}`
    }
  }
  return {
    name: 'patch_file',
    ok: true,
    path: absolute,
    summary: `Added feature flag ${flag}=${enabled} in ${absolute}`,
    data: { flag, enabled }
  }
}

function deriveFeatureFlagName(question: string): string | null {
  // "enable the pay tab" / "pay tab feature flag" -> isPayTabFeatureEnabled
  const quoted = question.match(/feature\s*flag[^.\n]*?\b(?:for|to\s+enable|named|called)?\s*["']?([a-z0-9][\w\s-]{1,40})["']?/i)
  const payTab = question.match(/\bpay\s*tab\b/i)
  let raw = ''
  if (payTab) raw = 'pay tab'
  else if (quoted?.[1]) raw = quoted[1]
  else {
    const enable = question.match(/\b(?:enable|for)\s+(?:the\s+)?([a-z][\w\s-]{1,40}?)(?:\s+tab|\s+feature)?/i)
    if (enable?.[1]) raw = enable[1]
  }
  if (!raw) return null
  const parts = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((part) => part && !['the', 'a', 'an', 'to', 'for', 'feature', 'flag', 'enable', 'enabled'].includes(part))
  if (!parts.length) return null
  const camel = parts
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('')
  const titled = parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')
  if (/^is[A-Z]/.test(camel) || /^enable[A-Z]/.test(camel)) return camel.endsWith('Enabled') ? camel : `${camel}Enabled`
  return `is${titled}FeatureEnabled`
}


/** Write full contents to a resolved path under granted roots (shared by tool + fulfillers). */
export async function writeResolvedFile(
  pathHint: string,
  content: string,
  opts?: { preferHints?: string[]; sender?: Electron.WebContents }
): Promise<FsToolResult> {
  try {
    const body = content.endsWith('\n') ? content : `${content}\n`
    // Prefer the same Python/TS execute path as tool calls (permissions + verify).
    const viaTool = await executeFsTool(
      { name: 'write_file', args: { path: pathHint, content: body } },
      opts
    )
    if (!viaTool.ok) {
      console.error(
        '[rowe:fs]',
        JSON.stringify(
          {
            where: 'writeResolvedFile',
            pathHint,
            summary: viaTool.summary,
            path: viaTool.path,
            data: viaTool.data,
            at: new Date().toISOString()
          },
          null,
          2
        )
      )
    }
    return viaTool
  } catch (error) {
    const summary = formatFsFailure(`Could not write ${pathHint}`, error, { pathHint })
    return {
      name: 'write_file',
      ok: false,
      summary,
      data: {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }
    }
  }
}

export { extractNamedWriteTarget, isGeneratedDocumentWriteRequest, isPrimarilyDevCommandAsk, wantsFileMutation } from './write-intent'

export async function fulfillPendingMutation(
  question: string,
  opts?: { preferHints?: string[]; sender?: Electron.WebContents; lastReadPath?: string }
): Promise<FsToolResult | null> {
  return (
    (await fulfillClearFileEdit(question, opts)) ||
    (await fulfillExplicitTextFileRewrite(question, opts)) ||
    (await fulfillFeatureFlagEdit(question, opts)) ||
    (await fulfillSimpleFileEdit(question, opts))
  )
}

/**
 * Complete an explicitly requested full-file replacement without depending on
 * the model to serialize a write_file tool call. This deliberately accepts
 * only a named file and a clear "make it say …" / "replace with …"
 * instruction, since this operation overwrites the whole file.
 */
export async function fulfillExplicitTextFileRewrite(
  question: string,
  opts?: { preferHints?: string[]; sender?: Electron.WebContents; lastReadPath?: string }
): Promise<FsToolResult | null> {
  const requested = extractExplicitReplacement(question)
  if (!requested) return null

  const pathHint = extractTargetFileHint(question) || opts?.lastReadPath
  if (!pathHint) return null

  const resolved = resolveEditPath(pathHint, opts?.preferHints) || opts?.lastReadPath
  if (!resolved) return null
  const absolute = await resolveWritablePath(resolved, opts)
  const access = await ensureWriteAccess(absolute, opts?.sender)
  if (!access.granted) {
    return {
      name: 'write_file',
      ok: false,
      path: absolute,
      summary: 'Write access was not granted for that folder.'
    }
  }

  const content = requested.endsWith('\n') ? requested : `${requested}\n`
  await withFolderAccess(dirname(absolute), () => {
    writeFileSync(absolute, content, 'utf8')
  })
  const verify = await withFolderAccess(dirname(absolute), () => readFileSync(absolute, 'utf8'))
  if (verify !== content) {
    return {
      name: 'write_file',
      ok: false,
      path: absolute,
      summary: `Write did not stick on ${absolute}`
    }
  }
  return {
    name: 'write_file',
    ok: true,
    path: absolute,
    summary: `Replaced all contents of ${absolute}`,
    data: { bytes: content.length }
  }
}

function extractExplicitReplacement(question: string): string | null {
  const value = question.trim()
  if (!/\b(?:override|overwrite|replace|rewrite|set|change|update|ensure)\b/i.test(value)) {
    return null
  }
  if (!/\b(?:file|readme|content|contents|text)\b/i.test(value)) return null

  const quoted = value.match(/\b(?:say|says|with|to)\s*["']([^"']+)["']\s*[.!]?\s*$/i)
  const unquoted = value.match(/\b(?:say|says|with)\s+(.+?)\s*[.!]?\s*$/i)
  const content = (quoted?.[1] || unquoted?.[1] || '').trim()
  // Do not treat a vague "replace the README" as permission to erase it.
  return content && content.length <= 20_000 ? content : null
}

/** Pull an explicit filename from everyday wording without treating pronouns as paths. */
function extractTargetFileHint(question: string): string | null {
  const explicitPath = question.match(
    /\b([\w./-]+\.(?:dart|tsx?|jsx?|py|swift|kt|java|go|rs|css|scss|html|md|json|ya?ml|txt|xml|sh|rb))\b/i
  )
  if (explicitPath?.[1]) return explicitPath[1]

  const named = question.match(
    /\b(?:the\s+)?(?:current\s+)?([A-Za-z][\w.-]{1,80})\s+(?:file|document)\b/i
  )
  if (named?.[1] && !['this', 'that', 'current', 'content', 'contents', 'text'].includes(named[1].toLowerCase())) {
    return named[1]
  }

  const called = question.match(/\b(?:file|document)\s+(?:named|called)\s+["']?([\w./-]+)["']?/i)
  return called?.[1] || null
}

/**
 * A direct "clear this file" request has an unambiguous result, so do not
 * depend on a model producing a write_file fence after it has already read it.
 */
export async function fulfillClearFileEdit(
  question: string,
  opts?: { preferHints?: string[]; sender?: Electron.WebContents; lastReadPath?: string }
): Promise<FsToolResult | null> {
  if (!isClearFileRequest(question)) return null
  const hintedPath = opts?.lastReadPath || clearFileHint(question)
  if (!hintedPath) return null
  // Do not turn an ambiguous clear request into a new empty file. A path read
  // earlier in this turn is authoritative; otherwise require an existing match.
  const path = opts?.lastReadPath || resolveEditPath(hintedPath, opts?.preferHints)
  if (!path) return null

  const absolute = await resolveWritablePath(path, opts)
  const access = await ensureWriteAccess(absolute, opts?.sender)
  if (!access.granted) {
    return {
      name: 'write_file',
      ok: false,
      path: absolute,
      summary: 'Write access was not granted for that folder.'
    }
  }

  await withFolderAccess(dirname(absolute), () => {
    writeFileSync(absolute, '', 'utf8')
  })
  const verify = await withFolderAccess(dirname(absolute), () => readFileSync(absolute, 'utf8'))
  if (verify !== '') {
    return {
      name: 'write_file',
      ok: false,
      path: absolute,
      summary: `Could not verify that ${absolute} was cleared.`
    }
  }
  return {
    name: 'write_file',
    ok: true,
    path: absolute,
    summary: `Cleared ${absolute}`,
    data: { bytes: 0 }
  }
}

function clearFileHint(question: string): string | undefined {
  return extractTargetFileHint(question) || undefined
}

function isClearFileRequest(question: string): boolean {
  const value = question.toLowerCase()
  const targetsFile = /\b(file|readme|contents?|content|text|info(?:rmation)?)\b/.test(value)
  return (
    targetsFile &&
    (/\b(clear|empty|blank|wipe|truncate)\b/.test(value) ||
      /\bclean\b[\s\S]{0,80}\b(file|readme|contents?)\b/.test(value) ||
      /\bremove\b[\s\S]{0,40}\b(all|everything)\b[\s\S]{0,40}\b(contents?|content|text|info(?:rmation)?)\b/.test(value))
  )
}

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
