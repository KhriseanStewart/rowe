-- App users + billing/profile (Firebase Auth uid is the primary key).
-- Firebase remains auth-only; all durable app data lives in Postgres.

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY, -- Firebase Auth uid
  email text,
  name text,
  photo text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  session_count integer NOT NULL DEFAULT 0,
  github_login text,
  cursor_connected boolean NOT NULL DEFAULT false,
  platform text,
  tokens_saved integer NOT NULL DEFAULT 0,
  tokens_saved_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username text NOT NULL,
  roles text[] NOT NULL DEFAULT '{}',
  company text,
  industry text,
  experience text,
  goals text,
  preferred_style text,
  timezone text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_plans (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan_id text NOT NULL CHECK (plan_id IN ('free', 'pro')),
  plan_name text NOT NULL,
  price_usd numeric NOT NULL DEFAULT 0,
  openrouter_budget_usd numeric NOT NULL DEFAULT 9,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active')),
  selected_at timestamptz,
  period_key text NOT NULL,
  openrouter_spend_usd numeric NOT NULL DEFAULT 0,
  prompt_tokens bigint NOT NULL DEFAULT 0,
  completion_tokens bigint NOT NULL DEFAULT 0,
  ask_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'app',
  period_key text NOT NULL,
  openrouter_spend_usd numeric NOT NULL DEFAULT 0,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  ask_count integer NOT NULL DEFAULT 0,
  total_openrouter_spend_usd numeric NOT NULL DEFAULT 0,
  total_prompt_tokens bigint NOT NULL DEFAULT 0,
  total_completion_tokens bigint NOT NULL DEFAULT 0,
  total_ask_count integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS usage_logs_user_at_idx ON usage_logs(user_id, at DESC);

CREATE TABLE IF NOT EXISTS user_events (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_events_user_at_idx ON user_events(user_id, at DESC);

CREATE TABLE IF NOT EXISTS presence_stats (
  id text PRIMARY KEY DEFAULT 'global',
  active_last_5m integer NOT NULL DEFAULT 0,
  active_last_24h integer NOT NULL DEFAULT 0,
  users integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO presence_stats (id) VALUES ('global') ON CONFLICT (id) DO NOTHING;

-- RAG: allow Yellow Pages as a first-class source type (ingest comes later).
ALTER TABLE rag_projects DROP CONSTRAINT IF EXISTS rag_projects_source_type_check;
ALTER TABLE rag_projects
  ADD CONSTRAINT rag_projects_source_type_check
  CHECK (source_type IN ('github', 'local', 'yellow_pages'));

ALTER TABLE rag_projects ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';

-- Stub directory registry for Yellow Pages (filled in a follow-up plan).
CREATE TABLE IF NOT EXISTS yellow_pages_directories (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'indexing', 'ready', 'failed')),
  entry_count integer NOT NULL DEFAULT 0,
  rag_project_id uuid REFERENCES rag_projects(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

CREATE TABLE IF NOT EXISTS yellow_pages_entries (
  id uuid PRIMARY KEY,
  directory_id uuid NOT NULL REFERENCES yellow_pages_directories(id) ON DELETE CASCADE,
  title text NOT NULL,
  category text,
  phone text,
  email text,
  website text,
  address text,
  city text,
  region text,
  country text,
  tags text[] NOT NULL DEFAULT '{}',
  body text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS yellow_pages_entries_directory_idx ON yellow_pages_entries(directory_id);
CREATE INDEX IF NOT EXISTS yellow_pages_entries_category_idx ON yellow_pages_entries(category);
