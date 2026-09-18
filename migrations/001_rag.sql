CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS rag_projects (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  name text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('github', 'local')),
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
  embedding vector(1536),
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

ALTER TABLE rag_projects ADD COLUMN IF NOT EXISTS chunks integer NOT NULL DEFAULT 0;
ALTER TABLE rag_chunks DROP COLUMN IF EXISTS embedding;
ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'rag_chunks_embedding_idx'
  ) THEN
    CREATE INDEX rag_chunks_embedding_idx ON rag_chunks
      USING hnsw (embedding vector_cosine_ops);
  END IF;
EXCEPTION
  WHEN others THEN
    NULL;
END $$;
