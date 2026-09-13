import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname } from 'node:path'

function readStdin() {
  return new Promise((resolve) => {
    const chunks = []
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.resume()
  })
}

function findSnip() {
  const fromEnv = process.env.SNIP_BIN?.trim()
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv
  }
  return undefined
}

function parseToolInput(value) {
  if (!value) {
    return {}
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return {}
    }
  }
  return value
}

function alreadyWrapped(command) {
  return /\bsnip(\.exe)?\b/.test(command) && /\b(run\s+--|--)\b/.test(command)
}

const raw = await readStdin()
if (!raw.trim()) {
  process.exit(0)
}

let payload
try {
  payload = JSON.parse(raw)
} catch {
  process.exit(0)
}

const toolInput = parseToolInput(payload.tool_input ?? payload.toolInput)
const command = String(toolInput.command ?? payload.command ?? '').trim()
if (!command || alreadyWrapped(command)) {
  process.exit(0)
}

const snip = findSnip()
if (!snip) {
  process.exit(0)
}

const result = spawnSync(snip, ['hook'], {
  input: JSON.stringify({
    tool_name: 'Bash',
    tool_input: { ...toolInput, command }
  }),
  encoding: 'utf8',
  env: {
    ...process.env,
    SNIP_BIN: snip,
    PATH: `${dirname(snip)}${delimiter}${process.env.PATH ?? ''}`
  }
})

if (result.status !== 0 || !result.stdout.trim()) {
  process.exit(0)
}

try {
  const output = JSON.parse(result.stdout)
  const updated = output.hookSpecificOutput?.updatedInput?.command
  if (!updated || updated === command) {
    process.exit(0)
  }

  process.stdout.write(
    JSON.stringify({
      permission: 'allow',
      updated_input: { ...toolInput, command: updated }
    })
  )
} catch {
  process.exit(0)
}
