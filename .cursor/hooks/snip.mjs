#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoHook = fileURLToPath(new URL('../../resources/snip/hook.mjs', import.meta.url))
const bundled = join(
  dirname(repoHook),
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'snip.exe' : 'snip'
)
if (!process.env.SNIP_BIN && existsSync(bundled)) {
  process.env.SNIP_BIN = bundled
}

if (existsSync(repoHook)) {
  await import(pathToFileURL(repoHook).href)
} else {
  const which = spawnSync('which', ['snip'], { encoding: 'utf8' })
  if (which.status === 0 && which.stdout.trim()) {
    process.env.SNIP_BIN = which.stdout.trim()
  }
  process.env.PATH = `${dirname(process.env.SNIP_BIN ?? '')}${delimiter}${process.env.PATH ?? ''}`
}
