import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export type GithubProfile = {
  login: string
  name?: string
  avatar?: string
}

export type CompanionAi = 'cursor' | 'system'

export type LocalPlan = {
  planId: 'free' | 'pro'
  planName: string
  priceUsd: number
  openRouterBudgetUsd: number
  status: 'active'
  openRouterSpendUsd: number
  promptTokens: number
  completionTokens: number
  askCount: number
  periodKey: string
}

export type AppSettings = {
  trayAsked: boolean
  trayEnabled: boolean
  trayFileAccessGranted?: boolean
  /** Parent folders System AI may scan for local apps (e.g. ~/dev). */
  trayWorkspaceRoots?: string[]
  cursorKey?: string
  githubToken?: string
  github?: GithubProfile
  companionAi?: CompanionAi
  folderBookmarks?: Record<string, string>
  userProfileContext?: string
  plan?: LocalPlan
  /** Active named agent for tray / System AI sessions. */
  activeAgentId?: string
  /** Preferred OpenRouter / System AI chat model id (overrides env when set). */
  openRouterChatModel?: string
  /** Session-style: skip Accept/Decline for FS writes when true (still audited). */
  trustedMode?: boolean
}

let cache: AppSettings | undefined

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function readFile(): Record<string, unknown> {
  const path = settingsPath()
  if (!existsSync(path)) {
    return {}
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

function writeFile(data: Record<string, unknown>): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsPath(), JSON.stringify(data, null, 2))
}

function decodeSecret(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) {
    return undefined
  }
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      return undefined
    }
  }
  return value
}

function encodeSecret(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(value).toString('base64')
  }
  return value
}

export function getSettings(): AppSettings {
  if (cache) {
    return cache
  }

  const raw = readFile()
  cache = {
    trayAsked: Boolean(raw.trayAsked),
    trayEnabled: Boolean(raw.trayEnabled),
    trayFileAccessGranted: Boolean(raw.trayFileAccessGranted),
    trayWorkspaceRoots: Array.isArray(raw.trayWorkspaceRoots)
      ? raw.trayWorkspaceRoots.filter(
          (value): value is string => typeof value === 'string' && Boolean(value.trim())
        )
      : undefined,
    cursorKey: decodeSecret(raw.cursorKey),
    githubToken: decodeSecret(raw.githubToken),
    github:
      raw.github && typeof raw.github === 'object'
        ? (raw.github as GithubProfile)
        : undefined,
    companionAi: raw.companionAi === 'system' || raw.companionAi === 'cursor' ? raw.companionAi : undefined,
    folderBookmarks:
      raw.folderBookmarks && typeof raw.folderBookmarks === 'object'
        ? (raw.folderBookmarks as Record<string, string>)
        : undefined,
    userProfileContext: typeof raw.userProfileContext === 'string' ? raw.userProfileContext : undefined,
    plan: parsePlan(raw.plan),
    activeAgentId: typeof raw.activeAgentId === 'string' ? raw.activeAgentId : undefined,
    openRouterChatModel:
      typeof raw.openRouterChatModel === 'string' && raw.openRouterChatModel.trim()
        ? raw.openRouterChatModel.trim()
        : undefined,
    trustedMode: Boolean(raw.trustedMode)
  }
  return cache
}

function parsePlan(value: unknown): LocalPlan | undefined {
  if (!value || typeof value !== 'object') return undefined
  const data = value as Record<string, unknown>
  if (data.planId !== 'free' && data.planId !== 'pro') return undefined
  if (data.status !== 'active') return undefined
  return {
    planId: data.planId,
    planName: typeof data.planName === 'string' ? data.planName : data.planId === 'pro' ? 'Pro' : 'Free',
    priceUsd: Number(data.priceUsd ?? 0) || 0,
    openRouterBudgetUsd: Number(data.openRouterBudgetUsd ?? 9) || 9,
    status: 'active',
    openRouterSpendUsd: Number(data.openRouterSpendUsd ?? 0) || 0,
    promptTokens: Number(data.promptTokens ?? 0) || 0,
    completionTokens: Number(data.completionTokens ?? 0) || 0,
    askCount: Number(data.askCount ?? 0) || 0,
    periodKey: typeof data.periodKey === 'string' ? data.periodKey : ''
  }
}

export function planAllowsAskLocal(): { ok: true } | { ok: false; message: string } {
  const plan = getSettings().plan
  if (!plan || plan.status !== 'active') {
    return {
      ok: false,
      message:
        'Choose a Rowe plan to keep using chat, companion, and System AI. Open Settings to continue.'
    }
  }
  const periodKey = currentPeriodKey()
  const spend = plan.periodKey === periodKey ? plan.openRouterSpendUsd : 0
  if (spend >= plan.openRouterBudgetUsd) {
    return {
      ok: false,
      message: 'You’ve used this month’s AI usage budget. Check Settings or try again next month.'
    }
  }
  return { ok: true }
}

export function recordLocalPlanUsage(delta: {
  openRouterSpendUsd?: number
  promptTokens?: number
  completionTokens?: number
  askCount?: number
  source?: string
}): LocalPlan | undefined {
  const plan = getSettings().plan
  if (!plan) return undefined
  const periodKey = currentPeriodKey()
  const base =
    plan.periodKey === periodKey
      ? plan
      : {
          ...plan,
          periodKey,
          openRouterSpendUsd: 0,
          promptTokens: 0,
          completionTokens: 0,
          askCount: 0
        }
  const spend = Math.max(0, delta.openRouterSpendUsd ?? 0)
  const promptTokens = Math.max(0, Math.floor(delta.promptTokens ?? 0))
  const completionTokens = Math.max(0, Math.floor(delta.completionTokens ?? 0))
  const askCount = Math.max(0, Math.floor(delta.askCount ?? 0))
  const next: LocalPlan = {
    ...base,
    openRouterSpendUsd: base.openRouterSpendUsd + spend,
    promptTokens: base.promptTokens + promptTokens,
    completionTokens: base.completionTokens + completionTokens,
    askCount: base.askCount + askCount
  }
  updateSettings({ plan: next })
  console.info('[rowe:usage]', {
    source: delta.source ?? 'main',
    spend,
    promptTokens,
    completionTokens,
    askCount,
    totals: {
      openRouterSpendUsd: next.openRouterSpendUsd,
      promptTokens: next.promptTokens,
      completionTokens: next.completionTokens,
      askCount: next.askCount,
      periodKey: next.periodKey
    }
  })
  return next
}

function currentPeriodKey(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  cache = { ...current, ...patch }

  const raw = readFile()
  const next: Record<string, unknown> = {
    ...raw,
    trayAsked: cache.trayAsked,
    trayEnabled: cache.trayEnabled,
    trayFileAccessGranted: cache.trayFileAccessGranted,
    trayWorkspaceRoots: cache.trayWorkspaceRoots,
    github: cache.github,
    companionAi: cache.companionAi,
    folderBookmarks: cache.folderBookmarks,
    userProfileContext: cache.userProfileContext,
    plan: cache.plan,
    activeAgentId: cache.activeAgentId,
    openRouterChatModel: cache.openRouterChatModel,
    trustedMode: cache.trustedMode
  }

  if (cache.cursorKey) {
    next.cursorKey = encodeSecret(cache.cursorKey)
  } else {
    delete next.cursorKey
  }

  if (cache.githubToken) {
    next.githubToken = encodeSecret(cache.githubToken)
  } else {
    delete next.githubToken
  }

  writeFile(next)
  return cache
}
