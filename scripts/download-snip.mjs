#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'

const REPO = 'edouard-claude/snip'

const TARGETS = {
  'darwin-arm64': { asset: 'darwin_arm64', archive: 'tar.gz', bin: 'snip' },
  'darwin-x64': { asset: 'darwin_amd64', archive: 'tar.gz', bin: 'snip' },
  'linux-x64': { asset: 'linux_amd64', archive: 'tar.gz', bin: 'snip' },
  'linux-arm64': { asset: 'linux_arm64', archive: 'tar.gz', bin: 'snip' },
  'win32-x64': { asset: 'windows_amd64', archive: 'zip', bin: 'snip.exe' },
  'win32-arm64': { asset: 'windows_arm64', archive: 'zip', bin: 'snip.exe' }
}

const root = fileURLToPath(new URL('../resources/snip', import.meta.url))
const force = process.argv.includes('--force')
const all = process.argv.includes('--all')
const keys = all ? Object.keys(TARGETS) : [platformKey()]

function platformKey() {
  return `${process.platform}-${process.arch}`
}

async function latestRelease() {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'rowe-snip-download' }
  })
  if (!response.ok) {
    throw new Error(`GitHub releases failed: ${response.status}`)
  }
  return response.json()
}

function assetName(version, target) {
  return `snip_${version}_${target.asset}.${target.archive}`
}

async function download(url, dest) {
  const response = await fetch(url, { headers: { 'User-Agent': 'rowe-snip-download' } })
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${url} (${response.status})`)
  }
  await pipeline(response.body, createWriteStream(dest))
}

function extract(archive, dest) {
  mkdirSync(dest, { recursive: true })
  execFileSync('tar', ['-xf', archive, '-C', dest])
}

function findBinary(dir, name) {
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
      } else if (entry.name === name) {
        return path
      }
    }
  }
  return undefined
}

const missing = keys.filter((key) => {
  const target = TARGETS[key]
  if (!target) {
    return false
  }
  return force || !existsSync(join(root, key, target.bin))
})

if (missing.length === 0) {
  console.log('snip: bundled binaries already present')
  process.exit(0)
}

const release = await latestRelease()
const version = String(release.tag_name ?? '').replace(/^v/, '')
if (!version) {
  throw new Error('Could not resolve the latest snip version')
}

for (const key of missing) {
  const target = TARGETS[key]
  if (!target) {
    console.warn(`snip: skipping unsupported platform ${key}`)
    continue
  }

  const destDir = join(root, key)
  const destBin = join(destDir, target.bin)
  if (existsSync(destBin) && !force) {
    console.log(`snip ${version}: ${key} already present`)
    continue
  }

  const name = assetName(version, target)
  const asset = release.assets?.find((item) => item.name === name)
  if (!asset?.browser_download_url) {
    throw new Error(`No snip asset named ${name}`)
  }

  const work = join(tmpdir(), `rowe-snip-${key}-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  const archive = join(work, name)

  console.log(`snip ${version}: downloading ${name}`)
  await download(asset.browser_download_url, archive)
  extract(archive, work)

  const extracted = findBinary(work, target.bin)
  if (!extracted) {
    throw new Error(`snip binary missing from ${name}`)
  }

  mkdirSync(destDir, { recursive: true })
  copyFileSync(extracted, destBin)
  if (process.platform !== 'win32') {
    chmodSync(destBin, 0o755)
  }
  rmSync(work, { recursive: true, force: true })
  console.log(`snip ${version}: wrote ${destBin}`)
}
