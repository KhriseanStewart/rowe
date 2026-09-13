import { BrowserWindow, Menu, Tray, app, nativeImage, screen } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'
import { isCompanionActive, startCompanion, stopCompanion } from './companion'
import { glassWindowOptions } from './platform'
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
  width: 343,
  height: 280,
  margin: {
    x: 8,
    y: 4
  }
}

export function initTray(): void {
  if (mainTray) {
    return
  }

  const trayIcon = nativeImage.createFromPath(icon).resize({ width: 18, height: 18 })
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

  mainTray.on('click', () => {
    trayClickHandler?.()
    toggleTrayWindow()
  })

  app.on('before-quit', () => {
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
    resizable: true,
    minWidth: 320,
    minHeight: 280,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    transparent: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    ...glassWindowOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  pinTrayWindow()
  logWindowSize()

  trayWindow.on('resize', () => {
    logWindowSize()
  })

  loadRenderer(trayWindow, 'tray')

  trayWindow.on('closed', () => {
    trayWindow = undefined
  })
}

export function destroyTray(): void {
  hideTrayWindow()
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
  if (!trayWindow) {
    return
  }

  trayWindow.setAlwaysOnTop(true, 'screen-saver', 1)
  trayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
}

function alignWindow(): void {
  if (!trayWindow || !mainTray) {
    return
  }

  const trayBounds = mainTray.getBounds()
  const { width, height } = trayWindow.getBounds()
  const { workArea } = screen.getDisplayMatching(trayBounds)

  let x = workArea.x
  let y = Math.round(trayBounds.y + trayBounds.height + WINDOW_SIZE_DEFAULTS.margin.y)

  if (trayBounds.y > workArea.y + workArea.height / 2) {
    y = Math.round(trayBounds.y - height - WINDOW_SIZE_DEFAULTS.margin.y)
  }

  x = Math.min(
    Math.max(x, workArea.x + WINDOW_SIZE_DEFAULTS.margin.x),
    workArea.x + workArea.width - width - WINDOW_SIZE_DEFAULTS.margin.x
  )

  trayWindow.setPosition(x, y, false)
}
