import { FormEvent, useEffect, useState } from 'react'
import {
  createUserWithEmailAndPassword,
  GithubAuthProvider,
  signInWithCredential,
  signInWithEmailAndPassword,
  signOut
} from 'firebase/auth'
import RoweMark from '../components/RoweMark'
import VoiceOrb from '../components/VoiceOrb'
import { firebaseReady, getFirebaseAuth } from '../lib/firebase'
import { trackEvent, trackPresence, trackSignIn } from './presence'
import {
  getUserProfile,
  hydrateLocalProfileContext,
  PROFILE_ROLES,
  saveUserProfile,
  type UserProfile
} from './profile'
import { getUserPlan, SELECTABLE_PLANS, saveUserPlan, type PlanId, type UserPlan } from './plan'
import { useFirebaseUser } from './useFirebaseUser'

type AuthStatus = {
  trayAsked: boolean
  trayEnabled: boolean
  trayFileAccess?: boolean
  github?: { login: string; name?: string; avatar?: string }
  cursor: boolean
  platform: string
  githubOAuth?: boolean
}

type AuthScreensProps = {
  status: AuthStatus | null
  onStatus: (status: AuthStatus) => void
}

function StartupSplash({ detail }: { detail: string }): React.JSX.Element {
  return (
    <div className="ui-overlay">
      <div className="ui-card ui-startup">
        <VoiceOrb className="mx-auto h-36 w-36" label="Rowe starting" />
        <p className="ui-kicker" style={{ marginTop: 16 }}>
          Rowe
        </p>
        <h2 className="ui-title">Getting ready</h2>
        <p className="ui-copy">{detail}</p>
      </div>
    </div>
  )
}

