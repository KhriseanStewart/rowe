#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TARGETS = {
  'darwin-arm64': { pkg: '@koromix/koffi-darwin-arm64', dir: 'darwin_arm64' },
  'darwin-x64': { pkg: '@koromix/koffi-darwin-x64', dir: 'darwin_x64' },
  'linux-x64': { pkg: '@koromix/koffi-linux-x64', dir: 'linux_x64' },
  'linux-arm64': { pkg: '@koromix/koffi-linux-arm64', dir: 'linux_arm64' },
  'win32-x64': { pkg: '@koromix/koffi-win32-x64', dir: 'win32_x64' },
  'win32-arm64': { pkg: '@koromix/koffi-win32-arm64', dir: 'win32_arm64' }
}

const root = fileURLToPath(new URL('..', import.meta.url))
const destRoot = join(root, 'resources', 'koffi')
const force = process.argv.includes('--force')
const all = process.argv.includes('--all')
const keys = all ? Object.keys(TARGETS) : [platformKey()]

function platformKey() {
  return `${process.platform}-${process.arch}`
}

function koffiVersion() {
  return JSON.parse(readFileSync(join(root, 'node_modules/koffi/package.json'), 'utf8')).version
}

function extract(archive, dest) {
  mkdirSync(dest, { recursive: true })
  execFileSync('tar', ['-xf', archive, '-C', dest])
}

function findNode(dir) {
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
      } else if (entry.name === 'koffi.node') {
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
  return force || !existsSync(join(destRoot, target.dir, 'koffi.node'))
})

if (missing.length === 0) {
  console.log('koffi: bundled natives already present')
  process.exit(0)
}

const version = koffiVersion()
mkdirSync(destRoot, { recursive: true })

for (const key of missing) {
  const target = TARGETS[key]
  if (!target) {
    console.warn(`koffi: skipping unsupported platform ${key}`)
    continue
  }

  const destDir = join(destRoot, target.dir)
  const destFile = join(destDir, 'koffi.node')
  if (existsSync(destFile) && !force) {
    console.log(`koffi ${version}: ${key} already present`)
    continue
  }

  const work = join(tmpdir(), `rowe-koffi-${key}-${Date.now()}`)
  mkdirSync(work, { recursive: true })
  console.log(`koffi ${version}: packing ${target.pkg}`)
  const packed = execFileSync(
    'npm',
    ['pack', `${target.pkg}@${version}`, '--pack-destination', work, '--silent'],
    {
      cwd: root,
      encoding: 'utf8'
    }
  ).trim()
  const archive = join(work, packed.split('\n').at(-1) ?? packed)
  extract(archive, work)

  const extracted = findNode(work)
  if (!extracted) {
    throw new Error(`koffi.node missing from ${target.pkg}@${version}`)
  }

  mkdirSync(destDir, { recursive: true })
  copyFileSync(extracted, destFile)
  rmSync(work, { recursive: true, force: true })
  console.log(`koffi ${version}: wrote ${destFile}`)
}
