import { shell } from 'electron'
import { getSettings, updateSettings, type GithubProfile } from './settings'

const TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=read:user&description=Rowe'

export async function connectGithub(token: string): Promise<GithubProfile> {
  const value = token.trim()
  if (!value) {
    throw new Error('GitHub token is empty')
  }

  const response = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${value}`,
      'User-Agent': 'Rowe'
    }
  })

  if (!response.ok) {
    throw new Error('GitHub token was rejected. Create a token with read:user.')
  }

  const user = (await response.json()) as {
    login?: string
    name?: string
    avatar_url?: string
  }

  if (!user.login) {
    throw new Error('GitHub did not return a username')
  }

  const profile: GithubProfile = {
    login: user.login,
    name: user.name || undefined,
    avatar: user.avatar_url
  }

  updateSettings({ githubToken: value, github: profile })
  return profile
}

export function disconnectGithub(): void {
  updateSettings({ githubToken: undefined, github: undefined })
}

export function openGithubTokenPage(): void {
  void shell.openExternal(TOKEN_URL)
}

export function getGithubProfile(): GithubProfile | undefined {
  return getSettings().github
}
