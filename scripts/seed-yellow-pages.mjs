/**
 * Seed public Yellow Pages into Postgres + pgvector (sample until a full dump is imported).
 * Usage: bun scripts/seed-yellow-pages.mjs
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'
import { createHash, randomUUID } from 'crypto'

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
  // optional .env
}

const url = process.env.RAG_DATABASE_URL || `postgresql://${process.env.USER}@127.0.0.1:5432/rowe`
const pool = new pg.Pool({ connectionString: url })

const SAMPLE = [
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
    tags: ['tourism', 'heritage', 'ice cream'],
    body: 'Historic house, gardens, and ice cream.'
  },
  {
    title: 'University of the West Indies, Mona',
    category: 'Education',
    phone: '+1 876-927-1660',
    website: 'https://www.mona.uwi.edu',
    city: 'Kingston',
    region: 'St. Andrew',
    country: 'Jamaica',
    tags: ['university', 'education'],
    body: 'Public research university campus at Mona.'
  },
  {
    title: 'Kingston Public Hospital',
    category: 'Health',
    phone: '+1 876-922-0210',
    city: 'Kingston',
    region: 'Kingston',
    country: 'Jamaica',
    tags: ['hospital', 'health'],
    body: 'Major public hospital in downtown Kingston.'
  },
  {
    title: 'Jamaica Tourist Board',
    category: 'Tourism & Attractions',
    phone: '+1 888-224-6982',
    website: 'https://www.visitjamaica.com',
    city: 'Kingston',
    region: 'Kingston',
    country: 'Jamaica',
    tags: ['tourism', 'travel'],
    body: 'Official tourism board for Jamaica.'
  }
]

function formatEntry(entry) {
  return [
    `# ${entry.title}`,
    entry.category ? `Category: ${entry.category}` : '',
    entry.phone ? `Phone: ${entry.phone}` : '',
    entry.website ? `Website: ${entry.website}` : '',
    entry.address ? `Address: ${entry.address}` : '',
    `Location: ${[entry.city, entry.region, entry.country].filter(Boolean).join(', ')}`,
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

async function embedTexts(texts) {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) return null
  const model =
    process.env.RAG_EMBEDDING_MODEL ||
    process.env.OPENROUTER_EMBEDDING_MODEL ||
    'openai/text-embedding-3-small'
  const base = (process.env.RAG_OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(
    /\/$/,
    ''
  )
  const response = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, input: texts })
  })
  if (!response.ok) {
    throw new Error(`Embeddings failed: ${response.status} ${await response.text()}`)
  }
  const json = await response.json()
  return json.data.sort((a, b) => a.index - b.index).map((row) => row.embedding)
}

async function main() {
  await pool.query(`INSERT INTO users (id, email, name, session_count)
    VALUES ('public', NULL, 'Rowe Public', 0) ON CONFLICT (id) DO NOTHING`)

  const projectId = randomUUID()
  const directoryId = randomUUID()
  const ref = 'yellow-pages:public'

  await pool.query(
    `INSERT INTO rag_projects (
       id, owner_id, name, source_type, source_ref, selected, status, files, chunks, metadata
     ) VALUES ($1, 'public', 'Yellow Pages', 'yellow_pages', $2, true, 'indexing', 0, 0, '{"public":true}'::jsonb)
     ON CONFLICT (owner_id, source_ref) DO UPDATE SET
       status = 'indexing', error = NULL, updated_at = now()`,
    [projectId, ref]
  )
  const project = await pool.query(`SELECT id FROM rag_projects WHERE owner_id = 'public' AND source_ref = $1`, [
    ref
  ])
  const pid = project.rows[0].id

  await pool.query(
    `INSERT INTO yellow_pages_directories (
       id, owner_id, name, status, entry_count, rag_project_id, metadata, updated_at
     ) VALUES ($1, 'public', 'Yellow Pages', 'indexing', 0, $2, '{"public":true}'::jsonb, now())
     ON CONFLICT (owner_id, name) DO UPDATE SET
       status = 'indexing', rag_project_id = EXCLUDED.rag_project_id, error = NULL, updated_at = now()`,
    [directoryId, pid]
  )
  const dir = await pool.query(
    `SELECT id FROM yellow_pages_directories WHERE owner_id = 'public' AND name = 'Yellow Pages'`
  )
  const did = dir.rows[0].id

  await pool.query(`DELETE FROM yellow_pages_entries WHERE directory_id = $1`, [did])
  await pool.query(`DELETE FROM rag_documents WHERE project_id = $1`, [pid])

  const chunkIds = []
  const contents = []
  for (const entry of SAMPLE) {
    const entryId = randomUUID()
    await pool.query(
      `INSERT INTO yellow_pages_entries (
         id, directory_id, title, category, phone, email, website, address, city, region, country, tags, body, metadata
       ) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11,$12,'{"public":true}'::jsonb)`,
      [
        entryId,
        did,
        entry.title,
        entry.category,
        entry.phone || null,
        entry.website || null,
        entry.address || null,
        entry.city,
        entry.region,
        entry.country,
        entry.tags || [],
        entry.body || null
      ]
    )
    const content = formatEntry(entry)
    const path = `entries/${slugify(entry.title)}-${entryId.slice(0, 8)}.md`
    const documentId = randomUUID()
    const hash = createHash('sha256').update(content).digest('hex')
    await pool.query(
      `INSERT INTO rag_documents (id, project_id, path, language, content_hash, byte_size, updated_at)
       VALUES ($1, $2, $3, 'md', $4, $5, now())`,
      [documentId, pid, path, hash, Buffer.byteLength(content)]
    )
    const chunkId = randomUUID()
    await pool.query(
      `INSERT INTO rag_chunks (id, document_id, project_id, chunk_index, start_line, end_line, symbol, content)
       VALUES ($1, $2, $3, 0, 1, $4, $5, $6)`,
      [chunkId, documentId, pid, content.split('\n').length, entry.title, content]
    )
    chunkIds.push(chunkId)
    contents.push(content)
  }

  let embedded = 0
  try {
    const vectors = await embedTexts(contents.map((c) => c.slice(0, 8000)))
    if (vectors) {
      for (let i = 0; i < chunkIds.length; i += 1) {
        const literal = `[${vectors[i].join(',')}]`
        await pool.query(`UPDATE rag_chunks SET embedding = $2::vector WHERE id = $1`, [
          chunkIds[i],
          literal
        ])
        embedded += 1
      }
    }
  } catch (error) {
    console.warn('Embedding skipped/failed:', error instanceof Error ? error.message : error)
  }

  await pool.query(
    `UPDATE yellow_pages_directories
        SET status = 'ready', entry_count = $2, rag_project_id = $3, error = NULL, updated_at = now()
      WHERE id = $1`,
    [did, SAMPLE.length, pid]
  )
  await pool.query(
    `UPDATE rag_projects SET status = 'ready', files = $2, chunks = $2, error = NULL, updated_at = now()
      WHERE id = $1`,
    [pid, SAMPLE.length]
  )

  console.log(
    JSON.stringify(
      {
        ok: true,
        projectId: pid,
        directoryId: did,
        entries: SAMPLE.length,
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
