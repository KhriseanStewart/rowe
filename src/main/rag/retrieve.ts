import { getPool, migrateRag, vectorEnabled } from './db'
import { embedQuery, toVectorLiteral } from './embeddings'
import { ragOwnerId } from '../users'

export type RetrievedChunk = {
  id: string
  projectId: string
  projectName: string
  path: string
  language: string | null
  symbol: string | null
  startLine: number | null
  endLine: number | null
  content: string
  score: number
}

type HitRow = RetrievedChunk & {
  documentId: string
  chunkIndex: number
}

const STOPWORDS = new Set([
  'a', 'about', 'across', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'can', 'code', 'codebase',
  'contents', 'correctly', 'do', 'does', 'file', 'files', 'for', 'from', 'function', 'how', 'i',
  'in', 'inside', 'into', 'is', 'it', 'line', 'lines', 'me', 'my', 'of', 'on', 'or', 'please',
  'project', 'projects', 'repo', 'repos', 'repository', 'setup', 'show', 'the', 'their', 'these',
  'this', 'those', 'to', 'what', 'whats', 'which', 'with', 'you', 'why', 'using', 'source', 'sources'
])

const NOISE_PATH =
  /(^|\/)(linux|windows|macos|ios|android|windows\/runner|linux\/flutter)\/|\.(lock|map|pbxproj|xcconfig|cmake|gradle)$/i

const LANGUAGE_HINTS: Array<{ re: RegExp; langs: string[]; exts: string[] }> = [
  { re: /\bpython\b|\.py\b|\bpip\b|\bdjango\b|\bflask\b|\bfastapi\b/i, langs: ['py'], exts: ['.py'] },
  {
    re: /\btypescript\b|\.tsx?\b|\bnode\.?js\b|\breact\b|\bexpress\b/i,
    langs: ['ts', 'tsx', 'js', 'jsx'],
    exts: ['.ts', '.tsx', '.js', '.jsx']
  },
  { re: /\bjavascript\b|\.jsx?\b/i, langs: ['js', 'jsx', 'mjs', 'cjs'], exts: ['.js', '.jsx', '.mjs', '.cjs'] },
  { re: /\bdart\b|\bflutter\b|\.dart\b/i, langs: ['dart'], exts: ['.dart'] },
  { re: /\bgo\b|\bgolang\b|\.go\b/i, langs: ['go'], exts: ['.go'] },
  { re: /\brust\b|\.rs\b/i, langs: ['rs'], exts: ['.rs'] }
]

