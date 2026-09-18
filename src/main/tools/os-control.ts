import { app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { platform } from 'os'
import { getSettings } from '../settings'
import { appendAudit } from './audit-log'
import { putPending } from './pending'
import { getPermissionStatus } from './permissions'
import { showOsActionPreview } from './os-highlight'
import type { ToolCallResponse, ToolContext } from './types'

const execFileAsync = promisify(execFile)

async function requireAccessibility(requestId: string, tool: string): Promise<ToolCallResponse | null> {
  if (platform() !== 'darwin') {
    return { requestId, status: 'error', error: 'OS control is macOS-only in this build.' }
  }
  const perms = await getPermissionStatus()
  if (perms.accessibility === 'denied') {
    appendAudit({ tool, action: tool, status: 'needs_permission', detail: 'Accessibility denied' })
    return {
      requestId,
      status: 'needs_permission',
      error:
        'Accessibility permission is required for mouse/keyboard control. Open Settings → Permissions to enable it.'
    }
  }
  return null
}

export async function runOsControlTool(
  tool: string,
  params: Record<string, unknown>,
  requestId: string,
  ctx: ToolContext
): Promise<ToolCallResponse> {
  const blocked = await requireAccessibility(requestId, tool)
  if (blocked) return blocked

  const trusted = ctx.trusted ?? Boolean(getSettings().trustedMode)

  const execute = async (): Promise<ToolCallResponse> => {
    try {
      if (tool === 'os.click') {
        const x = Number(params.x)
        const y = Number(params.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('click requires numeric x,y')
        await showOsActionPreview({ tool, label: 'Click', x, y, durationMs: 700 })
        const swift = `import Cocoa
let x = Double(CommandLine.arguments[1])!
let y = Double(CommandLine.arguments[2])!
let src = CGEventSource(stateID: .hidSystemState)
let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)
let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)
down?.post(tap: .cghidEventTap)
up?.post(tap: .cghidEventTap)
`
        const tmp = join(app.getPath('userData'), `os-click-${Date.now()}.swift`)
        writeFileSync(tmp, swift)
        try {
          await execFileAsync('swift', [tmp, String(x), String(y)], { timeout: 15000 })
        } finally {
          try {
            unlinkSync(tmp)
          } catch {
            /* ignore */
          }
        }
        appendAudit({ tool, action: 'click', status: 'success', detail: `${x},${y}` })
        return { requestId, status: 'success', result: { x, y, summary: `Clicked ${x},${y}` } }
      }

      if (tool === 'os.type') {
        const text = String(params.text || '')
        if (!text) throw new Error('type requires text')
        await showOsActionPreview({ tool, label: 'Type', durationMs: 700 })
        const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        await execFileAsync(
          'osascript',
          ['-e', `tell application "System Events" to keystroke "${escaped}"`],
          { timeout: 15000 }
        )
        appendAudit({ tool, action: 'type', status: 'success', detail: `typed ${text.length} chars` })
        return { requestId, status: 'success', result: { summary: `Typed ${text.length} characters` } }
      }

      if (tool === 'os.key') {
        const key = String(params.key || params.combo || '').trim()
        if (!key) throw new Error('key requires key/combo')
        await showOsActionPreview({ tool, label: key.slice(0, 12), durationMs: 600 })
        const parts = key.toLowerCase().split('+').map((p) => p.trim())
        const main = parts[parts.length - 1]
        const mods: string[] = []
        if (parts.includes('cmd') || parts.includes('command') || parts.includes('meta')) mods.push('command down')
        if (parts.includes('shift')) mods.push('shift down')
        if (parts.includes('alt') || parts.includes('option')) mods.push('option down')
        if (parts.includes('ctrl') || parts.includes('control')) mods.push('control down')
        const using = mods.length ? ` using {${mods.join(', ')}}` : ''
        const keyCodeMap: Record<string, string> = {
          enter: 'key code 36',
          return: 'key code 36',
          tab: 'key code 48',
          escape: 'key code 53',
          esc: 'key code 53',
          space: 'key code 49',
          delete: 'key code 51',
          backspace: 'key code 51'
        }
        const stroke = keyCodeMap[main]
          ? `${keyCodeMap[main]}${using}`
          : `keystroke "${main.replace(/"/g, '')}"${using}`
        await execFileAsync('osascript', ['-e', `tell application "System Events" to ${stroke}`], {
          timeout: 10000
        })
        appendAudit({ tool, action: 'key', status: 'success', detail: key })
        return { requestId, status: 'success', result: { summary: `Pressed ${key}` } }
      }

      if (tool === 'os.focus_window') {
        const appName = String(params.app || params.name || '').trim()
        if (!appName) throw new Error('focus_window requires app name')
        await showOsActionPreview({ tool, label: appName.slice(0, 14), durationMs: 600 })
        await execFileAsync(
          'osascript',
          ['-e', `tell application "${appName.replace(/"/g, '')}" to activate`],
          { timeout: 10000 }
        )
        appendAudit({ tool, action: 'focus_window', status: 'success', detail: appName })
        return { requestId, status: 'success', result: { summary: `Focused ${appName}` } }
      }

      return { requestId, status: 'error', error: `Unknown os-control tool: ${tool}` }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OS control failed'
      appendAudit({ tool, action: tool, status: 'error', detail: message })
      return { requestId, status: 'error', error: message }
    }
  }

  if (!trusted) {
    putPending(requestId, { tool, params, requestId }, execute)
    appendAudit({ tool, action: tool, status: 'pending', detail: 'Awaiting confirmation' })
    return {
      requestId,
      status: 'needs_confirmation',
      confirmation: {
        title: 'Confirm OS action',
        summary: `${tool}`,
        danger: true,
        preview: { tool, params }
      }
    }
  }

  return execute()
}