export default function AuthScreens({ status, onStatus }: AuthScreensProps): React.JSX.Element {
  const { user, loading: authLoading } = useFirebaseUser()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [githubToken, setGithubToken] = useState('')
  const [cursorKey, setCursorKey] = useState('')
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [tab, setTab] = useState<'oauth' | 'key'>('oauth')
  const [cursorTab, setCursorTab] = useState<'dashboard' | 'key'>('dashboard')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileForm, setProfileForm] = useState<UserProfile>({ username: '', roles: [] })
  const [plan, setPlan] = useState<UserPlan | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const ready = firebaseReady()

  useEffect(() => {
    if (!user) {
      setProfile(null)
      setPlan(null)
      setProfileLoading(false)
      setPlanLoading(false)
      return
    }
    let cancelled = false
    setProfileLoading(true)
    setPlanLoading(true)
    void (async () => {
      try {
        await trackSignIn(user).catch(() => undefined)
        const nextProfile = await hydrateLocalProfileContext(user).catch(() => getUserProfile(user))
        const nextPlan = await getUserPlan(user).catch(() => null)
        if (cancelled) return
        setProfile(nextProfile)
        if (nextProfile) setProfileForm(nextProfile)
        setPlan(nextPlan)
        if (nextPlan) {
          await window.api
            .updatePlan({
              planId: nextPlan.planId,
              planName: nextPlan.planName,
              priceUsd: nextPlan.priceUsd,
              openRouterBudgetUsd: nextPlan.openRouterBudgetUsd,
              status: 'active',
              openRouterSpendUsd: nextPlan.usage.openRouterSpendUsd,
              promptTokens: nextPlan.usage.promptTokens,
              completionTokens: nextPlan.usage.completionTokens,
              askCount: nextPlan.usage.askCount,
              periodKey: nextPlan.usage.periodKey
            })
            .catch(() => undefined)
        }
      } finally {
        if (!cancelled) {
          setProfileLoading(false)
          setPlanLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user])

  useEffect(() => {
    if (!user || !status) {
      return
    }
    void trackPresence(user, {
      github: status.github?.login,
      cursor: status.cursor,
      platform: status.platform
    }).catch(() => undefined)
    const timer = window.setInterval(() => {
      void trackPresence(user, {
        github: status.github?.login,
        cursor: status.cursor,
        platform: status.platform
      }).catch(() => undefined)
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [user, status])

  const run = async (work: () => Promise<void>): Promise<void> => {
    setError('')
    setBusy(true)
    try {
      await work()
    } catch (caught) {
      setError(authErrorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const saveProfile = (event: FormEvent): void => {
    event.preventDefault()
    if (!user || !profileForm.username.trim() || profileForm.roles.length === 0) {
      setError('Add a username and at least one role.')
      return
    }
    void run(async () => {
      const withTimezone: UserProfile = {
        ...profileForm,
        timezone: profileForm.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
      }
      await saveUserProfile(user, withTimezone)
      setProfile({
        ...withTimezone,
        username: withTimezone.username.trim(),
        roles: withTimezone.roles.slice(0, 2)
      })
    })
  }

  const signInEmail = (event: FormEvent): void => {
    event.preventDefault()
    void run(async () => {
      const auth = getFirebaseAuth()
      if (mode === 'signup') {
        if (password !== confirmPassword) {
          throw new Error('Passwords do not match.')
        }
        await createUserWithEmailAndPassword(auth, email.trim(), password)
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password)
      }
    })
  }

  const signInGithub = (): void => {
    void run(async () => {
      const token = await window.api.connectGithubOAuth()
      const next = await window.api.getAuthStatus()
      onStatus(next)
      if (ready && !user) {
        await signInWithCredential(getFirebaseAuth(), GithubAuthProvider.credential(token))
      } else if (user) {
        await trackEvent(user, 'connect_github', { method: 'oauth' })
      }
    })
  }

  const saveGithubKey = (event: FormEvent): void => {
    event.preventDefault()
    void run(async () => {
      onStatus(await window.api.connectGithub(githubToken))
      if (user) {
        await trackEvent(user, 'connect_github', { method: 'pat' })
      }
    })
  }

  const saveCursorKey = (event: FormEvent): void => {
    event.preventDefault()
    void run(async () => {
      onStatus(await window.api.connectCursorKey(cursorKey))
      if (user) {
        await trackEvent(user, 'connect_cursor', { method: 'key' })
      }
    })
  }

  if (!ready) {
    return (
      <div className="ui-overlay">
        <div className="ui-card">
          <RoweMark />
          <h2 className="ui-title">Firebase isn’t set up</h2>
          <p className="ui-copy">
            Add your Firebase web config to <code>.env</code> as <code>VITE_FIREBASE_*</code> keys,
            then restart Rowe.
          </p>
        </div>
      </div>
    )
  }

  if (authLoading || status == null || (user != null && (profileLoading || planLoading))) {
    return (
      <StartupSplash
        detail={
          authLoading || status == null
            ? 'Checking sign-in and local settings…'
            : profileLoading
              ? 'Loading your profile…'
              : 'Loading your plan…'
        }
      />
    )
  }

  if (!user) {
    return (
      <div className="ui-overlay">
        <div className="ui-card">
          <RoweMark />
          <p className="ui-kicker" style={{ marginTop: 16 }}>
            Rowe
          </p>
          <h2 className="ui-title">{mode === 'signup' ? 'Create your account' : 'Welcome back'}</h2>
          <p className="ui-copy">Sign in, then connect GitHub and Cursor.</p>

          <div className="ui-stack">
            {status?.githubOAuth ? (
              <>
                <button type="button" className="ui-btn ui-btn-primary" disabled={busy} onClick={signInGithub}>
                  {busy ? 'Opening GitHub…' : 'Continue with GitHub'}
                </button>
                <div className="ui-divider">or</div>
              </>
            ) : null}

            <form className="flex flex-col gap-4" onSubmit={signInEmail}>
              <label className="ui-field">
                <span className="ui-label">Email</span>
                <input
                  className="ui-input"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                />
              </label>
              <label className="ui-field">
                <span className="ui-label">Password</span>
                <input
                  className="ui-input"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  required
                />
              </label>
              {mode === 'signup' ? (
                <label className="ui-field">
                  <span className="ui-label">Confirm password</span>
                  <input
                    className="ui-input"
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </label>
              ) : null}
              {error ? <p className="ui-error">{error}</p> : null}
              <button type="submit" disabled={busy} className="ui-btn ui-btn-secondary">
                {mode === 'signup' ? 'Create account' : 'Log in with email'}
              </button>
            </form>

            <button
              type="button"
              className="ui-link self-center"
              onClick={() => {
                setError('')
                setConfirmPassword('')
                setMode(mode === 'signin' ? 'signup' : 'signin')
              }}
            >
              {mode === 'signin' ? 'Create new account' : 'Already have an account?'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (!profile) {
    const toggleRole = (role: string): void => {
      setProfileForm((current) => {
        if (current.roles.includes(role)) {
          return { ...current, roles: current.roles.filter((item) => item !== role) }
        }
        if (current.roles.length >= 2) {
          return current
        }
        return { ...current, roles: [...current.roles, role] }
      })
    }

    return (
      <div className="ui-overlay">
        <div className="ui-card ui-card-wide">
          <div className="flex items-start gap-3">
            <RoweMark className="size-10 shrink-0" />
            <div className="min-w-0">
              <p className="ui-kicker">Profile</p>
              <h2 className="ui-title">Tell Rowe about you</h2>
              <p className="ui-copy">
                A short profile helps System AI match tone and priorities. You can change this later.
              </p>
            </div>
          </div>

          <form className="ui-stack" onSubmit={saveProfile}>
            <section className="ui-section">
              <p className="ui-section-title">Basics</p>
              <label className="ui-field">
                <span className="ui-label">Username</span>
                <input
                  className="ui-input"
                  required
                  value={profileForm.username}
                  onChange={(event) =>
                    setProfileForm({ ...profileForm, username: event.target.value })
                  }
                  placeholder="How should Rowe address you?"
                  autoFocus
                />
              </label>

              <div className="ui-field">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="ui-label">Your roles</span>
                  <span className="ui-hint">{profileForm.roles.length}/2 selected</span>
                </div>
                <div className="ui-chip-grid" role="group" aria-label="Roles">
                  {PROFILE_ROLES.map((role) => {
                    const on = profileForm.roles.includes(role)
                    const locked = !on && profileForm.roles.length >= 2
                    return (
                      <button
                        type="button"
                        key={role}
                        className="ui-chip"
                        data-on={on}
                        disabled={locked}
                        aria-pressed={on}
                        onClick={() => toggleRole(role)}
                      >
                        {role}
                      </button>
                    )
                  })}
                </div>
              </div>
            </section>

            <section className="ui-section">
              <p className="ui-section-title">Context</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="ui-field">
                  <span className="ui-label">Company or project</span>
                  <input
                    className="ui-input"
                    value={profileForm.company ?? ''}
                    onChange={(event) =>
                      setProfileForm({ ...profileForm, company: event.target.value })
                    }
                    placeholder="Optional"
                  />
                </label>
                <label className="ui-field">
                  <span className="ui-label">Industry</span>
                  <input
                    className="ui-input"
                    value={profileForm.industry ?? ''}
                    onChange={(event) =>
                      setProfileForm({ ...profileForm, industry: event.target.value })
                    }
                    placeholder="SaaS, retail, finance"
                  />
                </label>
              </div>
              <label className="ui-field">
                <span className="ui-label">What you’re working on</span>
                <textarea
                  className="ui-input"
                  value={profileForm.experience ?? ''}
                  onChange={(event) =>
                    setProfileForm({ ...profileForm, experience: event.target.value })
                  }
                  placeholder="Goals, stack, or the kind of help you want"
                />
              </label>
              <label className="ui-field">
                <span className="ui-label">Preferred response style</span>
                <div className="ui-chip-grid">
                  {['Concise', 'Practical', 'Detailed'].map((style) => {
                    const on =
                      (profileForm.preferredStyle || '').toLowerCase() === style.toLowerCase()
                    return (
                      <button
                        type="button"
                        key={style}
                        className="ui-chip"
                        data-on={on}
                        aria-pressed={on}
                        onClick={() =>
                          setProfileForm({
                            ...profileForm,
                            preferredStyle: on ? '' : style.toLowerCase()
                          })
                        }
                      >
                        {style}
                      </button>
                    )
                  })}
                </div>
              </label>
            </section>

            {error ? <p className="ui-error">{error}</p> : null}
            <button type="submit" disabled={busy} className="ui-btn ui-btn-primary">
              {busy ? 'Saving…' : 'Continue'}
            </button>
          </form>
        </div>
      </div>
    )
  }

  if (!plan) {
    const choosePlan = (planId: PlanId): void => {
      if (!user) return
      void run(async () => {
        const next = await saveUserPlan(user, planId)
        setPlan(next)
      })
    }

    return (
      <div className="ui-overlay">
        <div className="ui-card ui-card-wide">
          <div className="flex items-start gap-3">
            <RoweMark className="size-10 shrink-0" />
            <div className="min-w-0">
              <p className="ui-kicker">Plan</p>
              <h2 className="ui-title">Choose how you’ll use Rowe</h2>
              <p className="ui-copy">
                A plan is required for chat, companion, and System AI. Free is available while we
                test, with a $9 monthly AI usage budget.
              </p>
            </div>
          </div>

          <div className="ui-stack">
            {SELECTABLE_PLANS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="ui-plan-card"
                disabled={busy}
                onClick={() => choosePlan(item.id)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="ui-section-title" style={{ margin: 0 }}>
                      {item.name}
                      {item.testing ? ' · Testing' : ''}
                    </p>
                    <p className="ui-copy" style={{ marginTop: 6 }}>
                      {item.blurb}
                    </p>
                  </div>
                  <p className="ui-plan-price">
                    {item.priceUsd === 0 ? 'Free' : `$${item.priceUsd}`}
                    {item.priceUsd > 0 ? <span>/mo</span> : null}
                  </p>
                </div>
                <p className="ui-plan-meta">Monthly AI budget · ${item.openRouterBudgetUsd.toFixed(0)}</p>
              </button>
            ))}
            {error ? <p className="ui-error">{error}</p> : null}
          </div>
        </div>
      </div>
    )
  }

  if (!status?.github || !status.cursor) {
    return (
      <div className="ui-overlay">
        <div className="ui-card ui-card-wide">
          <div className="flex items-start gap-3">
            <RoweMark className="size-10 shrink-0" />
            <div className="min-w-0">
              <p className="ui-kicker">{user.email || user.displayName || 'Signed in'}</p>
              <h2 className="ui-title">Connect Rowe</h2>
              <p className="ui-copy">
                Link GitHub for reference projects and Cursor for workspace edits.
              </p>
            </div>
          </div>

          <div className="ui-stack">
            {!status?.github ? (
              <section className="ui-section">
                <p className="ui-section-title">GitHub</p>
                <div className="ui-tabs" role="tablist">
                  <button type="button" className="ui-tab" data-on={tab === 'oauth'} onClick={() => setTab('oauth')}>
                    Connect
                  </button>
                  <button type="button" className="ui-tab" data-on={tab === 'key'} onClick={() => setTab('key')}>
                    Use a token
                  </button>
                </div>
                {tab === 'oauth' ? (
                  <button
                    type="button"
                    className="ui-btn ui-btn-primary"
                    disabled={busy || !status?.githubOAuth}
                    onClick={signInGithub}
                  >
                    {status?.githubOAuth ? 'Continue with GitHub' : 'Add GITHUB_CLIENT_ID to enable this'}
                  </button>
                ) : (
                  <form className="flex flex-col gap-3" onSubmit={saveGithubKey}>
                    <input
                      className="ui-input"
                      value={githubToken}
                      onChange={(event) => setGithubToken(event.target.value)}
                      placeholder="ghp_…"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="ui-link self-start"
                      onClick={() => {
                        void window.api.openGithubToken()
                      }}
                    >
                      Create a repo/contents token
                    </button>
                    <button type="submit" disabled={busy || !githubToken.trim()} className="ui-btn ui-btn-secondary">
                      Save GitHub token
                    </button>
                  </form>
                )}
              </section>
            ) : (
              <p className="ui-copy" style={{ marginTop: 0 }}>
                GitHub connected · {status.github.login}
              </p>
            )}

            {!status?.cursor ? (
              <section className="ui-section">
                <p className="ui-section-title">Cursor</p>
                <p className="ui-copy" style={{ marginTop: 0 }}>
                  Cursor does not offer a public OAuth app yet. Open the dashboard, copy an API key,
                  then paste it here.
                </p>
                <div className="ui-tabs" role="tablist">
                  <button
                    type="button"
                    className="ui-tab"
                    data-on={cursorTab === 'dashboard'}
                    onClick={() => setCursorTab('dashboard')}
                  >
                    Open dashboard
                  </button>
                  <button
                    type="button"
                    className="ui-tab"
                    data-on={cursorTab === 'key'}
                    onClick={() => setCursorTab('key')}
                  >
                    Paste key
                  </button>
                </div>
                {cursorTab === 'dashboard' ? (
                  <button
                    type="button"
                    className="ui-btn ui-btn-primary"
                    onClick={() => {
                      void window.api.openCursorDashboard()
                      setCursorTab('key')
                    }}
                  >
                    Open Cursor to get a key
                  </button>
                ) : (
                  <form className="flex flex-col gap-3" onSubmit={saveCursorKey}>
                    <input
                      className="ui-input"
                      value={cursorKey}
                      onChange={(event) => setCursorKey(event.target.value)}
                      placeholder="key_…"
                      type="password"
                      autoComplete="off"
                    />
                    <button type="submit" disabled={busy || !cursorKey.trim()} className="ui-btn ui-btn-secondary">
                      Save Cursor key
                    </button>
                  </form>
                )}
              </section>
            ) : (
              <p className="ui-copy" style={{ marginTop: 0 }}>
                Cursor key saved
              </p>
            )}

            {error ? <p className="ui-error">{error}</p> : null}
            <button
              type="button"
              className="ui-link self-center"
              onClick={() => {
                void window.api.clearUserSession().catch(() => undefined)
                void signOut(getFirebaseAuth())
              }}
            >
              Log out
            </button>
          </div>
        </div>
      </div>
    )
  }

  return <></>
}

function authErrorMessage(caught: unknown): string {
  const code = typeof caught === 'object' && caught && 'code' in caught ? String(caught.code) : ''
  if (code === 'auth/email-already-in-use') {
    return 'That email already has an account. Log in instead.'
  }
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return 'Email or password is incorrect.'
  }
  if (code === 'auth/weak-password') {
    return 'Use a password with at least 6 characters.'
  }
  if (code === 'auth/network-request-failed') {
    return 'Could not reach Firebase. Check your connection and try again.'
  }
  return caught instanceof Error ? caught.message : 'Something went wrong'
}