const OVERVIEW =
  /\b(what('?s| is)? (in|inside)|contents|overview|summar(y|ize)|list (the )?(files|repos|projects)|what does .{0,40} (do|contain))\b/i
const PATH_RE =
  /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|cpp|cc|h|hpp|css|scss|json|md|sql|yml|yaml|toml|vue|svelte|dart)/g
const LINE_RE = /\b(?:line|lines|l)\s*[:#]?\s*(\d+)(?:\s*[-–]\s*(\d+))?\b|:(\d+)(?:-(\d+))?\b/gi
const IDENT_RE =
  /\b[A-Z][A-Za-z0-9]{2,}\b|\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b|\b[a-z][a-z0-9_]{3,}\b/g

export async function projectCatalog(projectIds: string[], ownerId = ragOwnerId()): Promise<string> {
  await migrateRag()
  const result = await getPool().query<{
    name: string
    source_type: string
    files: number
    path: string
  }>(
    `SELECT p.name, p.source_type, p.files, d.path
       FROM rag_projects p
       LEFT JOIN rag_documents d ON d.project_id = p.id
      WHERE (p.owner_id = $1 OR p.owner_id = 'public') AND p.selected = true AND p.id = ANY($2::uuid[])
      ORDER BY p.name, d.path`,
    [ownerId, projectIds]
  )
  const projects = new Map<string, { source: string; files: number; paths: string[] }>()
  for (const row of result.rows) {
    const current = projects.get(row.name) ?? { source: row.source_type, files: row.files, paths: [] }
    if (row.path) current.paths.push(row.path)
    projects.set(row.name, current)
  }
  return [...projects.entries()]
    .map(([name, project]) => {
      const tree = project.paths.slice(0, 80).join('\n')
      const extra = project.paths.length > 80 ? `\n… ${project.paths.length - 80} more files` : ''
      return `Project ${name} (${project.source}, ${project.files} indexed files):\n${tree}${extra}`
    })
    .join('\n\n')
}

/** First-pass brief: folder trees + package/manifest snippets from selected projects. */
export async function projectReferenceBrief(
  projectIds: string[],
  ownerId = ragOwnerId()
): Promise<string> {
  if (!projectIds.length) return ''
  const catalog = await projectCatalog(projectIds, ownerId)
  const manifests = await getPool().query<{
    projectName: string
    path: string
    content: string
  }>(
    `SELECT p.name AS "projectName", d.path, c.content
       FROM rag_chunks c
       JOIN rag_documents d ON d.id = c.document_id
       JOIN rag_projects p ON p.id = c.project_id
      WHERE (p.owner_id = $1 OR p.owner_id = 'public') AND p.selected = true AND c.project_id = ANY($2::uuid[])
        AND c.chunk_index = 0
        AND d.path ~* '(^|/)(package\\.json|package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock|requirements\\.txt|pyproject\\.toml|Cargo\\.toml|go\\.mod|composer\\.json|Gemfile|Podfile|pubspec\\.yaml)$'
      ORDER BY p.name, d.path
      LIMIT 24`,
    [ownerId, projectIds]
  )
  const packageBlock = manifests.rows
    .map((row) => {
      const body = row.content.trim().slice(0, 1800)
      return `<manifest project="${row.projectName}" path="${row.path}">\n${body}\n</manifest>`
    })
    .join('\n\n')

  return [
    catalog ? `Folder / filing structure from the user's reference projects:\n${catalog}` : '',
    packageBlock
      ? `Packages and lockfiles the user has used before:\n${packageBlock}`
      : ''
  ]
    .filter(Boolean)
    .join('\n\n')
}

export async function searchRag(input: {
  question: string
  projectIds: string[]
  ownerId?: string
  limit?: number
}): Promise<RetrievedChunk[]> {
  await migrateRag()
  if (!input.question.trim() || !input.projectIds.length) {
    return []
  }

  const ownerId = input.ownerId || ragOwnerId()
  const limit = Math.min(input.limit || 12, 20)
  const names = await projectNames(input.projectIds)
  const hints = parseQuestion(input.question, names)
  const lexical = await keywordSearch(input.projectIds, ownerId, hints, 40)
  const byPath = hints.paths.length
    ? await pathSearch(input.projectIds, ownerId, hints.paths, hints.lineStart, hints.lineEnd, 20)
    : []
  const vector = await vectorSearch(input.question, input.projectIds, ownerId, 40)
  const fused = reciprocalRankFusion([lexical, byPath, vector], 60)
  const expanded = await expandNeighbors(
    fused.filter((hit) => Number(hit.score) >= 0.4).slice(0, 6),
    ownerId,
    input.projectIds
  )
  const ranked = diversifyByProject(
    rerank([...fused, ...expanded], hints).filter((hit) => isUsefulHit(hit, hints)),
    limit
  )

  if (OVERVIEW.test(input.question)) {
    const overview = await overviewSearch(input.projectIds, ownerId, limit)
    return decorate(dedupeHits([...ranked, ...overview]).slice(0, limit))
  }

  return decorate(dedupeHits(ranked).slice(0, limit))
}

function parseQuestion(
  question: string,
  projectNames: string[]
): {
  keywords: string[]
  paths: string[]
  symbols: string[]
  languages: string[]
  mentionedProjects: string[]
  lineStart: number | null
  lineEnd: number | null
} {
  const paths = [...question.matchAll(PATH_RE)].map((match) => match[0])
  let lineStart: number | null = null
  let lineEnd: number | null = null
  for (const match of question.matchAll(LINE_RE)) {
    lineStart = Number(match[1] || match[3])
    lineEnd = match[2] || match[4] ? Number(match[2] || match[4]) : lineStart
  }

  const lower = question.toLowerCase()
  const mentionedProjects = projectNames.filter((name) => {
    const needle = name.toLowerCase()
    return lower.includes(needle) || lower.includes(needle.replace(/[-_]/g, ' '))
  })
  // Only boost project-name tokens when the user actually named that project.
  const extra = mentionedProjects.flatMap((name) =>
    name
      .split(/[-_/\s]+/g)
      .map((part) => part.toLowerCase())
      .filter((part) => part.length >= 4)
  )

  const tokens = `${question} ${extra.join(' ')}`
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token) && !/^\d+$/.test(token))
    .flatMap(expandStem)
  const symbols = [...question.matchAll(IDENT_RE)]
    .map((match) => match[0])
    .filter((token) => !STOPWORDS.has(token.toLowerCase()))
  const languages = LANGUAGE_HINTS.filter((hint) => hint.re.test(question)).flatMap((hint) => hint.langs)

  return {
    keywords: [...new Set(tokens)].slice(0, 20),
    paths: [...new Set(paths)].slice(0, 12),
    symbols: [...new Set(symbols)].slice(0, 12),
    languages: [...new Set(languages)],
    mentionedProjects,
    lineStart,
    lineEnd
  }
}

