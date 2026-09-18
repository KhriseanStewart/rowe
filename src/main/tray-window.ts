import { BrowserWindow, Menu, Tray, app, globalShortcut, nativeImage, screen } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'
import { isCompanionActive, startCompanion, stopCompanion } from './companion'
import { trayShowShortcut } from './platform'
import { loadRenderer } from './renderer-url'

let mainTray: Tray | undefined
let trayWindow: BrowserWindow | undefined
let trayClickHandler: (() => void) | undefined
let openAppHandler: (() => void) | undefined

export function setTrayClickHandler(handler: (() => void) | undefined): void {
  trayClickHandler = handler
}

export function setOpenAppHandler(handler: (() => void) | undefined): void {
  openAppHandler = handler
}

const WINDOW_SIZE_DEFAULTS = {
  width: 293,
  height: 240,
  expandedWidth: 420,
  expandedHeight: 520,
  margin: {
    x: 14,
    y: 14
  }
}

let trayExpanded = false

export function toggleTrayExpanded(): boolean {
  trayExpanded = !trayExpanded
  alignWindow()
  logWindowSize()
  return trayExpanded
}

export function isTrayExpanded(): boolean {
  return trayExpanded
}

export function initTray(): void {
  if (mainTray) {
    return
  }

  const trayIcon = nativeImage.createFromPath(icon).resize({
    width: process.platform === 'darwin' ? 22 : 16,
    height: process.platform === 'darwin' ? 22 : 16,
    quality: 'best'
  })
  mainTray = new Tray(trayIcon)
  mainTray.setToolTip('Rowe')
  mainTray.on('right-click', () => {
    mainTray?.popUpContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open App', click: () => openAppHandler?.() },
        { label: 'Companion Mode', click: () => startCompanion() },
        { label: 'Quit', role: 'quit' }
      ])
    )
  })

  createTrayWindow()

  const showShortcut = trayShowShortcut()
  if (!globalShortcut.register(showShortcut, () => {
    openTrayWindow()
  })) {
    console.error(`Could not register ${showShortcut}`)
  }

  mainTray.on('click', () => {
    trayClickHandler?.()
    toggleTrayWindow()
  })

  app.on('before-quit', () => {
    globalShortcut.unregister(showShortcut)
    mainTray?.destroy()
    mainTray = undefined
  })
}

function createTrayWindow(): void {
  trayWindow = new BrowserWindow({
    width: WINDOW_SIZE_DEFAULTS.width,
    height: WINDOW_SIZE_DEFAULTS.height,
    show: false,
    frame: false,
    // Transparent windows break on macOS when resizable is true.
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    // Panel is required on macOS to float above fullscreen apps / Spaces.
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  pinTrayWindow()
  logWindowSize()
  loadRenderer(trayWindow, 'tray')

  trayWindow.on('closed', () => {
    trayWindow = undefined
  })
}

export function destroyTray(): void {
  hideTrayWindow()
  globalShortcut.unregister(trayShowShortcut())
  if (trayWindow && !trayWindow.isDestroyed()) {
    trayWindow.close()
  }
  trayWindow = undefined
  mainTray?.destroy()
  mainTray = undefined
}

export function hideTrayWindow(): void {
  trayWindow?.hide()
}

export function openTrayWindow(): void {
  if (isCompanionActive()) {
    stopCompanion()
  }

  showTrayWindow()
}

export function getTrayWindow(): BrowserWindow | undefined {
  return trayWindow
}

export function isPointInTrayWindow(point: { x: number; y: number }): boolean {
  if (!trayWindow?.isVisible()) {
    return false
  }

  const { x, y, width, height } = trayWindow.getBounds()
  return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height
}

export function showTrayWindowInactive(): void {
  if (!trayWindow) {
    return
  }

  if (!trayWindow.isVisible()) {
    alignWindow()
    trayWindow.showInactive()
  }

  pinTrayWindow()
}

function toggleTrayWindow(): void {
  if (!trayWindow) {
    createTrayWindow()
  }

  if (trayWindow?.isVisible()) {
    trayWindow.hide()
    return
  }

  showTrayWindow()
}

function showTrayWindow(): void {
  if (!trayWindow) {
    return
  }

  alignWindow()
  trayWindow.setBackgroundColor('#00000000')
  trayWindow.show()
  pinTrayWindow()
  trayWindow.webContents.focus()
}

function logWindowSize(): void {
  if (!trayWindow) {
    return
  }

  const { width, height } = trayWindow.getBounds()
  console.log(`tray window ${width}x${height}`)
}

function pinTrayWindow(): void {
  if (!trayWindow || trayWindow.isDestroyed()) {
    return
  }

  // Panel + fullscreen-auxiliary collection behavior lets the HUD overlay Spaces/fullscreen.
  trayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  trayWindow.setAlwaysOnTop(true, 'screen-saver', 1)
}

function alignWindow(): void {
  if (!trayWindow) {
    return
  }

  const display = mainTray
    ? screen.getDisplayMatching(mainTray.getBounds())
    : screen.getPrimaryDisplay()
  const { workArea } = display
  const width = trayExpanded ? WINDOW_SIZE_DEFAULTS.expandedWidth : WINDOW_SIZE_DEFAULTS.width
  const height = trayExpanded ? WINDOW_SIZE_DEFAULTS.expandedHeight : WINDOW_SIZE_DEFAULTS.height

  const x = Math.round(workArea.x + WINDOW_SIZE_DEFAULTS.margin.x)
  const y = Math.round(workArea.y + WINDOW_SIZE_DEFAULTS.margin.y)

  trayWindow.setBounds(
    {
      x,
      y,
      width: Math.min(width, workArea.width - WINDOW_SIZE_DEFAULTS.margin.x * 2),
      height: Math.min(height, workArea.height - WINDOW_SIZE_DEFAULTS.margin.y * 2)
    },
    false
  )
}
