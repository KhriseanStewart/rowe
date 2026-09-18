import { Pool } from 'pg'
import { readFileSync } from 'fs'
import { join } from 'path'

let pool: Pool | undefined
let migrated = false
let hasVector = false

export function ragDatabaseUrl(): string {
  const env = import.meta.env as { RAG_DATABASE_URL?: string }
  return process.env.RAG_DATABASE_URL?.trim() || env.RAG_DATABASE_URL?.trim() || defaultUrl()
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: ragDatabaseUrl(),
      max: 4
    })
  }
  return pool
}

export function vectorEnabled(): boolean {
  return hasVector
}

export async function migrateRag(): Promise<void> {
  if (migrated) {
    return
  }
  const db = getPool()
  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS vector')
    hasVector = true
  } catch {
    hasVector = false
  }

  await db.query(`
CREATE TABLE IF NOT EXISTS rag_projects (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  name text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('github', 'local', 'yellow_pages')),
  source_ref text NOT NULL,
  branch text,
  commit_sha text,
  selected boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'indexing', 'ready', 'failed')),
  files integer NOT NULL DEFAULT 0,
  chunks integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, source_ref)
);

CREATE TABLE IF NOT EXISTS rag_documents (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES rag_projects(id) ON DELETE CASCADE,
  path text NOT NULL,
  language text,
  content_hash text NOT NULL,
  byte_size integer NOT NULL,
  updated_at timestamptz,
  UNIQUE (project_id, path)
);

CREATE TABLE IF NOT EXISTS rag_chunks (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES rag_projects(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  start_line integer,
  end_line integer,
  symbol text,
  content text NOT NULL,
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS rag_chunks_project_idx ON rag_chunks(project_id);
CREATE INDEX IF NOT EXISTS rag_chunks_tsv_idx ON rag_chunks USING gin(content_tsv);

CREATE TABLE IF NOT EXISTS rag_index_runs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES rag_projects(id) ON DELETE CASCADE,
  embedding_model text NOT NULL DEFAULT 'none',
  files_seen integer NOT NULL DEFAULT 0,
  chunks_written integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error text
);
`)

  await db.query(`ALTER TABLE rag_projects ADD COLUMN IF NOT EXISTS chunks integer NOT NULL DEFAULT 0`)
  await db.query(`ALTER TABLE rag_projects DROP CONSTRAINT IF EXISTS rag_projects_source_type_check`)
  await db.query(`
    ALTER TABLE rag_projects
      ADD CONSTRAINT rag_projects_source_type_check
      CHECK (source_type IN ('github', 'local', 'yellow_pages'))
  `)
  await db.query(`ALTER TABLE rag_projects ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'`)

  if (hasVector) {
    await ensureVectorColumn(db)
  } else {
    await db.query(`ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS embedding jsonb`)
  }

  migrated = true
}

async function ensureVectorColumn(db: Pool): Promise<void> {
  const type = await db.query<{ data_type: string; udt_name: string }>(
    `SELECT data_type, udt_name
       FROM information_schema.columns
      WHERE table_name = 'rag_chunks' AND column_name = 'embedding'`
  )
  const row = type.rows[0]
  if (!row) {
    await db.query(`ALTER TABLE rag_chunks ADD COLUMN embedding vector(1536)`)
  } else if (row.udt_name !== 'vector') {
    await db.query(`ALTER TABLE rag_chunks DROP COLUMN embedding`)
    await db.query(`ALTER TABLE rag_chunks ADD COLUMN embedding vector(1536)`)
  }

  try {
    await db.query(`
      CREATE INDEX IF NOT EXISTS rag_chunks_embedding_idx
        ON rag_chunks USING hnsw (embedding vector_cosine_ops)
    `)
  } catch {
    // HNSW needs enough rows / may fail on empty tables in some builds; ignore.
  }
}

export async function closeRag(): Promise<void> {
  if (!pool) {
    return
  }
  await pool.end()
  pool = undefined
  migrated = false
  hasVector = false
}

export function applyMigrationFile(): string {
  return readFileSync(join(process.cwd(), 'migrations/001_rag.sql'), 'utf8')
}

function defaultUrl(): string {
  const user = process.env.USER || 'postgres'
  return `postgresql://${user}@127.0.0.1:5432/rowe`
}
