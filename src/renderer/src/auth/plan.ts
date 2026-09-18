import type { User } from 'firebase/auth'

export type PlanId = 'free' | 'pro'

export type PlanDefinition = {
  id: PlanId
  name: string
  priceUsd: number
  openRouterBudgetUsd: number
  blurb: string
  testing?: boolean
}

export type PlanUsage = {
  periodKey: string
  openRouterSpendUsd: number
  promptTokens: number
  completionTokens: number
  askCount: number
}

export type UserPlan = {
  planId: PlanId
  planName: string
  priceUsd: number
  openRouterBudgetUsd: number
  status: 'active'
  selectedAt?: string
  usage: PlanUsage
}

export const PLAN_CATALOG: PlanDefinition[] = [
  {
    id: 'free',
    name: 'Free',
    priceUsd: 0,
    openRouterBudgetUsd: 9,
    blurb: 'Full access while we test Rowe. Includes a $9 monthly AI usage budget.',
    testing: true
  },
  {
    id: 'pro',
    name: 'Pro',
    priceUsd: 10,
    openRouterBudgetUsd: 9,
    blurb: '$10/mo with a $9 monthly AI usage budget.',
    testing: false
  }
]

/** Plans shown in the product UI. Pro stays hidden until billing ships. */
export const SELECTABLE_PLANS: PlanDefinition[] = PLAN_CATALOG.filter((item) => item.id === 'free')

export const PAYWALL_MESSAGE =
  'Choose a Rowe plan to keep using chat, companion, and System AI. Open Settings to continue.'

export const BUDGET_MESSAGE =
  'You’ve used this month’s AI usage budget. Check Settings or try again next month.'

export function currentPeriodKey(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

export function emptyUsage(periodKey = currentPeriodKey()): PlanUsage {
  return {
    periodKey,
    openRouterSpendUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    askCount: 0
  }
}

export function getPlanDefinition(planId: PlanId): PlanDefinition {
  return PLAN_CATALOG.find((item) => item.id === planId) ?? PLAN_CATALOG[0]
}

export async function getUserPlan(_user?: User): Promise<UserPlan | null> {
  return window.api.getUserPlanDb()
}

export async function saveUserPlan(_user: User, planId: PlanId): Promise<UserPlan> {
  const plan = await window.api.saveUserPlanDb(planId)
  await window.api.updatePlan({
    planId: plan.planId,
    planName: plan.planName,
    priceUsd: plan.priceUsd,
    openRouterBudgetUsd: plan.openRouterBudgetUsd,
    status: 'active',
    openRouterSpendUsd: plan.usage.openRouterSpendUsd,
    promptTokens: plan.usage.promptTokens,
    completionTokens: plan.usage.completionTokens,
    askCount: plan.usage.askCount,
    periodKey: plan.usage.periodKey
  })
  return plan
}

export function planAllowsAsk(plan: UserPlan | null): { ok: true } | { ok: false; message: string } {
  if (!plan || plan.status !== 'active') {
    return { ok: false, message: PAYWALL_MESSAGE }
  }
  const usage = plan.usage.periodKey === currentPeriodKey() ? plan.usage : emptyUsage()
  if (usage.openRouterSpendUsd >= plan.openRouterBudgetUsd) {
    return { ok: false, message: BUDGET_MESSAGE }
  }
  return { ok: true }
}

export function remainingBudgetUsd(plan: UserPlan): number {
  const usage = plan.usage.periodKey === currentPeriodKey() ? plan.usage : emptyUsage()
  return Math.max(0, plan.openRouterBudgetUsd - usage.openRouterSpendUsd)
}

export async function recordPlanUsage(
  _user: User,
  delta: {
    openRouterSpendUsd?: number
    promptTokens?: number
    completionTokens?: number
    askCount?: number
    source?: string
  }
): Promise<UserPlan | null> {
  return window.api.syncUserUsage(delta)
}

/**
 * After main already recorded local usage, sync absolute totals to Postgres
 * and append one usage log for this ask (no double-count).
 */
export async function syncUsageAfterAsk(
  _user: User,
  entry: {
    openRouterSpendUsd?: number
    promptTokens?: number
    completionTokens?: number
    askCount?: number
    source?: string
  }
): Promise<UserPlan | null> {
  return window.api.syncUserUsage(entry)
}

export type UsageLogEntry = {
  id: string
  at?: string
  source: string
  openRouterSpendUsd: number
  promptTokens: number
  completionTokens: number
  askCount: number
}

export async function listUsageLogs(_user: User, limitCount = 20): Promise<UsageLogEntry[]> {
  return window.api.listUserUsage(limitCount)
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`
}
