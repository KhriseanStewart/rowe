/**
 * Public Yellow Pages — shared across all signed-in users (owner_id = 'public').
 * Entries are stored in yellow_pages_* tables and mirrored into rag_projects/chunks + pgvector.
 */
import { createHash, randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { getPool, migrateRag, vectorEnabled } from './db'
import { embedTexts, embeddingModel, embeddingsConfigured, toVectorLiteral } from './embeddings'
import { migrateUsers } from '../users'

export const PUBLIC_OWNER_ID = 'public'
export const PUBLIC_DIRECTORY_NAME = 'Yellow Pages'
export const PUBLIC_PROJECT_REF = 'yellow-pages:public'

export type YellowPagesEntryInput = {
  title: string
  category?: string
  phone?: string
  email?: string
  website?: string
  address?: string
  city?: string
  region?: string
  country?: string
  tags?: string[]
  body?: string
}

export type YellowPagesDirectory = {
  id: string
  name: string
  status: 'pending' | 'indexing' | 'ready' | 'failed'
  entryCount: number
  ragProjectId?: string
  error?: string
  public: boolean
}

export type YellowPagesStatus = {
  ready: boolean
  entryCount: number
  directory?: YellowPagesDirectory
  projectId?: string
}

async function ensurePublicUser(): Promise<void> {
  await getPool().query(
    `INSERT INTO users (id, email, name, session_count)
     VALUES ($1, NULL, 'Rowe Public', 0)
     ON CONFLICT (id) DO NOTHING`,
    [PUBLIC_OWNER_ID]
  )
}

export async function listYellowPagesDirectories(): Promise<YellowPagesDirectory[]> {
  await migrateUsers()
  await ensurePublicUser()
  const result = await getPool().query<{
    id: string
    name: string
    status: YellowPagesDirectory['status']
    entry_count: number
    rag_project_id: string | null
    error: string | null
    owner_id: string
  }>(
    `SELECT id, name, status, entry_count, rag_project_id, error, owner_id
       FROM yellow_pages_directories
      WHERE owner_id = $1
      ORDER BY updated_at DESC`,
    [PUBLIC_OWNER_ID]
  )
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    entryCount: row.entry_count,
    ragProjectId: row.rag_project_id || undefined,
    error: row.error || undefined,
    public: row.owner_id === PUBLIC_OWNER_ID
  }))
}

export async function getYellowPagesStatus(): Promise<YellowPagesStatus> {
  const dirs = await listYellowPagesDirectories()
  const directory = dirs[0]
  return {
    ready: Boolean(directory && directory.status === 'ready' && directory.entryCount > 0),
    entryCount: directory?.entryCount ?? 0,
    directory,
    projectId: directory?.ragProjectId
  }
}

