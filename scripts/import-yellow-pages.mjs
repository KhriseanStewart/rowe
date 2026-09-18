/**
 * Import data/yellow-pages-jamaica.csv into the public Yellow Pages RAG tables.
 * Usage: bun scripts/import-yellow-pages.mjs [path-to-csv]
 */
import { createHash, randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = join(root, '.env')
try {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/)
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '')
    }
  }
} catch {
  // optional
}

const csvPath = process.argv[2] || join(root, 'data', 'yellow-pages-jamaica.csv')
const url = process.env.RAG_DATABASE_URL || `postgresql://${process.env.USER}@127.0.0.1:5432/rowe`
const pool = new pg.Pool({ connectionString: url })
const PUBLIC = 'public'
const REF = 'yellow-pages:public'
const DIR_NAME = 'Yellow Pages'

function splitCsvLine(line) {
  const out = []
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

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < 2) return []
  const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase())
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line)
    const row = {}
    headers.forEach((header, index) => {
      row[header] = (cols[index] || '').trim()
    })
    return {
      title: row.title || row.name || row.business || '',
      category: row.category || row.industry || '',
      phone: row.phone || row.tel || '',
      email: row.email || '',
      website: row.website || row.url || '',
      address: row.address || row.street || '',
      city: row.city || '',
      region: row.region || row.parish || row.state || '',
      country: row.country || 'Jamaica',
      tags: (row.tags || '')
        .split(/[|,]/g)
        .map((t) => t.trim())
        .filter(Boolean),
      body: row.body || row.description || row.notes || ''
    }
  }).filter((entry) => entry.title.length > 0)
}

function formatEntry(entry) {
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

function slugify(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'listing'
  )
}

