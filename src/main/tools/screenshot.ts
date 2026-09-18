import { app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { platform } from 'os'
import { appendAudit } from './audit-log'
import { getPermissionStatus } from './permissions'
import type { ToolCallResponse, ToolContext } from './types'

const execFileAsync = promisify(execFile)

function shotsDir(): string {
  const dir = join(app.getPath('userData'), 'screenshots')
  mkdirSync(dir, { recursive: true })
  return dir
}

export async function runScreenshotTool(
  tool: string,
  params: Record<string, unknown>,
  requestId: string,
  _ctx: ToolContext
): Promise<ToolCallResponse> {
  if (platform() !== 'darwin') {
    return { requestId, status: 'error', error: 'Window screenshots are macOS-only in this build.' }
  }

  const perms = await getPermissionStatus()
  if (perms.screenRecording === 'denied') {
    appendAudit({ tool, action: tool, status: 'needs_permission', detail: 'Screen Recording denied' })
    return {
      requestId,
      status: 'needs_permission',
      error:
        'Screen Recording permission is required. Open Settings → Permissions, enable Screen Recording, then retry.'
    }
  }

  try {
    if (tool === 'screenshot.list_windows') {
      const { stdout } = await execFileAsync(
        'osascript',
        [
          '-e',
          'tell application "System Events" to get name of every window of (every process whose background only is false)'
        ],
        { timeout: 10000 }
      )
      appendAudit({ tool, action: 'list_windows', status: 'success' })
      return { requestId, status: 'success', result: { windows: stdout.trim() } }
    }

    if (tool === 'screenshot.capture') {
      const out = join(shotsDir(), `shot-${Date.now()}.png`)
      const windowId = params.windowId != null ? String(params.windowId) : ''
      const windowName = String(params.windowName || params.title || '').trim()

      if (windowId) {
        await execFileAsync('screencapture', ['-x', '-l', windowId, out], { timeout: 15000 })
      } else if (windowName) {
        const swift = `import Cocoa
let want = CommandLine.arguments[1].lowercased()
let opts = CGWindowListOption(arrayLiteral: .optionOnScreenOnly, .excludeDesktopElements)
guard let info = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { fatalError("no") }
for w in info {
  let name = String(describing: w[kCGWindowName as String] ?? "").lowercased()
  let owner = String(describing: w[kCGWindowOwnerName as String] ?? "").lowercased()
  if name.contains(want) || owner.contains(want) {
    if let id = w[kCGWindowNumber as String] as? Int { print(id); break }
  }
}
`
        const tmpSwift = join(shotsDir(), `find-window-${Date.now()}.swift`)
        writeFileSync(tmpSwift, swift)
        try {
          const { stdout } = await execFileAsync('swift', [tmpSwift, windowName], { timeout: 25000 })
          const id = stdout.trim()
          if (!id) throw new Error(`No on-screen window matched “${windowName}”`)
          await execFileAsync('screencapture', ['-x', '-l', id, out], { timeout: 15000 })
        } finally {
          try {
            unlinkSync(tmpSwift)
          } catch {
            /* ignore */
          }
        }
      } else {
        await execFileAsync('screencapture', ['-x', out], { timeout: 15000 })
      }

      if (!existsSync(out)) throw new Error('Screenshot file was not created')
      appendAudit({ tool, action: 'capture', path: out, status: 'success' })
      return { requestId, status: 'success', result: { path: out, summary: `Saved screenshot ${out}` } }
    }

    return { requestId, status: 'error', error: `Unknown screenshot tool: ${tool}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Screenshot failed'
    appendAudit({ tool, action: tool, status: 'error', detail: message })
    return { requestId, status: 'error', error: message }
  }
}