async function projectNames(projectIds: string[]): Promise<string[]> {
  const result = await getPool().query<{ name: string }>(
    `SELECT name FROM rag_projects WHERE id = ANY($1::uuid[])`,
    [projectIds]
  )
  return result.rows.map((row) => row.name)
}

function expandStem(token: string): string[] {
  const variants = [token]
  if (token.endsWith('ies') && token.length > 5) variants.push(`${token.slice(0, -3)}y`)
  else if (token.endsWith('ing') && token.length > 5) variants.push(token.slice(0, -3))
  else if (token.endsWith('ers') && token.length > 5) variants.push(token.slice(0, -1), token.slice(0, -3))
  else if (token.endsWith('es') && token.length > 4) variants.push(token.slice(0, -2), token.slice(0, -1))
  else if (token.endsWith('s') && token.length > 3 && !token.endsWith('ss')) variants.push(token.slice(0, -1))
  return variants
}

async function keywordSearch(
  projectIds: string[],
  ownerId: string,
  hints: ReturnType<typeof parseQuestion>,
  limit: number
): Promise<HitRow[]> {
  const tsquery = hints.keywords.map(escapeTs).filter(Boolean).join(' | ')
  if (!tsquery && !hints.paths.length && !hints.symbols.length) return []
  const like = [...hints.keywords, ...hints.symbols, ...hints.paths.map(fileName)].map(
    (word) => `%${word}%`
  )
  const pathLike = hints.paths.map((path) => `%${path}%`)
  const result = await getPool().query<HitRow>(
    `SELECT c.id, c.document_id AS "documentId", c.chunk_index AS "chunkIndex",
            c.project_id AS "projectId", p.name AS "projectName", d.path, d.language,
            c.symbol, c.start_line AS "startLine", c.end_line AS "endLine", c.content,
            (
              CASE WHEN $1 <> '' AND c.content_tsv @@ to_tsquery('simple', $1)
                   THEN ts_rank_cd(c.content_tsv, to_tsquery('simple', $1)) * 2 ELSE 0 END
              + CASE WHEN d.path ILIKE ANY($5::text[]) THEN 1.6 ELSE 0 END
              + CASE WHEN cardinality($6::text[]) > 0 AND d.path ILIKE ANY($6::text[]) THEN 2.4 ELSE 0 END
              + CASE WHEN cardinality($7::text[]) > 0 AND c.symbol ILIKE ANY($7::text[]) THEN 2.2 ELSE 0 END
              + CASE WHEN c.content ILIKE ANY($5::text[]) THEN 0.4 ELSE 0 END
              + CASE WHEN $8::int IS NOT NULL AND c.start_line <= $9 AND c.end_line >= $8 THEN 3 ELSE 0 END
            ) AS score
       FROM rag_chunks c
       JOIN rag_documents d ON d.id = c.document_id
       JOIN rag_projects p ON p.id = c.project_id
      WHERE (p.owner_id = $2 OR p.owner_id = 'public') AND p.selected = true AND c.project_id = ANY($3::uuid[])
        AND d.path !~* '(^|/)(package-lock\\.json|.+\\.lock)$'
        AND (
          ($1 <> '' AND c.content_tsv @@ to_tsquery('simple', $1))
          OR d.path ILIKE ANY($5::text[])
          OR (cardinality($6::text[]) > 0 AND d.path ILIKE ANY($6::text[]))
          OR (cardinality($7::text[]) > 0 AND c.symbol ILIKE ANY($7::text[]))
          OR c.content ILIKE ANY($5::text[])
        )
      ORDER BY score DESC, c.chunk_index, c.id
      LIMIT $4`,
    [
      tsquery,
      ownerId,
      projectIds,
      limit,
      like.length ? like : ['%___none___%'],
      pathLike,
      hints.symbols,
      hints.lineStart,
      hints.lineEnd ?? hints.lineStart
    ]
  )
  return result.rows
}

