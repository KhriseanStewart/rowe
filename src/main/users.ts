import { randomUUID } from 'crypto'
import { getPool, migrateRag } from './rag/db'
import { updateSettings, type LocalPlan } from './settings'

let activeUserId: string | undefined
let usersMigrated = false

export type DbUser = {
  id: string
  email?: string
  name?: string
  photo?: string
  firstSeenAt: string
  lastActiveAt: string
  sessionCount: number
  githubLogin?: string
  cursorConnected: boolean
  platform?: string
  tokensSaved: number
}

export type DbUserProfile = {
  username: string
  roles: string[]
  company?: string
  industry?: string
  experience?: string
  goals?: string
  preferredStyle?: string
  timezone?: string
  tokensSaved?: number
}

export type DbUserPlan = {
  planId: 'free' | 'pro'
  planName: string
  priceUsd: number
  openRouterBudgetUsd: number
  status: 'active'
  selectedAt?: string
  usage: {
    periodKey: string
    openRouterSpendUsd: number
    promptTokens: number
    completionTokens: number
    askCount: number
  }
}

export type DbUsageLog = {
  id: string
  at?: string
  source: string
  openRouterSpendUsd: number
  promptTokens: number
  completionTokens: number
  askCount: number
}

export type PresenceStats = {
  activeLast5m: number
  activeLast24h: number
  users: number
}

export function getActiveUserId(): string | undefined {
  return activeUserId
}

export function requireActiveUserId(): string {
  if (!activeUserId) {
    throw new Error('Sign in to continue.')
  }
  return activeUserId
}

/** Prefer signed-in Firebase uid for RAG tenancy; fall back to legacy 'rowe'. */
export function ragOwnerId(): string {
  return activeUserId || 'rowe'
}

export async function migrateUsers(): Promise<void> {
  if (usersMigrated) return
  await migrateRag()
  const db = getPool()

  await db.query(`
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
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

INSERT INTO users (id, email, name, session_count)
VALUES ('public', NULL, 'Rowe Public', 0)
ON CONFLICT (id) DO NOTHING;
`)

  await db.query(`ALTER TABLE rag_projects DROP CONSTRAINT IF EXISTS rag_projects_source_type_check`)
  await db.query(`
    ALTER TABLE rag_projects
      ADD CONSTRAINT rag_projects_source_type_check
      CHECK (source_type IN ('github', 'local', 'yellow_pages'))
  `)
  await db.query(`ALTER TABLE rag_projects ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'`)

  await db.query(`
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
`)

  usersMigrated = true
}

export async function setAuthSession(input: {
  uid: string
  email?: string | null
  name?: string | null
  photo?: string | null
}): Promise<DbUser> {
  await migrateUsers()
  activeUserId = input.uid
  const db = getPool()
  const result = await db.query<{
    id: string
    email: string | null
    name: string | null
    photo: string | null
    first_seen_at: Date
    last_active_at: Date
    session_count: number
    github_login: string | null
    cursor_connected: boolean
    platform: string | null
    tokens_saved: number
  }>(
    `INSERT INTO users (id, email, name, photo, first_seen_at, last_active_at, session_count, updated_at)
     VALUES ($1, $2, $3, $4, now(), now(), 1, now())
     ON CONFLICT (id) DO UPDATE SET
       email = COALESCE(EXCLUDED.email, users.email),
       name = COALESCE(EXCLUDED.name, users.name),
       photo = COALESCE(EXCLUDED.photo, users.photo),
       last_active_at = now(),
       session_count = users.session_count + 1,
       updated_at = now()
     RETURNING *`,
    [input.uid, input.email ?? null, input.name ?? null, input.photo ?? null]
  )
  await refreshPresenceStats()
  // Adopt legacy single-device RAG library into this signed-in user.
  await getPool().query(`UPDATE rag_projects SET owner_id = $1 WHERE owner_id = 'rowe'`, [input.uid])
  return mapUser(result.rows[0])
}

export function clearAuthSession(): void {
  activeUserId = undefined
}

export async function trackPresence(input: {
  github?: string | null
  cursor?: boolean
  platform?: string | null
}): Promise<void> {
  const uid = requireActiveUserId()
  await migrateUsers()
  await getPool().query(
    `UPDATE users
        SET last_active_at = now(),
            updated_at = now(),
            github_login = COALESCE($2, github_login),
            cursor_connected = COALESCE($3, cursor_connected),
            platform = COALESCE($4, platform)
      WHERE id = $1`,
    [uid, input.github ?? null, input.cursor ?? null, input.platform ?? null]
  )
  await refreshPresenceStats()
}

