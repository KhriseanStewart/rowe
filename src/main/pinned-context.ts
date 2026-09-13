import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { ScreenContext } from './ax-context'

export type PinnedContext = ScreenContext & {
  pinnedAt: string
}

export function loadPinnedContext(): PinnedContext | undefined {
  const file = pinFile()
  if (!existsSync(file)) {
    return undefined
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as PinnedContext
    if (!parsed?.text?.trim()) {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

export function savePinnedContext(context: ScreenContext): PinnedContext {
  const pinned: PinnedContext = {
    ...context,
    source: 'pin',
    pinnedAt: new Date().toISOString()
  }
  writeFileSync(pinFile(), JSON.stringify(pinned, null, 2))
  return pinned
}

export function clearPinnedContext(): void {
  const file = pinFile()
  if (existsSync(file)) {
    unlinkSync(file)
  }
}

function pinFile(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'pinned-context.json')
}
