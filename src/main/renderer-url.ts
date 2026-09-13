import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type { BrowserWindow } from 'electron'

export function loadRenderer(window: BrowserWindow, surface: 'app' | 'tray'): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?surface=${surface}`)
    return
  }
  window.loadFile(join(__dirname, '../renderer/index.html'), { query: { surface } })
}