export async function getUserProfile(userId = requireActiveUserId()): Promise<DbUserProfile | null> {
  await migrateUsers()
  const result = await getPool().query<{
    username: string
    roles: string[]
    company: string | null
    industry: string | null
    experience: string | null
    goals: string | null
    preferred_style: string | null
    timezone: string | null
    tokens_saved: number
  }>(
    `SELECT p.username, p.roles, p.company, p.industry, p.experience, p.goals,
            p.preferred_style, p.timezone, u.tokens_saved
       FROM user_profiles p
       JOIN users u ON u.id = p.user_id
      WHERE p.user_id = $1`,
    [userId]
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    username: row.username,
    roles: row.roles || [],
    company: row.company || undefined,
    industry: row.industry || undefined,
    experience: row.experience || undefined,
    goals: row.goals || undefined,
    preferredStyle: row.preferred_style || undefined,
    timezone: row.timezone || undefined,
    tokensSaved: row.tokens_saved
  }
}

export async function saveUserProfile(profile: DbUserProfile): Promise<DbUserProfile> {
  const uid = requireActiveUserId()
  await migrateUsers()
  const normalized = {
    username: profile.username.trim().slice(0, 60),
    roles: profile.roles.slice(0, 2),
    company: profile.company?.trim().slice(0, 120) || null,
    industry: profile.industry?.trim().slice(0, 120) || null,
    experience: profile.experience?.trim().slice(0, 500) || null,
    goals: profile.goals?.trim().slice(0, 500) || null,
    preferredStyle: profile.preferredStyle?.trim().slice(0, 300) || null,
    timezone:
      profile.timezone?.trim().slice(0, 80) ||
      Intl.DateTimeFormat().resolvedOptions().timeZone
  }
  await getPool().query(
    `INSERT INTO user_profiles (
       user_id, username, roles, company, industry, experience, goals, preferred_style, timezone, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (user_id) DO UPDATE SET
       username = EXCLUDED.username,
       roles = EXCLUDED.roles,
       company = EXCLUDED.company,
       industry = EXCLUDED.industry,
       experience = EXCLUDED.experience,
       goals = EXCLUDED.goals,
       preferred_style = EXCLUDED.preferred_style,
       timezone = EXCLUDED.timezone,
       updated_at = now()`,
    [
      uid,
      normalized.username,
      normalized.roles,
      normalized.company,
      normalized.industry,
      normalized.experience,
      normalized.goals,
      normalized.preferredStyle,
      normalized.timezone
    ]
  )
  updateSettings({
    userProfileContext: formatProfileContext({
      username: normalized.username,
      roles: normalized.roles,
      company: normalized.company || undefined,
      industry: normalized.industry || undefined,
      experience: normalized.experience || undefined,
      goals: normalized.goals || undefined,
      preferredStyle: normalized.preferredStyle || undefined,
      timezone: normalized.timezone || undefined
    })
  })
  return (await getUserProfile(uid))!
}

export async function syncTokensSaved(localTokensSaved: number): Promise<number> {
  const uid = requireActiveUserId()
  await migrateUsers()
  const local = Math.max(0, Math.floor(localTokensSaved || 0))
  const result = await getPool().query<{ tokens_saved: number }>(
    `UPDATE users
        SET tokens_saved = GREATEST(tokens_saved, $2),
            tokens_saved_updated_at = now(),
            updated_at = now()
      WHERE id = $1
      RETURNING tokens_saved`,
    [uid, local]
  )
  return Number(result.rows[0]?.tokens_saved ?? local)
}

export async function getUserPlan(userId = requireActiveUserId()): Promise<DbUserPlan | null> {
  await migrateUsers()
  const result = await getPool().query<{
    plan_id: 'free' | 'pro'
    plan_name: string
    price_usd: string
    openrouter_budget_usd: string
    status: 'active'
    selected_at: Date | null
    period_key: string
    openrouter_spend_usd: string
    prompt_tokens: string
    completion_tokens: string
    ask_count: number
  }>(`SELECT * FROM user_plans WHERE user_id = $1`, [userId])
  const row = result.rows[0]
  if (!row) return null
  const periodKey = currentPeriodKey()
  const usage =
    row.period_key === periodKey
      ? {
          periodKey: row.period_key,
          openRouterSpendUsd: Number(row.openrouter_spend_usd) || 0,
          promptTokens: Number(row.prompt_tokens) || 0,
          completionTokens: Number(row.completion_tokens) || 0,
          askCount: Number(row.ask_count) || 0
        }
      : emptyUsage(periodKey)
  return {
    planId: row.plan_id,
    planName: row.plan_name,
    priceUsd: Number(row.price_usd) || 0,
    openRouterBudgetUsd: Number(row.openrouter_budget_usd) || 9,
    status: 'active',
    selectedAt: row.selected_at?.toISOString(),
    usage
  }
}

