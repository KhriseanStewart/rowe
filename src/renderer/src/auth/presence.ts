import { logEvent } from 'firebase/analytics'
import type { User } from 'firebase/auth'
import { getFirebaseAnalytics } from '../lib/firebase'

export async function trackPresence(
  user: User,
  extras?: { github?: string; cursor?: boolean; platform?: string }
): Promise<void> {
  await window.api.setUserSession({
    uid: user.uid,
    email: user.email,
    name: user.displayName,
    photo: user.photoURL
  })
  await window.api.trackUserPresence(extras)
}

export async function trackSignIn(user: User): Promise<void> {
  await window.api.setUserSession({
    uid: user.uid,
    email: user.email,
    name: user.displayName,
    photo: user.photoURL
  })
  const analytics = await getFirebaseAnalytics()
  if (analytics) {
    logEvent(analytics, 'login', { method: user.providerData[0]?.providerId ?? 'password' })
  }
}

export type PresenceStats = {
  activeLast5m: number
  activeLast24h: number
  users: number
}

export async function readPresenceStats(): Promise<PresenceStats | null> {
  try {
    return await window.api.getPresenceStats()
  } catch {
    return null
  }
}

export async function trackEvent(
  _user: User,
  name: string,
  payload?: Record<string, string | boolean>
): Promise<void> {
  await window.api.trackUserEvent(name, payload)
}
