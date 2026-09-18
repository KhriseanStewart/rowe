import { useEffect, useState } from 'react'
import type { User } from 'firebase/auth'
import RoweMark from './RoweMark'
import {
  formatUsd,
  getUserPlan,
  listUsageLogs,
  SELECTABLE_PLANS,
  remainingBudgetUsd,
  saveUserPlan,
  type PlanId,
  type UserPlan,
  type UsageLogEntry
} from '../auth/plan'

type SettingsPanelProps = {
  user: User | null
  onClose: () => void
}

export default function SettingsPanel({ user, onClose }: SettingsPanelProps): React.JSX.Element {
  const [plan, setPlan] = useState<UserPlan | null>(null)
  const [logs, setLogs] = useState<UsageLogEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) {
      setPlan(null)
      setLogs([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void Promise.all([getUserPlan(user), listUsageLogs(user, 12)])
      .then(([nextPlan, nextLogs]) => {
        if (cancelled) return
        setPlan(nextPlan)
        setLogs(nextLogs)
      })
      .catch(() => {
        if (!cancelled) {
          setPlan(null)
          setLogs([])
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [user])

  const choosePlan = async (planId: PlanId): Promise<void> => {
    if (!user) return
    setBusy(true)
    setError('')
    try {
      const next = await saveUserPlan(user, planId)
      setPlan(next)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update plan')
    } finally {
      setBusy(false)
    }
  }

  const remaining = plan ? remainingBudgetUsd(plan) : 0
  const spent = plan ? Math.max(0, plan.openRouterBudgetUsd - remaining) : 0
  const spendPct = plan ? Math.min(100, (spent / Math.max(plan.openRouterBudgetUsd, 0.01)) * 100) : 0

  return (
    <div className="ui-overlay z-40">
      <div className="ui-card ui-card-wide desktop-settings">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <RoweMark className="size-10 shrink-0" />
            <div className="min-w-0">
              <p className="ui-kicker">Settings</p>
              <h2 className="ui-title">Plan & usage</h2>
              <p className="ui-copy">
                Free includes a $9 monthly AI usage budget while we test Rowe. Paid plans will land
                once billing is ready.
              </p>
            </div>
          </div>
          <button type="button" className="ui-btn ui-btn-ghost shrink-0" onClick={onClose}>
            Done
          </button>
        </div>

        {loading ? (
          <p className="ui-copy">Loading plan…</p>
        ) : (
          <div className="ui-stack">
            <section className="ui-section desktop-settings-block">
              <p className="ui-section-title">Current plan</p>
              {plan ? (
                <>
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <p className="text-[18px] font-bold tracking-tight">{plan.planName}</p>
                      <p className="mt-1 text-[13px] text-agent-text-soft">
                        {plan.priceUsd > 0 ? `${formatUsd(plan.priceUsd)}/mo` : 'Free · testing'}
                      </p>
                    </div>
                    <p className="text-[13px] font-semibold text-agent-text-soft">
                      {plan.usage.askCount} asks
                    </p>
                  </div>
                  <div className="ui-usage-bar" aria-hidden>
                    <span className="ui-usage-bar-fill" style={{ width: `${spendPct}%` }} />
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-[12px]">
                    <div className="rounded-xl bg-agent-fill/70 px-3 py-2">
                      <p className="text-agent-text-soft">Used</p>
                      <p className="pt-1 font-bold">{formatUsd(spent)}</p>
                    </div>
                    <div className="rounded-xl bg-agent-fill/70 px-3 py-2">
                      <p className="text-agent-text-soft">Left</p>
                      <p className="pt-1 font-bold">{formatUsd(remaining)}</p>
                    </div>
                    <div className="rounded-xl bg-agent-fill/70 px-3 py-2">
                      <p className="text-agent-text-soft">Tokens</p>
                      <p className="pt-1 font-bold">
                        {(plan.usage.promptTokens + plan.usage.completionTokens).toLocaleString()}
                      </p>
                    </div>
                  </div>
                </>
              ) : (
                <p className="ui-copy">No plan selected yet. Choose Free below to unlock asks.</p>
              )}
            </section>

            <section className="ui-section">
              <p className="ui-section-title">Available now</p>
              <div className="flex flex-col gap-3">
                {SELECTABLE_PLANS.map((item) => {
                  const active = plan?.planId === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`ui-plan-card ${active ? 'is-active' : ''}`}
                      disabled={busy || active}
                      onClick={() => {
                        void choosePlan(item.id)
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="ui-section-title" style={{ margin: 0 }}>
                            {item.name}
                            {item.testing ? ' · Testing' : ''}
                            {active ? ' · Active' : ''}
                          </p>
                          <p className="ui-copy" style={{ marginTop: 6 }}>
                            {item.blurb}
                          </p>
                        </div>
                        <p className="ui-plan-price">Free</p>
                      </div>
                      <p className="ui-plan-meta">
                        Monthly AI budget · ${item.openRouterBudgetUsd.toFixed(0)}
                      </p>
                    </button>
                  )
                })}
              </div>
            </section>

            <section className="ui-section">
              <p className="ui-section-title">Recent usage</p>
              {logs.length === 0 ? (
                <p className="ui-copy">No asks logged yet.</p>
              ) : (
                <ul className="flex list-none flex-col gap-2 p-0">
                  {logs.map((entry) => (
                    <li
                      key={entry.id}
                      className="rounded-xl border border-agent-stroke/80 bg-agent-fill/40 px-3 py-2 text-[12px]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">{entry.source}</span>
                        <span className="text-agent-text-soft">
                          {entry.at ? new Date(entry.at).toLocaleString() : 'Just now'}
                        </span>
                      </div>
                      <p className="mt-1 text-agent-text-soft">
                        {formatUsd(entry.openRouterSpendUsd)} ·{' '}
                        {(entry.promptTokens + entry.completionTokens).toLocaleString()} tokens ·{' '}
                        {entry.askCount} ask{entry.askCount === 1 ? '' : 's'}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {error ? <p className="ui-error">{error}</p> : null}
          </div>
        )}
      </div>
    </div>
  )
}
