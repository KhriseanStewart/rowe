import type { User } from 'firebase/auth'

export const PROFILE_ROLES = [
  'Developer',
  'Founder',
  'Marketer',
  'Market Manager',
  'Product Manager',
  'Designer',
  'Researcher',
  'Student',
  'Other'
] as const

export type UserProfile = {
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

export async function getUserProfile(_user?: User): Promise<UserProfile | null> {
  return window.api.getUserProfile()
}

export async function saveUserProfile(_user: User, profile: UserProfile): Promise<void> {
  const saved = await window.api.saveUserProfile(profile)
  await window.api.updateProfileContext(formatProfileContext(saved))
}

/** Refresh local personalization hint from Postgres (no secrets). */
export async function hydrateLocalProfileContext(_user: User): Promise<UserProfile | null> {
  const profile = await getUserProfile()
  if (!profile) return null
  await window.api.updateProfileContext(formatProfileContext(profile))
  return profile
}

/**
 * Persist snip "tokens saved" to Postgres using the higher of local vs stored totals.
 * Never writes API keys or auth tokens.
 */
export async function syncTokensSaved(_user: User, localTokensSaved: number): Promise<number> {
  return window.api.syncTokensSaved(localTokensSaved)
}

export function formatProfileContext(profile: UserProfile): string {
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
