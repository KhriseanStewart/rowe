import { app } from 'electron'
import { execFileSync } from 'child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { delimiter, dirname, join } from 'path'

export type SnipRuntime = {
  snipBin: string
  workspace: string
}

const FILTER_FILES = ['bun.yaml']

export function prepareSnipRuntime(): SnipRuntime | undefined {
  const snipBin = resolveSnipBin()
  if (!snipBin) {
    return undefined
  }

  process.env.SNIP_BIN = snipBin
  const binDir = dirname(snipBin)
  const path = process.env.PATH ?? ''
  if (!path.split(delimiter).includes(binDir)) {
    process.env.PATH = `${binDir}${delimiter}${path}`
  }

  const workspace = join(app.getPath('userData'), 'snip', 'workspace')
  materializeWorkspace(workspace, snipBin)
  syncUserFilters()
  return { snipBin, workspace }
}

export function ensureSnipOnPath(): string | undefined {
  return prepareSnipRuntime()?.snipBin
}

export function resolveSnipBin(): string | undefined {
  const fromEnv = process.env.SNIP_BIN?.trim()
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv
  }

  const bundled = bundledSnipPath()
  if (bundled) {
    return installBundledSnip(bundled)
  }

  try {
    const which = execFileSync('which', ['snip'], { encoding: 'utf8' }).trim()
    if (which && existsSync(which)) {
      return which
    }
  } catch {
    // fall through
  }

  return [
    '/opt/homebrew/bin/snip',
    '/usr/local/bin/snip',
    join(homedir(), '.local', 'bin', 'snip')
  ].find((path) => existsSync(path))
}

function bundledSnipPath(): string | undefined {
  const name = process.platform === 'win32' ? 'snip.exe' : 'snip'
  const candidates = [
    join(process.resourcesPath, 'snip', platformKey(), name),
    join(app.getAppPath(), 'resources', 'snip', platformKey(), name),
    join(__dirname, '../../resources/snip', platformKey(), name)
  ]
  return candidates.find((path) => existsSync(path))
}

function installBundledSnip(source: string): string {
  const name = process.platform === 'win32' ? 'snip.exe' : 'snip'
  const destDir = join(app.getPath('userData'), 'snip', 'bin')
  const dest = join(destDir, name)
  mkdirSync(destDir, { recursive: true })

  if (!sameFile(source, dest)) {
    copyFileSync(source, dest)
  }
  if (process.platform !== 'win32') {
    chmodSync(dest, 0o755)
  }
  return dest
}

function materializeWorkspace(workspace: string, snipBin: string): void {
  const hooksDir = join(workspace, '.cursor', 'hooks')
  const rulesDir = join(workspace, '.cursor', 'rules')
  const filtersDir = join(workspace, '.snip', 'filters')
  mkdirSync(hooksDir, { recursive: true })
  mkdirSync(rulesDir, { recursive: true })
  mkdirSync(filtersDir, { recursive: true })

  const hookJs = join(hooksDir, 'snip.mjs')
  const hookSource = bundledHookPath()
  if (hookSource) {
    copyFileSync(hookSource, hookJs)
  }

  const runner = writeHookRunner(hooksDir, hookJs, snipBin)
  writeFileSync(
    join(workspace, '.cursor', 'hooks.json'),
    JSON.stringify(
      {
        version: 1,
        hooks: {
          preToolUse: [
            {
              command: quoteCommand(runner),
              matcher: 'Shell|shell|Bash'
            }
          ]
        }
      },
      null,
      2
    )
  )

  writeFileSync(
    join(rulesDir, 'snip.mdc'),
    `---
description: Prefix verbose shell commands with the bundled snip binary
alwaysApply: true
---

When running verbose shell commands (\`git\`, \`npm\`, \`bun\`, \`eslint\`, \`tsc\`, tests), prefix them with snip:

\`${snipBin} run -- <command>\`

Skip the prefix when the full raw stream is required.
`
  )

  writeFileSync(
    join(workspace, '.snip', 'config.toml'),
    `mode = "project"

[filters.global]
max_lines = 80
max_line_length = 240
max_output_bytes = 8192
`
  )

  for (const name of FILTER_FILES) {
    const source = projectFilterPath(name)
    if (source) {
      copyFileSync(source, join(filtersDir, name))
    }
  }
}

