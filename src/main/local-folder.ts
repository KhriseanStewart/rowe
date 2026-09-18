import { app, BrowserWindow, dialog, type MessageBoxOptions } from 'electron'
import { existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path'
import { getSettings, updateSettings } from './settings'

const SKIP = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  'vendor',
  '__pycache__'
])

export async function pickLocalFolder(
  sender?: Electron.WebContents
): Promise<{ path: string; bookmark?: string } | undefined> {
  const window = sender ? BrowserWindow.fromWebContents(sender) : BrowserWindow.getFocusedWindow()
  const options: Electron.OpenDialogOptions = {
    title: 'Select a project folder',
    buttonLabel: 'Select folder',
    properties: ['openDirectory', 'createDirectory'],
    securityScopedBookmarks: process.platform === 'darwin'
  }
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) {
    return undefined
  }
  const path = result.filePaths[0]
  const bookmark = result.bookmarks?.[0]
  if (bookmark) {
    rememberFolderBookmark(path, bookmark)
  } else {
    rememberWorkspaceRoot(path)
  }
  return { path, bookmark }
}

export type FileAccessRequest = {
  /** Absolute path to focus the picker on when known. */
  defaultPath?: string
  /** Human label for the dialog, e.g. "React" or "rowe". */
  targetLabel?: string
  /** One-line reason shown in the permission prompt. */
  reason?: string
  /** Prefer picking a file (still bookmarks the parent folder for discovery). */
  wantFile?: boolean
  /** Raw user question — used to infer a specific folder/file target. */
  question?: string
}

/**
 * Ask the user for permission to access folders (or a specific file) on this device.
 * On macOS, choosing a path creates a security-scoped bookmark Rowe can reuse.
 * Choosing a folder also registers it as a workspace root so apps inside it can be discovered.
 */
export async function requestTrayFileAccess(
  sender?: Electron.WebContents,
  request?: FileAccessRequest
): Promise<{ granted: boolean; path?: string; bookmark?: string }> {
  const inferred = request?.question ? resolveAccessTargetFromQuestion(request.question) : undefined
  const targetLabel = request?.targetLabel || inferred?.targetLabel
  const defaultPath = firstExistingPath(request?.defaultPath, inferred?.defaultPath)
  const wantFile = request?.wantFile ?? inferred?.wantFile ?? false
  const reason =
    request?.reason ||
    inferred?.reason ||
    (targetLabel
      ? `You asked about “${targetLabel}”. Choose that ${wantFile ? 'file' : 'folder'} (or its parent) so Rowe can continue.`
      : undefined)

  const window = sender ? BrowserWindow.fromWebContents(sender) : BrowserWindow.getFocusedWindow()
  const hasRoots = getWorkspaceRoots().length > 0
  const specific = Boolean(targetLabel || defaultPath)

  // Always confirm when targeting a specific path, or when no roots exist yet.
  if (!hasRoots || specific) {
    const prompt: MessageBoxOptions = {
      type: 'question',
      buttons: [
        specific
          ? wantFile
            ? 'Allow file access…'
            : 'Allow this folder…'
          : 'Allow folder access…',
        'Not now'
      ],
      defaultId: 0,
      cancelId: 1,
      title: specific
        ? `Allow Rowe to access ${targetLabel ? `“${targetLabel}”` : 'this path'}?`
        : 'Allow Rowe to access files?',
      message: specific
        ? `Rowe needs access to ${targetLabel ? `“${targetLabel}”` : 'a specific folder'} on this device`
        : 'Rowe AI needs access to folders on this device',
      detail:
        reason ||
        'Rowe uses folders you choose to find local apps, read files, and learn folder structure, coding patterns, and packages. Pick a parent folder like “dev” to include the apps inside it. You can add more folders later with /files.'
    }
    const choice = window
      ? await dialog.showMessageBox(window, prompt)
      : await dialog.showMessageBox(prompt)
    if (choice.response !== 0) {
      return { granted: false }
    }
  }

  const options: Electron.OpenDialogOptions = {
    title: specific
      ? wantFile
        ? `Allow access to ${targetLabel || 'file'}`
        : `Allow access to ${targetLabel || 'folder'}`
      : hasRoots
        ? 'Add a folder for Rowe AI'
        : 'Allow Rowe to access a folder',
    message: specific
      ? wantFile
        ? `Choose the file${targetLabel ? ` “${targetLabel}”` : ''} Rowe should read`
        : `Choose the folder${targetLabel ? ` “${targetLabel}”` : ''} Rowe should access`
      : hasRoots
        ? 'Choose another folder that contains apps Rowe should know about'
        : 'Choose a folder Rowe AI may read',
    buttonLabel: specific ? 'Allow access' : hasRoots ? 'Add folder' : 'Allow access',
    properties: wantFile
      ? ['openFile', 'openDirectory', 'createDirectory']
      : ['openDirectory', 'createDirectory'],
    securityScopedBookmarks: process.platform === 'darwin'
  }
  if (defaultPath) {
    options.defaultPath = defaultPath
  }

  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) {
    return { granted: hasRoots, path: hasRoots ? getWorkspaceRoots()[0] : undefined }
  }

  const selected = result.filePaths[0]
  const bookmark = result.bookmarks?.[0]
  let folderPath = selected
  try {
    if (statSync(selected).isFile()) {
      folderPath = dirname(selected)
    }
  } catch {
    folderPath = selected
  }

  if (bookmark) {
    rememberFolderBookmark(folderPath, bookmark)
  }
  rememberWorkspaceRoot(folderPath)
  updateSettings({ trayFileAccessGranted: true })
  return { granted: true, path: folderPath, bookmark }
}