/** Always include the public Yellow Pages RAG project in asks/searches. */
export async function getPublicYellowPagesProjectIds(): Promise<string[]> {
  await migrateRag()
  await migrateUsers()
  await ensurePublicUser()
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM rag_projects
      WHERE owner_id = $1 AND source_type = 'yellow_pages' AND status = 'ready'`,
    [PUBLIC_OWNER_ID]
  )
  return result.rows.map((row) => row.id)
}

export async function seedPublicYellowPages(): Promise<YellowPagesStatus> {
  return importYellowPagesEntries(SAMPLE_JAMAICA_ENTRIES, {
    replace: true,
    label: 'Yellow Pages'
  })
}

/** Seed the public sample if nothing is indexed yet (safe to call on app start). */
export async function ensurePublicYellowPagesSeeded(): Promise<YellowPagesStatus> {
  const status = await getYellowPagesStatus()
  if (status.ready && status.entryCount > 0) {
    return status
  }
  return seedPublicYellowPages()
}

export async function importYellowPagesFile(path: string, replace = true): Promise<YellowPagesStatus> {
  const raw = readFileSync(path, 'utf8')
  const entries = parseYellowPagesPayload(raw, path)
  if (!entries.length) {
    throw new Error('No Yellow Pages entries found in that file.')
  }
  return importYellowPagesEntries(entries, { replace, label: 'Yellow Pages' })
}

export async function importYellowPagesEntries(
  entries: YellowPagesEntryInput[],
  options?: { replace?: boolean; label?: string }
): Promise<YellowPagesStatus> {
  await migrateRag()
  await migrateUsers()
  await ensurePublicUser()
  const pool = getPool()
  const replace = options?.replace !== false
  const label = options?.label || PUBLIC_DIRECTORY_NAME

  let directoryId: string
  let projectId: string
  const existing = await pool.query<{ id: string; rag_project_id: string | null }>(
    `SELECT id, rag_project_id FROM yellow_pages_directories
      WHERE owner_id = $1 AND name = $2
      LIMIT 1`,
    [PUBLIC_OWNER_ID, PUBLIC_DIRECTORY_NAME]
  )

  if (existing.rows[0]) {
    directoryId = existing.rows[0].id
    projectId = existing.rows[0].rag_project_id || randomUUID()
  } else {
    directoryId = randomUUID()
    projectId = randomUUID()
  }

  await pool.query(
    `INSERT INTO rag_projects (
       id, owner_id, name, source_type, source_ref, selected, status, files, chunks, metadata
     ) VALUES ($1, $2, $3, 'yellow_pages', $4, true, 'indexing', 0, 0, $5::jsonb)
     ON CONFLICT (owner_id, source_ref) DO UPDATE SET
       name = EXCLUDED.name,
       status = 'indexing',
       error = NULL,
       updated_at = now()
     RETURNING id`,
    [
      projectId,
      PUBLIC_OWNER_ID,
      label,
      PUBLIC_PROJECT_REF,
      JSON.stringify({ public: true, kind: 'yellow_pages' })
    ]
  )
  const project = await pool.query<{ id: string }>(
    `SELECT id FROM rag_projects WHERE owner_id = $1 AND source_ref = $2`,
    [PUBLIC_OWNER_ID, PUBLIC_PROJECT_REF]
  )
  projectId = project.rows[0]?.id || projectId

  await pool.query(
    `INSERT INTO yellow_pages_directories (
       id, owner_id, name, status, entry_count, rag_project_id, metadata, updated_at
     ) VALUES ($1, $2, $3, 'indexing', 0, $4, $5::jsonb, now())
     ON CONFLICT (owner_id, name) DO UPDATE SET
       status = 'indexing',
       rag_project_id = EXCLUDED.rag_project_id,
       error = NULL,
       updated_at = now()`,
    [directoryId, PUBLIC_OWNER_ID, PUBLIC_DIRECTORY_NAME, projectId, JSON.stringify({ public: true })]
  )
  const dir = await pool.query<{ id: string }>(
    `SELECT id FROM yellow_pages_directories WHERE owner_id = $1 AND name = $2`,
    [PUBLIC_OWNER_ID, PUBLIC_DIRECTORY_NAME]
  )
  directoryId = dir.rows[0]?.id || directoryId

  if (replace) {
    await pool.query(`DELETE FROM yellow_pages_entries WHERE directory_id = $1`, [directoryId])
    await pool.query(`DELETE FROM rag_documents WHERE project_id = $1`, [projectId])
  }

  try {
    const normalized = entries
      .map(normalizeEntry)
      .filter((entry) => entry.title.length > 0)
    if (!normalized.length) {
      throw new Error('No valid Yellow Pages entries to import.')
    }

    const chunkRows: Array<{ id: string; content: string; path: string }> = []
    for (const entry of normalized) {
      const entryId = randomUUID()
      await pool.query(
        `INSERT INTO yellow_pages_entries (
           id, directory_id, title, category, phone, email, website, address, city, region, country, tags, body, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
        [
          entryId,
          directoryId,
          entry.title,
          entry.category || null,
          entry.phone || null,
          entry.email || null,
          entry.website || null,
          entry.address || null,
          entry.city || null,
          entry.region || null,
          entry.country || null,
          entry.tags || [],
          entry.body || null,
          JSON.stringify({ public: true })
        ]
      )
      const content = formatEntryDocument(entry)
      const path = `entries/${slugify(entry.title)}-${entryId.slice(0, 8)}.md`
      const documentId = randomUUID()
      const hash = createHash('sha256').update(content).digest('hex')
      await pool.query(
        `INSERT INTO rag_documents (id, project_id, path, language, content_hash, byte_size, updated_at)
         VALUES ($1, $2, $3, 'md', $4, $5, now())`,
        [documentId, projectId, path, hash, Buffer.byteLength(content)]
      )
      const chunkId = randomUUID()
      await pool.query(
        `INSERT INTO rag_chunks (
           id, document_id, project_id, chunk_index, start_line, end_line, symbol, content
         ) VALUES ($1, $2, $3, 0, 1, $4, $5, $6)`,
        [chunkId, documentId, projectId, content.split('\n').length, entry.title, content]
      )
      chunkRows.push({ id: chunkId, content, path })
    }

    if (embeddingsConfigured() && vectorEnabled()) {
      const model = embeddingModel()
      for (let i = 0; i < chunkRows.length; i += 16) {
        const batch = chunkRows.slice(i, i + 16)
        const vectors = await embedTexts(batch.map((row) => row.content.slice(0, 8000)))
        for (let j = 0; j < batch.length; j += 1) {
          await pool.query(`UPDATE rag_chunks SET embedding = $2::vector WHERE id = $1`, [
            batch[j].id,
            toVectorLiteral(vectors[j])
          ])
        }
        void model
      }
    }

    await pool.query(
      `UPDATE yellow_pages_directories
          SET status = 'ready', entry_count = $2, rag_project_id = $3, error = NULL, updated_at = now()
        WHERE id = $1`,
      [directoryId, normalized.length, projectId]
    )
    await pool.query(
      `UPDATE rag_projects
          SET status = 'ready', files = $2, chunks = $2, error = NULL, updated_at = now()
        WHERE id = $1`,
      [projectId, normalized.length]
    )
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'Yellow Pages import failed'
    await pool.query(
      `UPDATE yellow_pages_directories SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
      [directoryId, message]
    )
    await pool.query(
      `UPDATE rag_projects SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
      [projectId, message]
    )
    throw caught
  }

  return getYellowPagesStatus()
}