function writeHookRunner(hooksDir: string, hookJs: string, snipBin: string): string {
  const electron = process.execPath

  if (process.platform === 'win32') {
    const runner = join(hooksDir, 'snip.cmd')
    writeFileSync(
      runner,
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\nset SNIP_BIN=${snipBin}\r\n"${electron}" "${hookJs}"\r\n`
    )
    return runner
  }

  const runner = join(hooksDir, 'snip.sh')
  writeFileSync(
    runner,
    `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexport SNIP_BIN=${shellQuote(snipBin)}\nexec ${shellQuote(electron)} ${shellQuote(hookJs)}\n`
  )
  chmodSync(runner, 0o755)
  return runner
}

function syncUserFilters(): void {
  const dest = join(homedir(), '.config', 'snip', 'filters')
  mkdirSync(dest, { recursive: true })
  for (const name of FILTER_FILES) {
    const source = projectFilterPath(name)
    if (source) {
      copyFileSync(source, join(dest, name))
    }
  }
}

function projectFilterPath(name: string): string | undefined {
  const candidates = [
    join(process.resourcesPath, 'snip', 'filters', name),
    join(app.getAppPath(), 'resources', 'snip', 'filters', name),
    join(__dirname, '../../resources/snip/filters', name),
    join(app.getAppPath(), '.snip', 'filters', name),
    join(__dirname, '../../.snip/filters', name)
  ]
  return candidates.find((path) => existsSync(path))
}

function bundledHookPath(): string | undefined {
  const candidates = [
    join(process.resourcesPath, 'snip', 'hook.mjs'),
    join(app.getAppPath(), 'resources', 'snip', 'hook.mjs'),
    join(__dirname, '../../resources/snip/hook.mjs')
  ]
  return candidates.find((path) => existsSync(path))
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

function sameFile(left: string, right: string): boolean {
  if (!existsSync(right)) {
    return false
  }
  return readFileSync(left).equals(readFileSync(right))
}

function quoteCommand(command: string): string {
  return process.platform === 'win32' ? `"${command}"` : command
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export type SnipCommandGain = {
  command: string
  runs: number
  tokensSaved: number
  avgSavings: number
}

export type SnipGain = {
  ready: boolean
  commands: number
  tokensSaved: number
  avgSavings: number
  top: SnipCommandGain[]
}

export function getSnipGain(): SnipGain {
  const empty: SnipGain = { ready: false, commands: 0, tokensSaved: 0, avgSavings: 0, top: [] }
  const snipBin = resolveSnipBin()
  if (!snipBin) {
    return empty
  }

  try {
    const raw = execFileSync(snipBin, ['gain', '--json'], {
      encoding: 'utf8',
      timeout: 4000
    })
    const data = JSON.parse(raw) as {
      summary?: { TotalCommands?: number; TotalSaved?: number; AvgSavings?: number }
      by_command?: Array<{
        Command?: string
        Count?: number
        SavedTokens?: number
        AvgSavings?: number
      }>
    }

    const commands = Number(data.summary?.TotalCommands ?? 0)
    const tokensSaved = Number(data.summary?.TotalSaved ?? 0)
    const avgSavings = toPercent(Number(data.summary?.AvgSavings ?? 0), tokensSaved)
    const top = (data.by_command ?? [])
      .map((item) => ({
        command: String(item.Command ?? '').trim(),
        runs: Number(item.Count ?? 0),
        tokensSaved: Number(item.SavedTokens ?? 0),
        avgSavings: toPercent(Number(item.AvgSavings ?? 0), Number(item.SavedTokens ?? 0))
      }))
      .filter((item) => item.command)
      .sort((left, right) => right.tokensSaved - left.tokensSaved)
      .slice(0, 3)

    return { ready: true, commands, tokensSaved, avgSavings, top }
  } catch {
    return empty
  }
}

function toPercent(value: number, tokensSaved: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0
  }
  if (value <= 1 && tokensSaved > 0) {
    return value * 100
  }
  return value
}
