import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { hideTrayWindow, initTray, destroyTray, setTrayClickHandler, setOpenAppHandler } from './tray-window'
import {
  connectCursor,
  disconnectCursor,
  disposeCursor,
  sendCursorPrompt,
  type CursorImage
} from './cursor'
import { getSnipGain, prepareSnipRuntime } from './snip'
import { getSettings, updateSettings } from './settings'
import {
  connectGithub,
  disconnectGithub,
  getGithubProfile,
  openGithubTokenPage
} from './github'
import {
  createThread,
  deleteThread,
  getThread,
  listThreads
} from './history'
import {
  hideJarvis,
  isCompanionActive,
  pinJarvisContext,
  startCompanion,
  stopCompanion,
  submitJarvisNote
} from './companion'
import { loadRenderer } from './renderer-url'

let mainWindow: BrowserWindow | undefined
let quitting = false

export function createWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow
  }

  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    title: 'Rowe',
    backgroundColor: '#161618',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 16, y: 18 }
        }
      : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    if (getSettings().trayEnabled && !quitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  loadRenderer(mainWindow, 'app')
  mainWindow.on('closed', () => {
    mainWindow = undefined
  })
  return mainWindow
}

export function showMainWindow(): void {
  const window = createWindow()
  if (window.isMinimized()) {
    window.restore()
  }
  window.show()
  window.focus()
}

function authStatus(): {
  trayAsked: boolean
  trayEnabled: boolean
  github: ReturnType<typeof getGithubProfile>
  cursor: boolean
  platform: NodeJS.Platform
} {
  const settings = getSettings()
  return {
    trayAsked: settings.trayAsked,
    trayEnabled: settings.trayEnabled,
    github: getGithubProfile(),
    cursor: Boolean(settings.cursorKey),
    platform: process.platform
  }
}

app.whenReady().then(() => {
  const snip = prepareSnipRuntime()
  if (snip) {
    console.log(`Rowe bundled snip at ${snip.snipBin}`)
  }

  electronApp.setAppUserModelId('com.rowe.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('window:close', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window === mainWindow) {
      if (getSettings().trayEnabled) {
        window.hide()
        return
      }
      window.close()
      return
    }
    hideTrayWindow()
  })

  ipcMain.handle('window:show-app', () => {
    showMainWindow()
  })

  ipcMain.handle('auth:status', () => authStatus())

  ipcMain.handle('auth:connect-cursor', async (_event, apiKey?: string) => {
    const connection = await connectCursor(apiKey)
    return { ...authStatus(), connection }
  })

  ipcMain.handle('auth:connect-github', async (_event, token: string) => {
    await connectGithub(token)
    return authStatus()
  })

  ipcMain.handle('auth:open-github-token', () => {
    openGithubTokenPage()
  })

  ipcMain.handle('auth:disconnect', async () => {
    disconnectGithub()
    disconnectCursor()
    return authStatus()
  })

  ipcMain.handle('tray:set', (_event, enabled: boolean) => {
    updateSettings({ trayAsked: true, trayEnabled: enabled })
    if (enabled) {
      initTray()
    } else {
      destroyTray()
    }
    return authStatus()
  })

  ipcMain.handle('cursor:connect', async (_event, apiKey?: string) => {
    return connectCursor(apiKey)
  })

  ipcMain.handle(
    'cursor:send',
    async (event, text: string, images?: CursorImage[], threadId?: string) => {
      return sendCursorPrompt(
        text,
        (chunk) => {
          event.sender.send('cursor:delta', chunk)
        },
        images,
        threadId
      )
    }
  )

  ipcMain.handle('history:list', () => listThreads())
  ipcMain.handle('history:get', (_event, id: string) => getThread(id))
  ipcMain.handle('history:create', () => createThread())
  ipcMain.handle('history:delete', (_event, id: string) => {
    deleteThread(id)
    return listThreads()
  })

  ipcMain.handle('companion:start', () => {
    startCompanion()
  })

  ipcMain.handle('companion:stop', () => {
    stopCompanion()
  })

  ipcMain.handle('jarvis:hide', () => {
    hideJarvis()
  })

  ipcMain.handle(
    'jarvis:submit',
    (_event, note?: string, options?: { includeScreen?: boolean; pin?: boolean }) => {
      submitJarvisNote(note, options)
    }
  )

  ipcMain.handle('jarvis:pin', () => {
    pinJarvisContext()
  })

  ipcMain.handle('snip:gain', () => {
    return getSnipGain()
  })

  setOpenAppHandler(() => {
    showMainWindow()
  })

  setTrayClickHandler(() => {
    if (isCompanionActive()) {
      stopCompanion()
    }
  })

  const settings = getSettings()
  if (settings.cursorKey) {
    void connectCursor(settings.cursorKey).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
    })
  }

  if (settings.trayEnabled) {
    initTray()
  }

  createWindow()

  app.on('activate', function () {
    showMainWindow()
  })
})

app.on('before-quit', () => {
  quitting = true
  stopCompanion()
  void disposeCursor()
})

app.on('window-all-closed', () => {
  if (getSettings().trayEnabled) {
    return
  }
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