async function vectorSearch(
  question: string,
  projectIds: string[],
  ownerId: string,
  limit: number
): Promise<HitRow[]> {
  if (!vectorEnabled()) return []
  let query: number[] | null = null
  try {
    query = await embedQuery(question)
  } catch {
    return []
  }
  if (!query?.length) return []

  const result = await getPool().query<HitRow>(
    `SELECT c.id, c.document_id AS "documentId", c.chunk_index AS "chunkIndex",
            c.project_id AS "projectId", p.name AS "projectName", d.path, d.language,
            c.symbol, c.start_line AS "startLine", c.end_line AS "endLine", c.content,
            (1 - (c.embedding <=> $1::vector)) AS score
       FROM rag_chunks c
       JOIN rag_documents d ON d.id = c.document_id
       JOIN rag_projects p ON p.id = c.project_id
      WHERE (p.owner_id = $2 OR p.owner_id = 'public') AND p.selected = true AND c.project_id = ANY($3::uuid[])
        AND c.embedding IS NOT NULL
        AND d.path !~* '(^|/)(package-lock\\.json|.+\\.lock)$'
      ORDER BY c.embedding <=> $1::vector
      LIMIT $4`,
    [toVectorLiteral(query), ownerId, projectIds, limit]
  )
  return result.rows
}

async function pathSearch(
  projectIds: string[],
  ownerId: string,
  paths: string[],
  lineStart: number | null,
  lineEnd: number | null,
  limit: number
): Promise<HitRow[]> {
  const result = await getPool().query<HitRow>(
    `SELECT c.id, c.document_id AS "documentId", c.chunk_index AS "chunkIndex",
            c.project_id AS "projectId", p.name AS "projectName", d.path, d.language,
            c.symbol, c.start_line AS "startLine", c.end_line AS "endLine", c.content,
            CASE WHEN $4::int IS NOT NULL AND c.start_line <= $5 AND c.end_line >= $4 THEN 4 ELSE 1.8 END AS score
       FROM rag_chunks c
       JOIN rag_documents d ON d.id = c.document_id
       JOIN rag_projects p ON p.id = c.project_id
      WHERE (p.owner_id = $1 OR p.owner_id = 'public') AND p.selected = true AND c.project_id = ANY($2::uuid[])
        AND (d.path ILIKE ANY($3::text[]) OR d.path ILIKE ANY($6::text[]))
        AND ($4::int IS NULL OR (c.start_line <= $5 AND c.end_line >= $4))
      ORDER BY score DESC, c.chunk_index
      LIMIT $7`,
    [
      ownerId,
      projectIds,
      paths.map((path) => `%${path}%`),
      lineStart,
      lineEnd ?? lineStart,
      paths.map((path) => `%${fileName(path)}%`),
      limit
    ]
  )
  return result.rows
}

