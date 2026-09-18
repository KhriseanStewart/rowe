import { shell } from 'electron'
import { getSettings, updateSettings, type GithubProfile } from './settings'

const TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=read:user,repo&description=Rowe%20read-only%20repos'

export type GithubRepo = {
  name: string
  fullName: string
  description?: string
  private: boolean
  htmlUrl: string
  updatedAt: string
  defaultBranch?: string
  commitSha?: string
}

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
    throw new Error('GitHub token was rejected. Create a token with repo access.')
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

export function getGithubToken(): string | undefined {
  return getSettings().githubToken
}

export function parseGithubRepo(input: string): { owner: string; repo: string } {
  const trimmed = input.trim().replace(/\.git$/i, '')
  const fromUrl = trimmed.match(/github\.com[:/]+([^/]+)\/([^/#?]+)/i)
  if (fromUrl) {
    return { owner: fromUrl[1], repo: fromUrl[2] }
  }
  const short = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/)
  if (short) {
    return { owner: short[1], repo: short[2] }
  }
  throw new Error('Use owner/repository or a GitHub URL.')
}

export async function listGithubRepos(): Promise<GithubRepo[]> {
  const token = requireGithubToken()
  const repos: GithubRepo[] = []
  let page = 1

  while (page <= 5) {
    const payload = await githubJson<
      Array<{
        name?: string
        full_name?: string
        description?: string | null
        private?: boolean
        html_url?: string
        updated_at?: string
      }>
    >(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`, token)
    if (!payload.length) {
      break
    }
    for (const repo of payload) {
      if (!repo.full_name || !repo.name || !repo.html_url) {
        continue
      }
      repos.push({
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description || undefined,
        private: Boolean(repo.private),
        htmlUrl: repo.html_url,
        updatedAt: repo.updated_at || ''
      })
    }
    if (payload.length < 100) {
      break
    }
    page += 1
  }

  return repos
}

export async function inspectGithubRepo(input: string): Promise<GithubRepo> {
  const { owner, repo } = parseGithubRepo(input)
  const token = getGithubToken()
  const payload = await githubJson<{
    name?: string
    full_name?: string
    description?: string | null
    private?: boolean
    html_url?: string
    updated_at?: string
    default_branch?: string
    message?: string
  }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token)
  if (!payload.full_name || !payload.name || !payload.html_url) {
    throw new Error(payload.message || 'GitHub repository was not found.')
  }

  let commitSha: string | undefined
  if (payload.default_branch) {
    try {
      const commit = await githubJson<{ sha?: string }>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(payload.default_branch)}`,
        token
      )
      commitSha = commit.sha
    } catch {
      commitSha = undefined
    }
  }

  // Confirm contents read access before indexing.
  try {
    await githubJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents?per_page=1`,
      token
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : ''
    if (message.includes('denied') || message.includes('401') || message.includes('403')) {
      throw new Error(
        'GitHub contents access was denied. Create a classic token with repo scope, or a fine-grained token with Contents: Read.'
      )
    }
  }

  return {
    name: payload.name,
    fullName: payload.full_name,
    description: payload.description || undefined,
    private: Boolean(payload.private),
    htmlUrl: payload.html_url,
    updatedAt: payload.updated_at || '',
    defaultBranch: payload.default_branch,
    commitSha
  }
}

function requireGithubToken(): string {
  const token = getGithubToken()
  if (!token) {
    throw new Error('Connect GitHub to browse your repositories.')
  }
  return token
}

async function githubJson<T>(path: string, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Rowe'
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  const response = await fetch(`https://api.github.com${path}`, { headers })
  if (response.status === 401 || response.status === 403) {
    throw new Error('GitHub access was denied. Reconnect GitHub and allow repo access.')
  }
  if (response.status === 404) {
    throw new Error('That GitHub repository was not found.')
  }
  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status}).`)
  }
  return (await response.json()) as T
}
