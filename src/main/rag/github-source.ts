import { app } from 'electron'
import { execFileSync } from 'child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { getGithubToken, parseGithubRepo, type GithubRepo } from '../github'

export async function checkoutGithubRepo(repo: GithubRepo, ref?: string): Promise<string> {
  const token = getGithubToken()
  const { owner, repo: name } = parseGithubRepo(repo.fullName)
  const pinned = ref || repo.commitSha || repo.defaultBranch
  const dest = join(app.getPath('userData'), 'rag', 'github', repo.fullName.replaceAll('/', '__'))
  const stampPath = join(dirname(dest), `${repo.fullName.replaceAll('/', '__')}.ref`)

  // Reuse cached checkout when the same ref is already on disk.
  if (existsSync(dest) && existsSync(stampPath)) {
    try {
      const prior = readFileSync(stampPath, 'utf8').trim()
      if (prior === String(pinned || '') && readdirSync(dest).length > 0) {
        return dest
      }
    } catch {
      // fall through to fresh download
    }
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/zipball${pinned ? `/${encodeURIComponent(pinned)}` : ''}`
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Rowe'
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const response = await fetch(url, { headers, redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error('Could not download that GitHub project.')
  }

  const work = join(tmpdir(), `rowe-gh-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  const archive = join(work, 'repo.zip')

  const nodeStream = Readable.fromWeb(response.body as import('stream/web').ReadableStream)
  await pipeline(nodeStream, createWriteStream(archive))
  execFileSync('tar', ['-xf', archive, '-C', work], { stdio: 'ignore' })

  const extracted = firstDirectory(work)
  if (!extracted) {
    throw new Error('GitHub archive did not contain a project folder.')
  }

  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  renameSync(extracted, dest)
  writeFileSync(stampPath, String(pinned || ''), 'utf8')
  rmSync(work, { recursive: true, force: true })
  return dest
}

function firstDirectory(root: string): string | undefined {
  for (const name of readdirSync(root)) {
    if (name === 'repo.zip') {
      continue
    }
    const path = join(root, name)
    if (existsSync(path) && statSync(path).isDirectory()) {
      return path
    }
  }
  return undefined
}