export function reciprocalRankFusion(lists: HitRow[][], k = 60): HitRow[] {
  const scores = new Map<string, { hit: HitRow; score: number }>()
  for (const list of lists) {
    list.forEach((hit, index) => {
      const add = 1 / (k + index + 1)
      const current = scores.get(hit.id)
      if (current) {
        current.score += add
        current.hit.score = Math.max(Number(current.hit.score) || 0, Number(hit.score) || 0)
      } else {
        scores.set(hit.id, { hit: { ...hit, score: Number(hit.score) || 0 }, score: add })
      }
    })
  }
  return [...scores.values()]
    .map(({ hit, score }) => ({ ...hit, score: score + (Number(hit.score) || 0) * 0.05 }))
    .sort((a, b) => b.score - a.score)
}

function rerank(hits: HitRow[], hints: ReturnType<typeof parseQuestion>): HitRow[] {
  return hits
    .map((hit) => {
      let score = Number(hit.score) || 0
      if (NOISE_PATH.test(hit.path)) score -= 2.5
      if (hints.paths.some((path) => hit.path.endsWith(path) || hit.path.includes(path))) score += 2
      if (hints.symbols.some((symbol) => hit.symbol === symbol || hit.content.includes(symbol))) {
        score += 1.5
      }
      if (
        hints.lineStart != null &&
        hit.startLine != null &&
        hit.endLine != null &&
        hit.startLine <= (hints.lineEnd ?? hints.lineStart) &&
        hit.endLine >= hints.lineStart
      ) {
        score += 2.5
      }
      if (hints.languages.length) {
        const lang = (hit.language || extOf(hit.path)).toLowerCase()
        if (hints.languages.includes(lang)) score += 2.8
        else score -= 1.8
      }
      if (
        hints.mentionedProjects.length &&
        hints.mentionedProjects.some((name) => name === hit.projectName)
      ) {
        score += 2
      }
      return { ...hit, score }
    })
    .sort((a, b) => b.score - a.score)
}

function isUsefulHit(hit: HitRow, hints: ReturnType<typeof parseQuestion>): boolean {
  if (hit.id.startsWith('tree:')) return true
  if (NOISE_PATH.test(hit.path)) return false
  const score = Number(hit.score) || 0
  if (score < 0.55) return false
  if (hints.languages.length) {
    const lang = (hit.language || extOf(hit.path)).toLowerCase()
    // Keep a mismatch only if it is an unusually strong hit.
    if (!hints.languages.includes(lang) && score < 2.2) return false
  }
  return true
}

function diversifyByProject(hits: HitRow[], limit: number): HitRow[] {
  const perProject = new Map<string, number>()
  const result: HitRow[] = []
  for (const hit of hits) {
    const used = perProject.get(hit.projectId) || 0
    if (used >= 4) continue
    perProject.set(hit.projectId, used + 1)
    result.push(hit)
    if (result.length >= limit) break
  }
  return result
}

