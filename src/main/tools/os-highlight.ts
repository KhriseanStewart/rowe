import { BrowserWindow, screen } from 'electron'
import { broadcastStreamEvent } from './stream-server'

let highlightWindow: BrowserWindow | undefined
let hideTimer: NodeJS.Timeout | undefined

export type OsPreviewPayload = {
  tool: string
  label: string
  x?: number
  y?: number
  durationMs?: number
}

function broadcast(payload: OsPreviewPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('tools:os-preview', payload)
  }
}

/** Show a brief on-screen highlight (and notify renderer) before an OS action. */
export async function showOsActionPreview(payload: OsPreviewPayload): Promise<void> {
  const durationMs = Math.max(400, Math.min(payload.durationMs ?? 900, 3000))
  broadcast(payload)
  broadcastStreamEvent({ type: 'os.preview', payload })

  const display = screen.getPrimaryDisplay()
  const { width, height } = display.bounds
  const size = 72
  const x = Number.isFinite(payload.x) ? Math.round(Number(payload.x) - size / 2) : Math.round(width / 2 - size / 2)
  const y = Number.isFinite(payload.y) ? Math.round(Number(payload.y) - size / 2) : Math.round(height / 2 - size / 2)

  if (highlightWindow && !highlightWindow.isDestroyed()) {
    highlightWindow.close()
  }
  if (hideTimer) clearTimeout(hideTimer)

  highlightWindow = new BrowserWindow({
    x: Math.max(0, x),
    y: Math.max(0, y),
    width: size,
    height: size,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  highlightWindow.setIgnoreMouseEvents(true)
  highlightWindow.setAlwaysOnTop(true, 'screen-saver', 1)
  const label = (payload.label || payload.tool).replace(/[<>&]/g, '')
  const html = `<!doctype html><html><body style="margin:0;overflow:hidden;background:transparent">
<div style="width:${size}px;height:${size}px;border-radius:50%;border:3px solid #5b8cff;box-shadow:0 0 0 6px rgba(91,140,255,.25),0 8px 24px rgba(0,0,0,.35);background:rgba(91,140,255,.15);display:flex;align-items:center;justify-content:center;font:600 10px/1.1 -apple-system,sans-serif;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.6);text-align:center;padding:6px;box-sizing:border-box">${label}</div>
</body></html>`
  await highlightWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  highlightWindow.showInactive()

  await new Promise<void>((resolve) => {
    hideTimer = setTimeout(() => {
      if (highlightWindow && !highlightWindow.isDestroyed()) highlightWindow.close()
      highlightWindow = undefined
      resolve()
    }, durationMs)
  })
}