/** True when target is inside an already-granted workspace root. */
export function isPathGranted(target: string): boolean {
  const value = target.trim()
  if (!value) return false
  let normalized: string
  try {
    normalized = resolve(value)
  } catch {
    return false
  }
  for (const root of getWorkspaceRoots()) {
    if (normalized === root || normalized.startsWith(root.endsWith(sep) ? root : root + sep)) {
      return true
    }
  }
  return false
}

/**
 * Infer a concrete folder/file the user is asking about so the permission
 * dialog can open on that path instead of a generic picker.
 */
export function resolveAccessTargetFromQuestion(question: string): FileAccessRequest | undefined {
  const trimmed = question.trim()
  if (!trimmed) return undefined

  const fileMatch = trimmed.match(
    /(?:^|[\s"'`])((?:~\/|\/Users\/|\/home\/|[A-Za-z]:\\)?[^\s"'`]+\.[A-Za-z0-9]{1,8})\b/
  )
  const pathMatch = trimmed.match(
    /(?:~\/|\/Users\/[^\s"'`]+|\/home\/[^\s"'`]+|[A-Za-z]:\\[^\s"'`]+|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/
  )

  const stop = new Set([
    'the', 'and', 'for', 'from', 'with', 'what', 'which', 'this', 'that', 'your', 'mine',
    'please', 'check', 'list', 'scan', 'search', 'find', 'look', 'show', 'folder', 'folders',
    'project', 'projects', 'app', 'apps', 'file', 'files', 'local', 'machine', 'computer',
    'granted', 'access', 'under', 'into', 'about', 'code', 'my', 'a', 'an', 'to', 'in', 'on'
  ])

  const tokens = [...trimmed.matchAll(/\b([A-Za-z][A-Za-z0-9._-]{1,})\b/g)]
    .map((m) => m[1])
    .filter((token) => !stop.has(token.toLowerCase()))

  const bases = candidateSearchBases()
  let defaultPath: string | undefined
  let targetLabel: string | undefined
  let wantFile = false

  if (fileMatch?.[1]) {
    const expanded = expandUserPath(fileMatch[1])
    wantFile = true
    targetLabel = basename(expanded)
    defaultPath = firstExistingPath(expanded, dirname(expanded), findNamedPath(basename(expanded), bases, true))
  } else if (pathMatch?.[0]) {
    const expanded = expandUserPath(pathMatch[0])
    targetLabel = basename(expanded)
    defaultPath = firstExistingPath(expanded, findNamedPath(pathMatch[0], bases, false), findNamedPath(basename(expanded), bases, false))
  }

  if (!defaultPath) {
    for (const token of tokens) {
      const hit = findNamedPath(token, bases, false)
      if (hit) {
        defaultPath = hit
        targetLabel = token
        break
      }
    }
  }

  if (!defaultPath && !targetLabel && tokens[0]) {
    // Still name the thing even if we cannot resolve it on disk yet — picker opens near home/dev.
    targetLabel = tokens[0]
    defaultPath = firstExistingPath(join(homedir(), 'dev', 'projects'), join(homedir(), 'dev'), homedir())
  }

  if (!targetLabel && !defaultPath) return undefined

  return {
    targetLabel,
    defaultPath,
    wantFile,
    reason: targetLabel
      ? `You asked about “${targetLabel}”. Allow that ${wantFile ? 'file' : 'folder'} (or its parent) so Rowe can check it and continue.`
      : undefined
  }
}

function candidateSearchBases(): string[] {
  const home = homedir()
  // Prefer developer trees before $HOME so "rowe" resolves to a project, not Application Support.
  const bases = [
    join(home, 'dev', 'projects'),
    join(home, 'dev'),
    ...getWorkspaceRoots(),
    ...getWorkspaceRoots().map((root) => dirname(root)),
    join(home, 'Documents'),
    join(home, 'Desktop'),
    home
  ]
  const unique: string[] = []
  for (const base of bases) {
    if (!base || unique.includes(base)) continue
    if (!existsSync(base)) continue
    unique.push(base)
  }
  return unique
}

function expandUserPath(value: string): string {
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

function findNamedPath(nameOrRel: string, bases: string[], wantFile: boolean): string | undefined {
  const needle = nameOrRel.replace(/^[~\/]+/, '').replace(/\\/g, '/')
  const lower = needle.toLowerCase()
  const leaf = basename(needle).toLowerCase()

  // Exact relative under a base: React, projects/React, dev/projects/React
  for (const base of bases) {
    const direct = join(base, needle)
    if (existsSync(direct) && matchesKind(direct, wantFile)) return resolve(direct)
  }

  // Shallow search for a matching folder/file name (depth 3).
  for (const base of bases) {
    const hit = shallowFind(base, leaf || lower, wantFile, 3)
    if (hit) return hit
  }
  return undefined
}

function shallowFind(root: string, leafLower: string, wantFile: boolean, maxDepth: number): string | undefined {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  const started = Date.now()
  let best: string | undefined
  while (stack.length) {
    if (Date.now() - started > 1500) break
    const current = stack.pop()
    if (!current || current.depth > maxDepth) continue
    if (isNoiseDir(current.dir)) continue
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (SKIP.has(entry.name)) continue
      if (/^(Library|Application Support|Caches|node_modules)$/i.test(entry.name)) continue
      const next = join(current.dir, entry.name)
      if (entry.name.toLowerCase() === leafLower && matchesKind(next, wantFile) && !isNoiseDir(next)) {
        // Prefer project-like folders (package.json, etc.) over app-support namesakes.
        if (!wantFile && isProjectish(next)) return resolve(next)
        best = best || resolve(next)
      }
      if (entry.isDirectory() && current.depth < maxDepth && !isNoiseDir(next)) {
        stack.push({ dir: next, depth: current.depth + 1 })
      }
    }
  }
  return best
}

function isNoiseDir(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return /\/(Library|Application Support|Caches|\.cursor|\.npm|\.bun)\b/i.test(normalized)
}

function isProjectish(dir: string): boolean {
  try {
    const entries = readdirSync(dir)
    return entries.some((name) =>
      [
        'package.json',
        'pubspec.yaml',
        'Cargo.toml',
        'go.mod',
        'pyproject.toml',
        'composer.json',
        'Gemfile',
        'electron.vite.config.ts',
        'electron.vite.config.js'
      ].includes(name)
    )
  } catch {
    return false
  }
}

function matchesKind(path: string, wantFile: boolean): boolean {
  try {
    const stats = statSync(path)
    return wantFile ? stats.isFile() : stats.isDirectory()
  } catch {
    return false
  }
}

function firstExistingPath(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue
    const expanded = expandUserPath(candidate)
    try {
      if (existsSync(expanded)) return resolve(expanded)
    } catch {
      continue
    }
    // Keep absolute non-existing paths as a picker starting point when parent exists
    if (isAbsolute(expanded)) {
      const parent = dirname(expanded)
      if (existsSync(parent)) return resolve(parent)
    }
  }
  return undefined
}

export function trayFileAccessGranted(): boolean {
  return getWorkspaceRoots().length > 0
}

export function getWorkspaceRoots(): string[] {
  const settings = getSettings()
  const roots = [
    ...(settings.trayWorkspaceRoots || []),
    ...Object.keys(settings.folderBookmarks || {})
  ]
  const unique: string[] = []
  for (const root of roots) {
    const value = root.trim()
    if (!value || unique.includes(value)) continue
    if (!existsSync(value)) continue
    unique.push(value)
  }
  return unique
}

export function rememberWorkspaceRoot(path: string): void {
  const value = path.trim()
  if (!value) return
  const current = getSettings().trayWorkspaceRoots || []
  if (current.includes(value)) return
  updateSettings({ trayWorkspaceRoots: [...current, value] })
}

export function rememberFolderBookmark(path: string, bookmark: string): void {
  const settings = getSettings()
  const current = settings.folderBookmarks || {}
  const roots = settings.trayWorkspaceRoots || []
  updateSettings({
    folderBookmarks: {
      ...current,
      [path]: bookmark
    },
    trayWorkspaceRoots: roots.includes(path) ? roots : [...roots, path]
  })
}

export async function withFolderAccess<T>(path: string, run: () => Promise<T> | T): Promise<T> {
  const bookmark = getSettings().folderBookmarks?.[path]
  if (!bookmark || process.platform !== 'darwin') {
    return await run()
  }
  let stop: (() => void) | undefined
  try {
    stop = app.startAccessingSecurityScopedResource(bookmark) as () => void
  } catch {
    stop = undefined
  }
  try {
    return await run()
  } finally {
    stop?.()
  }
}

export function inspectLocalFolder(path: string): { path: string; name: string; files: number } {
  const value = path.trim()
  if (!value) {
    throw new Error('Choose a folder on this device.')
  }
  const bookmark = getSettings().folderBookmarks?.[value]
  let stop: (() => void) | undefined
  if (bookmark && process.platform === 'darwin') {
    try {
      stop = app.startAccessingSecurityScopedResource(bookmark) as () => void
    } catch {
      stop = undefined
    }
  }
  try {
    let stats
    try {
      stats = statSync(value)
    } catch {
      throw new Error('That folder does not exist.')
    }
    if (!stats.isDirectory()) {
      throw new Error('Choose a folder, not a file.')
    }
    return {
      path: value,
      name: basename(value),
      files: countFiles(value)
    }
  } finally {
    stop?.()
  }
}

function countFiles(root: string): number {
  const stack = [root]
  let files = 0
  const started = Date.now()

  while (stack.length) {
    if (files >= 8000 || Date.now() - started > 2500) {
      return files
    }
    const current = stack.pop()
    if (!current) continue
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') {
        if (entry.isDirectory() && SKIP.has(entry.name)) continue
        if (entry.isDirectory() && entry.name !== '.github' && entry.name !== '.cursor') continue
      }
      if (SKIP.has(entry.name)) continue
      const next = join(current, entry.name)
      if (entry.isDirectory()) stack.push(next)
      else if (entry.isFile()) files += 1
    }
  }

  return files
}