async function embedBatch(texts) {
  const key = process.env.OPENROUTER_API_KEY
  const omniKey = process.env.RAG_OMNIROUTE_API_KEY
  const gateway = (process.env.RAG_AI_GATEWAY || '').toLowerCase()
  const attempts = []
  if (gateway === 'omniroute' && omniKey) {
    attempts.push({
      key: omniKey,
      base: (process.env.RAG_OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128/v1').replace(/\/$/, '')
    })
  }
  if (key) {
    attempts.push({
      key,
      base: (process.env.RAG_OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '')
    })
  }
  if (omniKey && !attempts.some((a) => a.key === omniKey)) {
    attempts.push({
      key: omniKey,
      base: (process.env.RAG_OMNIROUTE_BASE_URL || 'http://127.0.0.1:20128/v1').replace(/\/$/, '')
    })
  }
  if (!attempts.length) return null

  const model =
    process.env.RAG_EMBEDDING_MODEL ||
    process.env.OPENROUTER_EMBEDDING_MODEL ||
    'openai/text-embedding-3-small'

  let lastError
  for (const endpoint of attempts) {
    try {
      const response = await fetch(`${endpoint.base}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${endpoint.key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model, input: texts })
      })
      if (!response.ok) {
        throw new Error(`${response.status} ${await response.text()}`)
      }
      const json = await response.json()
      return json.data.sort((a, b) => a.index - b.index).map((row) => row.embedding)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function main() {
  const raw = readFileSync(csvPath, 'utf8')
  const entries = parseCsv(raw)
  if (!entries.length) {
    throw new Error(`No entries found in ${csvPath}`)
  }
  console.log(`Importing ${entries.length} listings from ${csvPath}`)

  await pool.query(`INSERT INTO users (id, email, name, session_count)
    VALUES ($1, NULL, 'Rowe Public', 0) ON CONFLICT (id) DO NOTHING`, [PUBLIC])

  const projectId = randomUUID()
  const directoryId = randomUUID()

  await pool.query(
    `INSERT INTO rag_projects (
       id, owner_id, name, source_type, source_ref, selected, status, files, chunks, metadata
     ) VALUES ($1, $2, $3, 'yellow_pages', $4, true, 'indexing', 0, 0, $5::jsonb)
     ON CONFLICT (owner_id, source_ref) DO UPDATE SET
       name = EXCLUDED.name,
       status = 'indexing',
       error = NULL,
       updated_at = now()`,
    [projectId, PUBLIC, DIR_NAME, REF, JSON.stringify({ public: true, source: 'openstreetmap' })]
  )
  const project = await pool.query(
    `SELECT id FROM rag_projects WHERE owner_id = $1 AND source_ref = $2`,
    [PUBLIC, REF]
  )
  const pid = project.rows[0].id

  await pool.query(
    `INSERT INTO yellow_pages_directories (
       id, owner_id, name, status, entry_count, rag_project_id, metadata, updated_at
     ) VALUES ($1, $2, $3, 'indexing', 0, $4, $5::jsonb, now())
     ON CONFLICT (owner_id, name) DO UPDATE SET
       status = 'indexing',
       rag_project_id = EXCLUDED.rag_project_id,
       error = NULL,
       updated_at = now()`,
    [directoryId, PUBLIC, DIR_NAME, pid, JSON.stringify({ public: true, source: 'openstreetmap' })]
  )
  const dir = await pool.query(
    `SELECT id FROM yellow_pages_directories WHERE owner_id = $1 AND name = $2`,
    [PUBLIC, DIR_NAME]
  )
  const did = dir.rows[0].id

  await pool.query(`DELETE FROM yellow_pages_entries WHERE directory_id = $1`, [did])
  await pool.query(`DELETE FROM rag_documents WHERE project_id = $1`, [pid])

  const chunkIds = []
  const contents = []
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]
      const entryId = randomUUID()
      await client.query(
        `INSERT INTO yellow_pages_entries (
           id, directory_id, title, category, phone, email, website, address, city, region, country, tags, body, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
        [
          entryId,
          did,
          entry.title,
          entry.category || null,
          entry.phone || null,
          entry.email || null,
          entry.website || null,
          entry.address || null,
          entry.city || null,
          entry.region || null,
          entry.country || 'Jamaica',
          entry.tags || [],
          entry.body || null,
          JSON.stringify({ public: true, source: 'openstreetmap' })
        ]
      )
      const content = formatEntry(entry)
      const path = `entries/${slugify(entry.title)}-${entryId.slice(0, 8)}.md`
      const documentId = randomUUID()
      const hash = createHash('sha256').update(content).digest('hex')
      await client.query(
        `INSERT INTO rag_documents (id, project_id, path, language, content_hash, byte_size, updated_at)
         VALUES ($1, $2, $3, 'md', $4, $5, now())`,
        [documentId, pid, path, hash, Buffer.byteLength(content)]
      )
      const chunkId = randomUUID()
      await client.query(
        `INSERT INTO rag_chunks (id, document_id, project_id, chunk_index, start_line, end_line, symbol, content)
         VALUES ($1, $2, $3, 0, 1, $4, $5, $6)`,
        [chunkId, documentId, pid, content.split('\n').length, entry.title, content]
      )
      chunkIds.push(chunkId)
      contents.push(content)
      if ((i + 1) % 500 === 0) {
        console.log(`  inserted ${i + 1}/${entries.length}`)
      }
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  let embedded = 0
  try {
    for (let i = 0; i < contents.length; i += 16) {
      const batch = contents.slice(i, i + 16).map((c) => c.slice(0, 8000))
      const vectors = await embedBatch(batch)
      if (!vectors) break
      for (let j = 0; j < vectors.length; j += 1) {
        await pool.query(`UPDATE rag_chunks SET embedding = $2::vector WHERE id = $1`, [
          chunkIds[i + j],
          `[${vectors[j].join(',')}]`
        ])
        embedded += 1
      }
      if ((i + 16) % 160 === 0 || i + 16 >= contents.length) {
        console.log(`  embedded ${Math.min(i + 16, contents.length)}/${contents.length}`)
      }
    }
  } catch (error) {
    console.warn('Embedding skipped/failed:', error instanceof Error ? error.message : error)
  }

  await pool.query(
    `UPDATE yellow_pages_directories
        SET status = 'ready', entry_count = $2, rag_project_id = $3, error = NULL, updated_at = now()
      WHERE id = $1`,
    [did, entries.length, pid]
  )
  await pool.query(
    `UPDATE rag_projects SET status = 'ready', files = $2, chunks = $2, error = NULL, updated_at = now()
      WHERE id = $1`,
    [pid, entries.length]
  )

  console.log(
    JSON.stringify(
      {
        ok: true,
        csv: csvPath,
        projectId: pid,
        directoryId: did,
        entries: entries.length,
        embedded
      },
      null,
      2
    )
  )
  await pool.end()
}

main().catch(async (error) => {
  console.error(error)
  await pool.end()
  process.exit(1)
})