export async function saveUserPlan(planId: 'free' | 'pro'): Promise<DbUserPlan> {
  const uid = requireActiveUserId()
  await migrateUsers()
  const definition = planDefinition(planId)
  const existing = await getUserPlan(uid)
  const usage =
    existing?.usage.periodKey === currentPeriodKey() ? existing.usage : emptyUsage()
  const selectedAt = new Date().toISOString()
  await getPool().query(
    `INSERT INTO user_plans (
       user_id, plan_id, plan_name, price_usd, openrouter_budget_usd, status,
       selected_at, period_key, openrouter_spend_usd, prompt_tokens, completion_tokens, ask_count, updated_at
     ) VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (user_id) DO UPDATE SET
       plan_id = EXCLUDED.plan_id,
       plan_name = EXCLUDED.plan_name,
       price_usd = EXCLUDED.price_usd,
       openrouter_budget_usd = EXCLUDED.openrouter_budget_usd,
       status = 'active',
       selected_at = EXCLUDED.selected_at,
       period_key = EXCLUDED.period_key,
       openrouter_spend_usd = EXCLUDED.openrouter_spend_usd,
       prompt_tokens = EXCLUDED.prompt_tokens,
       completion_tokens = EXCLUDED.completion_tokens,
       ask_count = EXCLUDED.ask_count,
       updated_at = now()`,
    [
      uid,
      definition.id,
      definition.name,
      definition.priceUsd,
      definition.openRouterBudgetUsd,
      selectedAt,
      usage.periodKey,
      usage.openRouterSpendUsd,
      usage.promptTokens,
      usage.completionTokens,
      usage.askCount
    ]
  )
  mirrorLocalPlan({
    planId: definition.id,
    planName: definition.name,
    priceUsd: definition.priceUsd,
    openRouterBudgetUsd: definition.openRouterBudgetUsd,
    status: 'active',
    openRouterSpendUsd: usage.openRouterSpendUsd,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    askCount: usage.askCount,
    periodKey: usage.periodKey
  })
  return (await getUserPlan(uid))!
}

