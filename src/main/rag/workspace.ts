import { existsSync, readdirSync } from 'fs'
import { basename, join } from 'path'
import { getWorkspaceRoots, withFolderAccess } from '../local-folder'
import { ensureLocalProject, listProjects, type StoredProject } from './projects'
import { extractNameQueries, normalizeName, scoreNameMatch, contextualMatchBoost, isSdkNoisePath } from './workspace-match'

export { extractNameQueries, scoreNameMatch } from './workspace-match'

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
  '__pycache__',
  'Pods',
  '.dart_tool',
  'target'
])

const MARKERS = new Set([
  'package.json',
  'pubspec.yaml',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'composer.json',
  'Gemfile',
  'Podfile',
  'mix.exs',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts'
])

const MAX_DEPTH = 5
const MIN_SCORE = 0.58

export type DiscoveredProject = {
  path: string
  name: string
  root?: string
}

export type ProjectResolveResult = {
  /** Projects to search deeply (local subject first when matched). */
  projectIds: string[]
  /** Matched local/subject codebase for this question. */
  subjectIds: string[]
  /** Selected library projects used only as pattern references. */
  referenceIds: string[]
  note?: string
  matched?: { query: string; name: string; path?: string; score: number }
}

/** Scan granted workspace roots for app/project folders. */
export async function discoverWorkspaceProjects(): Promise<DiscoveredProject[]> {
  const roots = getWorkspaceRoots()
  const found = new Map<string, DiscoveredProject>()
  for (const root of roots) {
    if (!existsSync(root)) continue
    const projects = await withFolderAccess(root, () => scanRoot(root, root))
    for (const project of projects) {
      found.set(project.path, project)
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Same discovery surface as GitHub's listRepos — for the library UI. */
export async function listLocalProjects(): Promise<DiscoveredProject[]> {
  return discoverWorkspaceProjects()
}

export async function resolveProjectsForQuestion(
  question: string,
  selectedIds: string[],
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<ProjectResolveResult> {
  const indexed = await listProjects()
  const disk = await discoverWorkspaceProjects()
  const candidates = buildCandidates(indexed, disk)
  const priorUsers = (history || [])
    .filter((turn) => turn.role === 'user')
    .slice(-2)
    .map((turn) => turn.content)
    .join('\n')
  const searchBlob = priorUsers ? `${priorUsers}\n${question}` : question
  const queries = extractNameQueries(searchBlob)
  const referenceIds = uniqueIds(selectedIds)
  let best: { query: string; candidate: Candidate; score: number } | undefined

  for (const query of queries) {
    for (const candidate of candidates) {
      const base = scoreNameMatch(query, candidate.name)
      if (base < MIN_SCORE) continue
      const score =
        base +
        contextualMatchBoost(searchBlob, candidate.name, Boolean(candidate.path), candidate.path)
      if (!best || score > best.score) {
        best = { query, candidate, score }
      }
    }
  }

  if (!best) {
    return { projectIds: referenceIds, subjectIds: [], referenceIds }
  }

  let projectId = best.candidate.projectId
  if (!projectId && best.candidate.path) {
    const ensured = await ensureLocalProject({
      path: best.candidate.path,
      name: best.candidate.name
    })
    projectId = ensured.id
  }

  if (!projectId) {
    return { projectIds: referenceIds, subjectIds: [], referenceIds }
  }

  const note =
    normalizeName(best.query) === normalizeName(best.candidate.name)
      ? `Using local project "${best.candidate.name}" as the subject codebase.`
      : `Interpreted "${best.query}" as local project "${best.candidate.name}" (closest match under your granted folders).`

  // Subject is searched deeply; selected library stays reference-only unless it is the subject.
  const subjectIds = [projectId]
  const refs = referenceIds.filter((id) => id !== projectId)

  return {
    projectIds: uniqueIds([...subjectIds, ...refs]),
    subjectIds,
    referenceIds: refs,
    note,
    matched: {
      query: best.query,
      name: best.candidate.name,
      path: best.candidate.path,
      score: best.score
    }
  }
}

type Candidate = {
  name: string
  path?: string
  projectId?: string
}

function buildCandidates(indexed: StoredProject[], disk: DiscoveredProject[]): Candidate[] {
  const byKey = new Map<string, Candidate>()
  for (const project of indexed) {
    if (project.source === 'local' && isSdkNoisePath(project.location)) continue
    const key = project.source === 'local' ? project.location : `github:${project.location}`
    byKey.set(key, {
      name: project.name,
      path: project.source === 'local' ? project.location : undefined,
      projectId: project.id
    })
  }
  for (const project of disk) {
    if (isSdkNoisePath(project.path)) continue
    const existing = byKey.get(project.path)
    if (existing) {
      existing.name = existing.name || project.name
      continue
    }
    byKey.set(project.path, { name: project.name, path: project.path })
  }
  return [...byKey.values()]
}

function scanRoot(root: string, workspaceRoot: string): DiscoveredProject[] {
  const found: DiscoveredProject[] = []
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  const started = Date.now()

  while (stack.length) {
    if (found.length >= 400 || Date.now() - started > 4000) break
    const current = stack.pop()
    if (!current) continue
    if (current.depth > MAX_DEPTH) continue
    if (isSdkNoisePath(current.dir)) continue

    if (isProjectDir(current.dir) && !isSdkNoisePath(current.dir)) {
      found.push({
        path: current.dir,
        name: basename(current.dir),
        root: workspaceRoot
      })
    }

    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (SKIP.has(entry.name)) continue
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const next = join(current.dir, entry.name)
      // Do not descend into Flutter SDK checkouts under the workspace root.
      if (isFlutterSdkRoot(next)) continue
      if (isSdkNoisePath(next)) continue
      stack.push({ dir: next, depth: current.depth + 1 })
    }
  }

  return found
}

function isFlutterSdkRoot(dir: string): boolean {
  try {
    const hasBinFlutter =
      existsSync(join(dir, 'bin', 'flutter')) || existsSync(join(dir, 'bin', 'flutter.bat'))
    const hasSdkPubspec = existsSync(join(dir, 'packages', 'flutter', 'pubspec.yaml'))
    return hasBinFlutter && hasSdkPubspec
  } catch {
    return false
  }
}

function isProjectDir(dir: string): boolean {
  try {
    const entries = readdirSync(dir)
    if (entries.some((name) => MARKERS.has(name))) return true
    return entries.some((name) => name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace'))
  } catch {
    return false
  }
}


/** True when the user is asking Rowe to survey/check local folders or projects on disk. */
export function wantsWorkspaceInventory(question: string): boolean {
  const q = question.toLowerCase()
  const action =
    /\b(check|list|scan|search|find|look|show|explore|browse|inventory|survey|what(?:'s|s|\s+is|\s+are))\b/.test(
      q
    )
  const target =
    /\b(folder|folders|project|projects|repo|repos|apps?|director(?:y|ies)|workspace|codebase|local|machine|computer|disk|device|dev)\b/.test(
      q
    )
  const pathish =
    /(?:^|[\s"`'])(?:~\/|\/Users\/|\/home\/|[A-Za-z]:\\|[a-z0-9._-]+\/[a-z0-9._/-]+)/i.test(question)
  const broad =
    /\bmy projects\b|\bprojects on my\b|\bon (?:this|my) (?:machine|computer|device)\b|\bwhat(?:'s|s) on (?:this|my)\b/.test(
      q
    )
  return broad || (action && target) || (action && pathish)
}

/**
 * Scan granted workspace roots and return a compact inventory for the model.
 * Prefer this over asking the user to run ls / Get-ChildItem and paste output.
 */
export async function buildWorkspaceInventoryContext(question: string): Promise<string> {
  const roots = getWorkspaceRoots()
  if (!roots.length) {
    return [
      'Local workspace inventory:',
      '- No folders have been granted yet. Rowe will request folder access through the app; do not ask the user to run shell listing commands.'
    ].join('\n')
  }

  const discovered = await discoverWorkspaceProjects()
  const pathHints = extractPathHints(question)
  let projects = discovered
  if (pathHints.length) {
    const filtered = discovered.filter((project) =>
      pathHints.some((hint) => project.path.toLowerCase().includes(hint) || project.name.toLowerCase().includes(hint))
    )
    if (filtered.length) projects = filtered
  }

  const capped = projects.slice(0, 80)
  const lines = capped.map((project) => {
    const stack = detectStackLabel(project.path)
    const rel =
      project.root && project.path.startsWith(project.root)
        ? project.path.slice(project.root.length).replace(/^[/\\]/, '') || basename(project.path)
        : project.path
    return `- ${project.name} | ${stack} | ${project.path}${rel !== project.path ? ` (under ${project.root})` : ''}`
  })

  return [
    'Local workspace inventory (scanned from folders the user already granted Rowe):',
    `Granted roots: ${roots.join(', ')}`,
    pathHints.length ? `Filtered by path/name hints from the question: ${pathHints.join(', ')}` : '',
    `Found ${discovered.length} project folder(s)${pathHints.length ? ` (${capped.length} matched hints)` : ''}; showing up to ${capped.length}:`,
    ...lines,
    capped.length < discovered.length && !pathHints.length
      ? `…and ${discovered.length - capped.length} more under the granted roots.`
      : '',
    'Use this inventory to answer. Do not ask the user to run ls, Get-ChildItem, or paste directory listings for these folders.'
  ]
    .filter(Boolean)
    .join('\n')
}

function extractPathHints(question: string): string[] {
  const hints = new Set<string>()
  for (const match of question.matchAll(
    /(?:~\/|\/Users\/[^\s"'`]+|\/home\/[^\s"'`]+|[A-Za-z]:\\[^\s"'`]+|[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+)/g
  )) {
    const value = match[0].replace(/^[~\/]+/, '').toLowerCase()
    if (value.length >= 2) hints.add(value)
  }
  // Bare folder tokens that often name a parent (React, node, projects, rowe)
  for (const match of question.matchAll(/\b([A-Za-z][A-Za-z0-9._-]{2,})\b/g)) {
    const token = match[1]
    const lower = token.toLowerCase()
    if (HARD_INVENTORY_STOP.has(lower)) continue
    if (/^(check|list|scan|search|find|look|show|folder|project|projects|apps?|code)$/i.test(token)) continue
    hints.add(lower)
  }
  return [...hints].slice(0, 12)
}

const HARD_INVENTORY_STOP = new Set([
  'the', 'and', 'for', 'from', 'with', 'what', 'which', 'this', 'that', 'your', 'mine',
  'please', 'could', 'would', 'should', 'about', 'into', 'under', 'over', 'here', 'there',
  'local', 'machine', 'computer', 'device', 'disk', 'folder', 'folders', 'directory',
  'directories', 'workspace', 'codebase', 'structure', 'stack', 'stacks', 'known'
])

function detectStackLabel(dir: string): string {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 'unknown'
  }
  const names = new Set(entries)
  if (names.has('pubspec.yaml')) return 'Flutter/Dart'
  if (names.has('composer.json')) return 'PHP'
  if (names.has('Cargo.toml')) return 'Rust'
  if (names.has('go.mod')) return 'Go'
  if (names.has('Gemfile')) return 'Ruby'
  if (names.has('mix.exs')) return 'Elixir'
  if (names.has('pyproject.toml') || names.has('requirements.txt')) return 'Python'
  if (names.has('build.gradle') || names.has('build.gradle.kts')) return 'Android/Gradle'
  if (names.has('package.json')) {
    if (names.has('bun.lock') || names.has('bun.lockb')) return 'Bun'
    if (names.has('pnpm-lock.yaml')) return 'Node (pnpm)'
    if (names.has('yarn.lock')) return 'Node (yarn)'
    if (names.has('package-lock.json')) return 'Node (npm)'
    return 'JavaScript/TypeScript'
  }
  if (entries.some((name) => name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace'))) {
    return 'Apple/Xcode'
  }
  return 'unknown'
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))]
}
