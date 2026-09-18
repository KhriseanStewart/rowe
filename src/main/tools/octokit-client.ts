import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/rest'
import { existsSync, readFileSync } from 'fs'
import { getGithubToken } from '../github'

export type GithubAuthMode = 'app' | 'oauth' | 'none'

function env(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : undefined
}

function readPrivateKey(): string | undefined {
  const inline = env('GITHUB_APP_PRIVATE_KEY')
  if (inline) return inline.replace(/\\n/g, '\n')
  const path = env('GITHUB_APP_PRIVATE_KEY_PATH')
  if (path && existsSync(path)) return readFileSync(path, 'utf8')
  return undefined
}

/** Prefer GitHub App when fully configured; otherwise fall back to user OAuth/PAT. */
export function getGithubAuthMode(): GithubAuthMode {
  if (env('GITHUB_APP_ID') && readPrivateKey() && env('GITHUB_APP_INSTALLATION_ID')) return 'app'
  if (getGithubToken()) return 'oauth'
  return 'none'
}

export function createRoweOctokit(): Octokit {
  const mode = getGithubAuthMode()
  if (mode === 'app') {
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: env('GITHUB_APP_ID')!,
        privateKey: readPrivateKey()!,
        installationId: Number(env('GITHUB_APP_INSTALLATION_ID'))
      },
      userAgent: 'Rowe'
    })
  }
  const token = getGithubToken()
  if (!token) {
    throw new Error(
      'GitHub is not connected. Connect GitHub in Settings, or set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID.'
    )
  }
  return new Octokit({ auth: token, userAgent: 'Rowe' })
}

export function githubCloneToken(): string | undefined {
  // App installation tokens are short-lived; for clone URL use OAuth token when present.
  return getGithubToken() || undefined
}