export async function syncUsageFromLocal(entry: {
  openRouterSpendUsd?: number
  promptTokens?: number
  completionTokens?: number
  askCount?: number
  source?: string
}): Promise<DbUserPlan | null> {
  const uid = getActiveUserId()
  if (!uid) return null
  await migrateUsers()
  const plan = await getUserPlan(uid)
  if (!plan) return null

  // Prefer absolute totals already recorded in local settings by main ask path.
  const { getSettings } = await import('./settings')
  const local = getSettings().plan
  const periodKey = currentPeriodKey()
  const usage =
    local && local.periodKey === periodKey
      ? {
          periodKey,
          openRouterSpendUsd: local.openRouterSpendUsd,
          promptTokens: local.promptTokens,
          completionTokens: local.completionTokens,
          askCount: local.askCount
        }
      : {
          ...plan.usage,
          periodKey,
          openRouterSpendUsd:
            (plan.usage.periodKey === periodKey ? plan.usage.openRouterSpendUsd : 0) +
            Math.max(0, entry.openRouterSpendUsd ?? 0),
          promptTokens:
            (plan.usage.periodKey === periodKey ? plan.usage.promptTokens : 0) +
            Math.max(0, Math.floor(entry.promptTokens ?? 0)),
          completionTokens:
            (plan.usage.periodKey === periodKey ? plan.usage.completionTokens : 0) +
            Math.max(0, Math.floor(entry.completionTokens ?? 0)),
          askCount:
            (plan.usage.periodKey === periodKey ? plan.usage.askCount : 0) +
            Math.max(0, Math.floor(entry.askCount ?? 0))
        }

  await getPool().query(
    `UPDATE user_plans SET
       period_key = $2,
       openrouter_spend_usd = $3,
       prompt_tokens = $4,
       completion_tokens = $5,
       ask_count = $6,
       updated_at = now()
     WHERE user_id = $1`,
    [
      uid,
      usage.periodKey,
      usage.openRouterSpendUsd,
      usage.promptTokens,
      usage.completionTokens,
      usage.askCount
    ]
  )

  const spend = Math.max(0, entry.openRouterSpendUsd ?? 0)
  const promptTokens = Math.max(0, Math.floor(entry.promptTokens ?? 0))
  const completionTokens = Math.max(0, Math.floor(entry.completionTokens ?? 0))
  const askCount = Math.max(0, Math.floor(entry.askCount ?? 0))
  if (spend || promptTokens || completionTokens || askCount) {
    await getPool().query(
      `INSERT INTO usage_logs (
         id, user_id, source, period_key, openrouter_spend_usd, prompt_tokens, completion_tokens, ask_count,
         total_openrouter_spend_usd, total_prompt_tokens, total_completion_tokens, total_ask_count
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        randomUUID(),
        uid,
        entry.source ?? 'app',
        usage.periodKey,
        spend,
        promptTokens,
        completionTokens,
        askCount,
        usage.openRouterSpendUsd,
        usage.promptTokens,
        usage.completionTokens,
        usage.askCount
      ]
    )
  }

  mirrorLocalPlan({
    planId: plan.planId,
    planName: plan.planName,
    priceUsd: plan.priceUsd,
    openRouterBudgetUsd: plan.openRouterBudgetUsd,
    status: 'active',
    openRouterSpendUsd: usage.openRouterSpendUsd,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    askCount: usage.askCount,
    periodKey: usage.periodKey
  })

  return { ...plan, usage }
}

export async function listUsageLogs(limitCount = 20): Promise<DbUsageLog[]> {
  const uid = requireActiveUserId()
  await migrateUsers()
  const result = await getPool().query<{
    id: string
    at: Date
    source: string
    openrouter_spend_usd: string
    prompt_tokens: number
    completion_tokens: number
    ask_count: number
  }>(
    `SELECT id, at, source, openrouter_spend_usd, prompt_tokens, completion_tokens, ask_count
       FROM usage_logs
      WHERE user_id = $1
      ORDER BY at DESC
      LIMIT $2`,
    [uid, Math.min(100, Math.max(1, limitCount))]
  )
  return result.rows.map((row) => ({
    id: row.id,
    at: row.at.toISOString(),
    source: row.source,
    openRouterSpendUsd: Number(row.openrouter_spend_usd) || 0,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    askCount: row.ask_count
  }))
}

export async function trackEvent(
  name: string,
  payload?: Record<string, string | boolean>
): Promise<void> {
  const uid = requireActiveUserId()
  await migrateUsers()
  await getPool().query(
    `INSERT INTO user_events (id, user_id, name, payload) VALUES ($1, $2, $3, $4::jsonb)`,
    [randomUUID(), uid, name, JSON.stringify(payload ?? {})]
  )
}

export async function readPresenceStats(): Promise<PresenceStats> {
  await migrateUsers()
  await refreshPresenceStats()
  const result = await getPool().query<{
    active_last_5m: number
    active_last_24h: number
    users: number
  }>(`SELECT active_last_5m, active_last_24h, users FROM presence_stats WHERE id = 'global'`)
  const row = result.rows[0]
  return {
    activeLast5m: row?.active_last_5m ?? 0,
    activeLast24h: row?.active_last_24h ?? 0,
    users: row?.users ?? 0
  }
}

async function refreshPresenceStats(): Promise<void> {
  const db = getPool()
  await db.query(`
    UPDATE presence_stats SET
      active_last_5m = (SELECT COUNT(*) FROM users WHERE last_active_at >= now() - interval '5 minutes'),
      active_last_24h = (SELECT COUNT(*) FROM users WHERE last_active_at >= now() - interval '24 hours'),
      users = (SELECT COUNT(*) FROM users),
      updated_at = now()
    WHERE id = 'global'
  `)
}

function mirrorLocalPlan(plan: LocalPlan): void {
  updateSettings({ plan })
}

function planDefinition(planId: 'free' | 'pro'): {
  id: 'free' | 'pro'
  name: string
  priceUsd: number
  openRouterBudgetUsd: number
} {
  if (planId === 'pro') {
    return { id: 'pro', name: 'Pro', priceUsd: 10, openRouterBudgetUsd: 9 }
  }
  return { id: 'free', name: 'Free', priceUsd: 0, openRouterBudgetUsd: 9 }
}

function currentPeriodKey(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function emptyUsage(periodKey = currentPeriodKey()): DbUserPlan['usage'] {
  return {
    periodKey,
    openRouterSpendUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    askCount: 0
  }
}

function formatProfileContext(profile: DbUserProfile): string {
  return [
    `Username: ${profile.username}`,
    `Roles: ${profile.roles.slice(0, 2).join(', ')}`,
    profile.company && `Company: ${profile.company}`,
    profile.industry && `Industry: ${profile.industry}`,
    profile.experience && `Experience: ${profile.experience}`,
    profile.goals && `Goals: ${profile.goals}`,
    profile.preferredStyle && `Preferred response style: ${profile.preferredStyle}`,
    profile.timezone && `Timezone: ${profile.timezone}`
  ]
    .filter(Boolean)
    .join('\n')
}

function mapUser(row: {
  id: string
  email: string | null
  name: string | null
  photo: string | null
  first_seen_at: Date
  last_active_at: Date
  session_count: number
  github_login: string | null
  cursor_connected: boolean
  platform: string | null
  tokens_saved: number
}): DbUser {
  return {
    id: row.id,
    email: row.email || undefined,
    name: row.name || undefined,
    photo: row.photo || undefined,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastActiveAt: row.last_active_at.toISOString(),
    sessionCount: row.session_count,
    githubLogin: row.github_login || undefined,
    cursorConnected: row.cursor_connected,
    platform: row.platform || undefined,
    tokensSaved: row.tokens_saved
  }
}