function extOf(path: string): string {
  const name = path.split('/').pop() || path
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

async function expandNeighbors(
  hits: HitRow[],
  ownerId: string,
  projectIds: string[]
): Promise<HitRow[]> {
  if (!hits.length) return []
  const keys = hits.slice(0, 10).map((hit) => ({
    documentId: hit.documentId,
    from: Math.max(0, hit.chunkIndex - 1),
    to: hit.chunkIndex + 1
  }))
  const neighbors = await getPool().query<HitRow>(
    `SELECT c.id, c.document_id AS "documentId", c.chunk_index AS "chunkIndex",
            c.project_id AS "projectId", p.name AS "projectName", d.path, d.language,
            c.symbol, c.start_line AS "startLine", c.end_line AS "endLine", c.content,
            0.35 AS score
       FROM rag_chunks c
       JOIN rag_documents d ON d.id = c.document_id
       JOIN rag_projects p ON p.id = c.project_id
      WHERE (p.owner_id = $1 OR p.owner_id = 'public') AND p.selected = true AND c.project_id = ANY($2::uuid[])
        AND (${keys
          .map(
            (_, index) =>
              `(c.document_id = $${index * 3 + 3}::uuid AND c.chunk_index BETWEEN $${index * 3 + 4} AND $${index * 3 + 5})`
          )
          .join(' OR ')})`,
    [ownerId, projectIds, ...keys.flatMap((key) => [key.documentId, key.from, key.to])]
  )
  return dedupeHits([...hits, ...neighbors.rows])
}

async function overviewSearch(
  projectIds: string[],
  ownerId: string,
  limit: number
): Promise<HitRow[]> {
  const files = await getPool().query<{ id: string; name: string; path: string }>(
    `SELECT p.id, p.name, d.path
       FROM rag_documents d
       JOIN rag_projects p ON p.id = d.project_id
      WHERE (p.owner_id = $1 OR p.owner_id = 'public') AND p.selected = true AND p.id = ANY($2::uuid[])
      ORDER BY p.name, d.path`,
    [ownerId, projectIds]
  )
  const trees = new Map<string, { name: string; paths: string[] }>()
  for (const row of files.rows) {
    const current = trees.get(row.id) ?? { name: row.name, paths: [] }
    current.paths.push(row.path)
    trees.set(row.id, current)
  }

  const listing: HitRow[] = [...trees.entries()].map(([projectId, project]) => ({
    id: `tree:${projectId}`,
    documentId: projectId,
    chunkIndex: 0,
    projectId,
    projectName: project.name,
    path: 'FILES.md',
    language: 'md',
    symbol: null,
    startLine: 1,
    endLine: project.paths.length,
    content: `${project.name} files:\n${project.paths
      .map((path, index) => `${String(index + 1).padStart(4, ' ')}| ${path}`)
      .join('\n')}`,
    score: 0.8
  }))

  const readme = await getPool().query<HitRow>(
    `SELECT c.id, c.document_id AS "documentId", c.chunk_index AS "chunkIndex",
            c.project_id AS "projectId", p.name AS "projectName", d.path, d.language,
            c.symbol, c.start_line AS "startLine", c.end_line AS "endLine", c.content,
            1.2 AS score
       FROM rag_chunks c
       JOIN rag_documents d ON d.id = c.document_id
       JOIN rag_projects p ON p.id = c.project_id
      WHERE (p.owner_id = $1 OR p.owner_id = 'public') AND p.selected = true AND c.project_id = ANY($2::uuid[])
        AND (
          d.path ~* '(^|/)readme(\\.(md|txt|rst))?$'
          OR d.path ~* '(^|/)package\\.json$'
        )
        AND c.chunk_index = 0
      ORDER BY p.name, d.path`,
    [ownerId, projectIds]
  )

  return [...readme.rows, ...listing].slice(0, limit)
}

function decorate(chunks: HitRow[]): RetrievedChunk[] {
  return chunks.map((chunk) => ({
    id: chunk.id,
    projectId: chunk.projectId,
    projectName: chunk.projectName,
    path: chunk.path,
    language: chunk.language,
    symbol: chunk.symbol,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: withLineNumbers(chunk.content, chunk.startLine ?? 1),
    score: Number(chunk.score) || 0
  }))
}

function withLineNumbers(content: string, startLine: number): string {
  if (/^\s*\d+\| /.test(content)) return content
  return content
    .split('\n')
    .map((line, index) => `${String(startLine + index).padStart(4, ' ')}| ${line}`)
    .join('\n')
}

function dedupeHits(chunks: HitRow[]): HitRow[] {
  const seen = new Set<string>()
  const result: HitRow[] = []
  for (const chunk of chunks) {
    const key = chunk.id.startsWith('tree:')
      ? chunk.id
      : `${chunk.projectId}:${chunk.path}:${chunk.startLine}:${chunk.endLine}`
    if (seen.has(key) || seen.has(chunk.id)) continue
    seen.add(key)
    seen.add(chunk.id)
    result.push(chunk)
  }
  return result
}

function fileName(path: string): string {
  return path.split('/').pop() || path
}

function escapeTs(token: string): string {
  return token.replace(/[^a-z0-9_]/g, '')
}