export function parseYellowPagesPayload(raw: string, pathHint = 'import.json'): YellowPagesEntryInput[] {
  const trimmed = raw.trim()
  if (!trimmed) return []
  if (pathHint.toLowerCase().endsWith('.csv') || looksLikeCsv(trimmed)) {
    return parseCsv(trimmed)
  }
  const data = JSON.parse(trimmed) as unknown
  if (Array.isArray(data)) {
    return data.map((item) => normalizeEntry(item as YellowPagesEntryInput))
  }
  if (data && typeof data === 'object' && Array.isArray((data as { entries?: unknown }).entries)) {
    return ((data as { entries: YellowPagesEntryInput[] }).entries).map(normalizeEntry)
  }
  throw new Error('Expected a JSON array, { entries: [] }, or CSV of Yellow Pages listings.')
}

function normalizeEntry(input: YellowPagesEntryInput | Record<string, unknown>): YellowPagesEntryInput {
  const row = input as Record<string, unknown>
  const tags = row.tags
  return {
    title: String(row.title ?? row.name ?? row.business ?? '').trim(),
    category: optionalString(row.category ?? row.industry),
    phone: optionalString(row.phone ?? row.tel),
    email: optionalString(row.email),
    website: optionalString(row.website ?? row.url),
    address: optionalString(row.address ?? row.street),
    city: optionalString(row.city),
    region: optionalString(row.region ?? row.parish ?? row.state),
    country: optionalString(row.country) || 'Jamaica',
    tags: Array.isArray(tags)
      ? tags.map((tag) => String(tag)).filter(Boolean)
      : typeof tags === 'string'
        ? tags
            .split(/[|,]/g)
            .map((tag) => tag.trim())
            .filter(Boolean)
        : undefined,
    body: optionalString(row.body ?? row.description ?? row.notes)
  }
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function formatEntryDocument(entry: YellowPagesEntryInput): string {
  return [
    `# ${entry.title}`,
    entry.category ? `Category: ${entry.category}` : '',
    entry.phone ? `Phone: ${entry.phone}` : '',
    entry.email ? `Email: ${entry.email}` : '',
    entry.website ? `Website: ${entry.website}` : '',
    entry.address ? `Address: ${entry.address}` : '',
    [entry.city, entry.region, entry.country].filter(Boolean).length
      ? `Location: ${[entry.city, entry.region, entry.country].filter(Boolean).join(', ')}`
      : '',
    entry.tags?.length ? `Tags: ${entry.tags.join(', ')}` : '',
    entry.body ? `\n${entry.body}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'listing'
  )
}

function looksLikeCsv(text: string): boolean {
  const first = text.split(/\r?\n/)[0] || ''
  return /title|name|business/i.test(first) && first.includes(',')
}

function parseCsv(text: string): YellowPagesEntryInput[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < 2) return []
  const headers = splitCsvLine(lines[0]).map((header) => header.trim().toLowerCase())
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line)
    const row: Record<string, string> = {}
    headers.forEach((header, index) => {
      row[header] = cols[index] || ''
    })
    return normalizeEntry(row)
  })
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (ch === ',' && !inQuotes) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out
}

/** Small labeled sample so the public feature works before a real dump is provided. */
export const SAMPLE_JAMAICA_ENTRIES: YellowPagesEntryInput[] = [
  {
    title: 'Digicel Jamaica',
    category: 'Telecommunications',
    phone: '+1 888-344-4235',
    website: 'https://www.digicelgroup.com/jm',
    address: '14 Ocean Boulevard',
    city: 'Kingston',
    region: 'Kingston',
    country: 'Jamaica',
    tags: ['mobile', 'internet', 'telecom'],
    body: 'Mobile network and broadband provider serving Jamaica.'
  },
  {
    title: 'Flow Jamaica',
    category: 'Telecommunications',
    phone: '+1 888-225-5486',
    website: 'https://discoverflow.co/jamaica',
    city: 'Kingston',
    region: 'Kingston',
    country: 'Jamaica',
    tags: ['cable', 'internet', 'tv'],
    body: 'Cable, internet, and mobile services across Jamaica.'
  },
  {
    title: 'National Commercial Bank (NCB)',
    category: 'Banks',
    phone: '+1 888-622-3477',
    website: 'https://www.jncb.com',
    address: '32 Trafalgar Road',
    city: 'Kingston',
    region: 'Kingston',
    country: 'Jamaica',
    tags: ['bank', 'finance'],
    body: 'Commercial and retail banking services.'
  },
  {
    title: 'Scotiabank Jamaica',
    category: 'Banks',
    phone: '+1 888-467-2684',
    website: 'https://www.scotiabank.com/jm',
    city: 'Kingston',
    region: 'Kingston',
    country: 'Jamaica',
    tags: ['bank', 'finance'],
    body: 'Personal and business banking.'
  },
  {
    title: 'GraceKennedy Limited',
    category: 'Food & Beverage',
    phone: '+1 876-923-6331',
    website: 'https://www.gracekennedy.com',
    address: '73 Harbour Street',
    city: 'Kingston',
    region: 'Kingston',
    country: 'Jamaica',
    tags: ['food', 'retail', 'manufacturing'],
    body: 'Food manufacturing, distribution, and financial services conglomerate.'
  },
  {
    title: 'Island Grill',
    category: 'Restaurants',
    phone: '+1 876-978-2159',
    city: 'Kingston',
    region: 'Kingston',
    country: 'Jamaica',
    tags: ['restaurant', 'jamaican', 'fast-casual'],
    body: 'Jamaican fast-casual restaurant chain.'
  },
  {
    title: 'Devon House',
    category: 'Tourism & Attractions',
    phone: '+1 876-929-6602',
    website: 'https://devonhouseja.com',
    address: '26 Hope Road',
    city: 'Kingston',
    region: 'Kingston',
    country: 'Jamaica',
    tags: ['tourism', 'heritage', 'ice-cream'],
    body: 'Historic mansion, courtyards, and local specialty shops.'
  },
  {
    title: 'Sandals Resorts',
    category: 'Hotels & Resorts',
    website: 'https://www.sandals.com',
    city: 'Montego Bay',
    region: 'St. James',
    country: 'Jamaica',
    tags: ['hotel', 'resort', 'tourism'],
    body: 'All-inclusive resort brand with properties across Jamaica.'
  },
  {
    title: 'Jamaica Tourist Board',
    category: 'Government & Tourism',
    phone: '+1 876-929-9200',
    website: 'https://www.visitjamaica.com',
    city: 'Kingston',
    region: 'Kingston',
    country: 'Jamaica',
    tags: ['tourism', 'government'],
    body: 'Official tourism promotion agency for Jamaica.'
  },
  {
    title: 'Courts Jamaica',
    category: 'Retail',
    phone: '+1 888-268-7871',
    website: 'https://www.courtsjamaica.com',
    city: 'Kingston',
    region: 'Kingston',
    country: 'Jamaica',
    tags: ['furniture', 'appliances', 'retail'],
    body: 'Furniture and appliance retailer with island-wide stores.'
  },
  {
    title: 'PriceSmart Jamaica',
    category: 'Wholesale Clubs',
    website: 'https://www.pricesmart.com',
    city: 'Portmore',
    region: 'St. Catherine',
    country: 'Jamaica',
    tags: ['warehouse', 'membership', 'retail'],
    body: 'Membership warehouse club.'
  },
  {
    title: 'University of the West Indies, Mona',
    category: 'Education',
    phone: '+1 876-927-1660',
    website: 'https://www.mona.uwi.edu',
    city: 'Kingston',
    region: 'Kingston',
    country: 'Jamaica',
    tags: ['university', 'education'],
    body: 'Regional university campus at Mona.'
  }
]
