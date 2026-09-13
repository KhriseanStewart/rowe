import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export type GithubProfile = {
  login: string
  name?: string
  avatar?: string
}

export type AppSettings = {
  trayAsked: boolean
  trayEnabled: boolean
  cursorKey?: string
  githubToken?: string
  github?: GithubProfile
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
    cursorKey: decodeSecret(raw.cursorKey),
    githubToken: decodeSecret(raw.githubToken),
    github:
      raw.github && typeof raw.github === 'object'
        ? (raw.github as GithubProfile)
        : undefined
  }
  return cache
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  cache = { ...current, ...patch }

  const raw = readFile()
  const next: Record<string, unknown> = {
    ...raw,
    trayAsked: cache.trayAsked,
    trayEnabled: cache.trayEnabled,
    github: cache.github
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
