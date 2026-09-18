import { useEffect, useState } from 'react'
import type { User } from 'firebase/auth'
import RoweMark from './RoweMark'
import AuditLogPanel from './AuditLogPanel'
import PermissionExplainer from './PermissionExplainer'
import type { PermissionStatus } from '../lib/toolUi'
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

const FREE_MODEL_PRESETS = [
  { id: 'openai/gpt-oss-20b:free', label: 'GPT-OSS 20B (free)' },
  { id: 'meta-llama/llama-3.2-3b-instruct:free', label: 'Llama 3.2 3B (free)' },
  { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B (free)' },
  { id: 'nvidia/nemotron-3-nano-30b-a3b:free', label: 'Nemotron Nano 30B (free)' },
  { id: 'openrouter/free', label: 'OpenRouter free router (rate-limits hard)' }
] as const

const PAID_MODEL_PRESETS = [
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini' },
  { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
  { id: 'google/gemini-2.0-flash', label: 'Gemini 2.0 Flash' }
] as const

export default function SettingsPanel({ user, onClose }: SettingsPanelProps): React.JSX.Element {
  const [plan, setPlan] = useState<UserPlan | null>(null)
  const [logs, setLogs] = useState<UsageLogEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [chatModel, setChatModel] = useState('')
  const [modelSaved, setModelSaved] = useState(false)
  const [modelBusy, setModelBusy] = useState(false)
  const [trustedMode, setTrustedMode] = useState(false)
  const [trustedBusy, setTrustedBusy] = useState(false)
  const [permStatus, setPermStatus] = useState<PermissionStatus>({
    screenRecording: 'unknown',
    accessibility: 'unknown'
  })

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

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.api.getChatModel().catch(() => null),
      window.api.getTrustedMode().catch(() => false),
      window.api.getPermissionStatus().catch(() => ({
        screenRecording: 'unknown' as const,
        accessibility: 'unknown' as const
      }))
    ]).then(([model, trusted, perms]) => {
      if (cancelled) return
      setChatModel(model || '')
      setTrustedMode(Boolean(trusted))
      setPermStatus(perms)
    })
    return () => {
      cancelled = true
    }
  }, [])

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

  const saveChatModel = async (value?: string): Promise<void> => {
    const next = (value ?? chatModel).trim()
    setModelBusy(true)
    setError('')
    setModelSaved(false)
    try {
      const saved = await window.api.setChatModel(next)
      setChatModel(saved || '')
      setModelSaved(true)
      window.setTimeout(() => setModelSaved(false), 1600)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save model')
    } finally {
      setModelBusy(false)
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
              <p className="ui-section-title">System AI model</p>
              <p className="ui-copy" style={{ marginTop: 0 }}>
                Prefer a pinned free OpenRouter model over the rate-limited openrouter/free router. Leave empty to use env / default.
              </p>
              <label className="mt-3 block text-[12px] font-semibold text-agent-text-soft" htmlFor="chat-model">
                Model id
              </label>
              <div className="mt-1.5 flex flex-wrap gap-2">
                <input
                  id="chat-model"
                  className="ui-input min-w-0 flex-1"
                  value={chatModel}
                  placeholder="e.g. openai/gpt-oss-20b:free"
                  disabled={modelBusy}
                  onChange={(event) => setChatModel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void saveChatModel()
                  }}
                />
                <button
                  type="button"
                  className="ui-btn ui-btn-primary shrink-0"
                  disabled={modelBusy}
                  onClick={() => void saveChatModel()}
                >
                  {modelBusy ? 'Saving…' : modelSaved ? 'Saved' : 'Save'}
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {FREE_MODEL_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`desktop-chip rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                      chatModel === preset.id ? 'is-active' : ''
                    }`}
                    disabled={modelBusy}
                    onClick={() => void saveChatModel(preset.id)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-[11px] font-semibold text-agent-text-soft">With credits</p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {PAID_MODEL_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="desktop-chip rounded-full px-2.5 py-1 text-[11px] font-semibold"
                    disabled={modelBusy}
                    onClick={() => void saveChatModel(preset.id)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="ui-section desktop-settings-block">
              <p className="ui-section-title">Trusted mode</p>
              <p className="ui-copy" style={{ marginTop: 0 }}>
                When on, Rowe can apply file writes under your granted folders without Accept/Decline
                each time. Actions are still logged in Tool audit.
              </p>
              <label className="trusted-toggle">
                <input
                  type="checkbox"
                  checked={trustedMode}
                  disabled={trustedBusy}
                  onChange={(event) => {
                    const next = event.target.checked
                    setTrustedBusy(true)
                    void window.api
                      .setTrustedMode(next)
                      .then((saved) => setTrustedMode(Boolean(saved)))
                      .catch(() => setTrustedMode(!next))
                      .finally(() => setTrustedBusy(false))
                  }}
                />
                <span>Skip write confirms this session</span>
              </label>
            </section>

            <PermissionExplainer
              status={permStatus}
              onOpenSettings={(kind) => {
                void window.api.openPermissionSettings(kind)
              }}
            />

            <AuditLogPanel />

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
