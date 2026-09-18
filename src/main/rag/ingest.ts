import { createHash, randomUUID } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { extname, join, relative } from 'path'
import { getPool, vectorEnabled } from './db'
import { embedTexts, embeddingModel, embeddingsConfigured, toVectorLiteral, EmbeddingUnavailableError } from './embeddings'
import { ragEvents } from './events'

const SKIP_DIRS = new Set([
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
  'target',
  '__pycache__'
])

const SKIP_FILES = /\.(lock|map|min\.js|png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp4|mov|dmg)$/i
const SECRET_FILES = /^(\.env|\.env\..+|credentials.*|secrets.*)$/i
const SECRET_EXT = /\.(pem|key|p12|pfx)$/i
const MAX_FILES = 2500
const MAX_BYTES = 200_000
const CHUNK_LINES = 48
const CHUNK_OVERLAP = 8
const EMBED_BATCH = 48
const EMBED_CONCURRENCY = 3
const SECRET_PATTERNS = [
  /(api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[^\s"']{12,}/gi,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+ PRIVATE KEY-----/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /mongodb(?:\+srv)?:\/\/[^\s"']+/gi,
  /postgres(?:ql)?:\/\/[^\s"']+/gi
]

export type IndexResult = {
  files: number
  chunks: number
  reused: number
  skipped: string[]
}

export async function indexDirectory(projectId: string, root: string): Promise<IndexResult> {
  const collected = collectFiles(root)
  const pool = getPool()
  const model = embeddingsConfigured() ? embeddingModel().id : 'none'
  const runId = randomUUID()
  await pool.query(
    `INSERT INTO rag_index_runs (id, project_id, embedding_model, files_seen) VALUES ($1, $2, $3, $4)`,
    [runId, projectId, model, collected.files.length]
  )

  const existing = await pool.query<{ id: string; path: string; content_hash: string }>(
    `SELECT id, path, content_hash FROM rag_documents WHERE project_id = $1`,
    [projectId]
  )
  const byPath = new Map(existing.rows.map((row) => [row.path, row]))
  const seenPaths = new Set<string>()
  const pendingEmbed: Array<{ id: string; content: string }> = []

  let files = 0
  let chunks = 0
  let reused = 0

  const emit = (status: 'indexing' | 'ready' | 'failed', error?: string): void => {
    ragEvents.progress({
      projectId,
      status,
      filesSeen: files,
      filesTotal: collected.files.length,
      chunksWritten: chunks,
      error
    })
  }
  emit('indexing')

  for (const file of collected.files) {
    const body = readText(file.absolute)
    if (body == null) {
      continue
    }
    const hash = createHash('sha256').update(body).digest('hex')
    seenPaths.add(file.path)
    const prior = byPath.get(file.path)
    if (prior && prior.content_hash === hash) {
      const count = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM rag_chunks WHERE document_id = $1`,
        [prior.id]
      )
      reused += 1
      files += 1
      chunks += Number(count.rows[0]?.count || 0)
      emit('indexing')
      continue
    }

    if (prior) {
      await pool.query(`DELETE FROM rag_documents WHERE id = $1`, [prior.id])
    }

    const documentId = randomUUID()
    await pool.query(
      `INSERT INTO rag_documents (id, project_id, path, language, content_hash, byte_size, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [documentId, projectId, file.path, languageFrom(file.path), hash, Buffer.byteLength(body)]
    )
    const pieces = chunkText(body)
    for (const piece of pieces) {
      const chunkId = randomUUID()
      await pool.query(
        `INSERT INTO rag_chunks (id, document_id, project_id, chunk_index, start_line, end_line, symbol, content)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          chunkId,
          documentId,
          projectId,
          piece.index,
          piece.start,
          piece.end,
          piece.symbol,
          piece.content
        ]
      )
      pendingEmbed.push({ id: chunkId, content: piece.content })
      chunks += 1
    }
    files += 1
    if (files % 8 === 0 || files === collected.files.length) emit('indexing')
  }

  for (const row of existing.rows) {
    if (!seenPaths.has(row.path)) {
      await pool.query(`DELETE FROM rag_documents WHERE id = $1`, [row.id])
    }
  }

  if (embeddingsConfigured() && pendingEmbed.length) {
    try {
      const batches: Array<Array<{ id: string; content: string }>> = []
      for (let i = 0; i < pendingEmbed.length; i += EMBED_BATCH) {
        batches.push(pendingEmbed.slice(i, i + EMBED_BATCH))
      }
      for (let i = 0; i < batches.length; i += EMBED_CONCURRENCY) {
        const wave = batches.slice(i, i + EMBED_CONCURRENCY)
        await Promise.all(
          wave.map(async (batch) => {
            const vectors = await embedTexts(batch.map((item) => item.content.slice(0, 8000)))
            for (let j = 0; j < batch.length; j += 1) {
              const vector = vectors[j]
              if (!vector) continue
              if (vectorEnabled()) {
                await pool.query(`UPDATE rag_chunks SET embedding = $2::vector WHERE id = $1`, [
                  batch[j].id,
                  toVectorLiteral(vector)
                ])
              } else {
                await pool.query(`UPDATE rag_chunks SET embedding = $2::jsonb WHERE id = $1`, [
                  batch[j].id,
                  JSON.stringify(vector)
                ])
              }
            }
          })
        )
        emit('indexing')
      }
    } catch (error) {
      // Payment / gateway failure: keep chunks so keyword search still works.
      if (error instanceof EmbeddingUnavailableError) {
        emit('indexing')
      } else {
        throw error
      }
    }
  }

  await pool.query(
    `UPDATE rag_index_runs SET files_seen = $2, chunks_written = $3, finished_at = now() WHERE id = $1`,
    [runId, files, chunks]
  )
  emit('ready')
  return { files, chunks, reused, skipped: collected.skipped }
}

export function collectFiles(root: string): {
  files: Array<{ path: string; absolute: string }>
  skipped: string[]
} {
  const stack = [root]
  const files: Array<{ path: string; absolute: string }> = []
  const skipped: string[] = []
  const started = Date.now()
  const ignore = readIgnoreFile(root)

  while (stack.length && files.length < MAX_FILES && Date.now() - started < 45_000) {
    const current = stack.pop()
    if (!current) continue
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || SECRET_FILES.test(entry.name) || SECRET_EXT.test(entry.name)) {
        skipped.push(entry.name)
        continue
      }
      if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.cursor') {
        skipped.push(entry.name)
        continue
      }
      const absolute = join(current, entry.name)
      const relativePath = relative(root, absolute).replaceAll('\\', '/')
      if (ignore.some((pattern) => matchesIgnore(pattern, relativePath, entry.isDirectory()))) {
        skipped.push(relativePath)
        continue
      }
      if (entry.isDirectory()) {
        stack.push(absolute)
        continue
      }
      if (!entry.isFile() || SKIP_FILES.test(entry.name)) {
        skipped.push(relativePath)
        continue
      }
      files.push({ path: relativePath, absolute })
    }
  }
  return { files, skipped: [...new Set(skipped)].slice(0, 40) }
}

export function redactSecrets(content: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => {
    return current.replace(pattern, (match) => {
      if (match.includes('://')) return '[REDACTED_CONNECTION]'
      if (match.startsWith('-----BEGIN')) return '[REDACTED_PRIVATE_KEY]'
      const key = match.split(/[:=]/, 1)[0]
      return `${key}=[REDACTED]`
    })
  }, content)
}

export function chunkText(
  content: string
): Array<{ index: number; start: number; end: number; symbol: string | null; content: string }> {
  const lines = content.split(/\r?\n/)
  const symbols = lines.map(symbolFromLine)
  const chunks: Array<{
    index: number
    start: number
    end: number
    symbol: string | null
    content: string
  }> = []
  for (let start = 0; start < lines.length; ) {
    let end = Math.min(lines.length, start + CHUNK_LINES)
    for (let i = Math.min(end - 1, lines.length - 1); i > start + Math.floor(CHUNK_LINES * 0.55); i -= 1) {
      if (symbols[i] && i > start) {
        end = i
        break
      }
    }
    const piece = lines.slice(start, end).join('\n').trimEnd()
    if (piece.trim()) {
      chunks.push({
        index: chunks.length,
        start: start + 1,
        end,
        symbol: nearestSymbol(symbols, start, end),
        content: piece.slice(0, 12_000)
      })
    }
    if (end >= lines.length) break
    start = Math.max(start + 1, end - CHUNK_OVERLAP)
    if (start >= end) start = end
  }
  return chunks
}

function readText(path: string): string | undefined {
  try {
    const stats = statSync(path)
    if (stats.size > MAX_BYTES) return undefined
    const buffer = readFileSync(path)
    if (buffer.includes(0)) return undefined
    return redactSecrets(buffer.toString('utf8'))
  } catch {
    return undefined
  }
}

function readIgnoreFile(root: string): string[] {
  const path = join(root, '.gitignore')
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  } catch {
    return []
  }
}

function matchesIgnore(pattern: string, path: string, directory: boolean): boolean {
  const normalized = pattern.replace(/^\//, '').replace(/\/$/, '')
  if (normalized.includes('*')) {
    const re = new RegExp(
      `^${normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`
    )
    return re.test(path) || re.test(path.split('/').at(-1) || path)
  }
  if (normalized.includes('/')) {
    return path === normalized || path.startsWith(`${normalized}/`)
  }
  const name = path.split('/').at(-1) || path
  return name === normalized || (directory && path.split('/').includes(normalized))
}

function nearestSymbol(symbols: Array<string | null>, start: number, end: number): string | null {
  for (let i = start; i < end; i += 1) {
    if (symbols[i]) return symbols[i]
  }
  for (let i = start - 1; i >= 0; i -= 1) {
    if (symbols[i]) return symbols[i]
  }
  return null
}

function symbolFromLine(line: string): string | null {
  const trimmed = line.trim()
  const match =
    trimmed.match(
      /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/
    ) ||
    trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/) ||
    trimmed.match(/^(?:pub\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_][\w]*)/) ||
    trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][\w]*)/) ||
    trimmed.match(/^class\s+([A-Za-z_][\w]*)/) ||
    trimmed.match(/^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)/) ||
    trimmed.match(
      /^(?:public|private|protected|internal|static|final|override|async|export)\s+.*?\b([A-Za-z_$][\w$]*)\s*\(/
    )
  return match?.[1] || null
}

function languageFrom(path: string): string {
  return extname(path).replace('.', '').toLowerCase() || 'text'
}
