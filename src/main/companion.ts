import { BrowserWindow, desktopCapturer, globalShortcut, screen, systemPreferences } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { hideTrayWindow } from './tray-window'
import { sendCursorPrompt } from './cursor'
import { getCursorAppearance } from './cursor-kind'
import { askShortcut, copySelection, getFrontmostApp, glassWindowOptions } from './platform'
import { looksLikeMessage, readScreenContext, type ScreenContext } from './ax-context'
import { loadPinnedContext, savePinnedContext } from './pinned-context'

const ASK_SHORTCUT = askShortcut()
const JARVIS_SIZES = {
  pulse: { width: 248, height: 76 },
  compose: { width: 320, height: 188 },
  searching: { width: 268, height: 92 },
  answer: { width: 312, height: 248 }
}

export type JarvisAskOptions = {
  includeScreen?: boolean
  pin?: boolean
}

type JarvisPayload = {
  status: string
  text: string
  appName: string
  source?: ScreenContext['source']
  canPin?: boolean
}

type PendingAsk = {
  point: { x: number; y: number }
  appName: string
  context: ScreenContext
}

const CURSOR_WINDOW = { width: 32, height: 32 }
const CURSOR_OFFSET: Record<string, { x: number; y: number }> = {
  pointer: { x: 16, y: 14 },
  text: { x: 14, y: -6 },
  hand: { x: 16, y: 12 },
  cross: { x: 16, y: -4 },
  move: { x: 16, y: 6 },
  'resize-ns': { x: 16, y: -4 },
  'resize-ew': { x: 16, y: -4 },
  'resize-nwse': { x: 16, y: 6 },
  'resize-nesw': { x: 16, y: 6 },
  busy: { x: 16, y: 10 }
}

let cursorWindow: BrowserWindow | undefined
let jarvisWindow: BrowserWindow | undefined
let active = false
let asking = false
let composing = false
let pendingAsk: PendingAsk | undefined
let pointerTimer: ReturnType<typeof setInterval> | undefined

export function isCompanionActive(): boolean {
  return active
}

export function startCompanion(): void {
  if (active) {
    return
  }

  active = true
  if (process.platform === 'darwin') {
    systemPreferences.isTrustedAccessibilityClient(true)
  }

  hideTrayWindow()
  createCursorWindow()
  createJarvisWindow()
  startPointerLoop()

  if (
    !globalShortcut.register(ASK_SHORTCUT, () => {
      void askCompanion()
    })
  ) {
    console.error(`Could not register ${ASK_SHORTCUT}`)
  }

  emitStatus()

  const pulse = (): void => {
    if (active && !asking) {
      showJarvisPulse()
    }
  }

  if (jarvisWindow?.webContents.isLoading()) {
    jarvisWindow.webContents.once('did-finish-load', pulse)
  } else {
    pulse()
  }
}

export function stopCompanion(): void {
  if (!active) {
    return
  }

  active = false
  asking = false
  composing = false
  pendingAsk = undefined
  stopPointerLoop()
  globalShortcut.unregister(ASK_SHORTCUT)
  hideJarvis()
  closeCursorWindow()
  emitStatus()
}

export function hideJarvis(): void {
  if (!asking) {
    composing = false
    pendingAsk = undefined
  }
  jarvisWindow?.hide()
}

export function submitJarvisNote(note?: string, options?: JarvisAskOptions): void {
  void finishAsk(note, options)
}

export function pinJarvisContext(): void {
  if (!pendingAsk?.context.text.trim()) {
    return
  }
  savePinnedContext(pendingAsk.context)
  sendJarvis(composePayload(pendingAsk.appName, pendingAsk.context, true))
}

async function askCompanion(): Promise<void> {
  if (!active || asking) {
    return
  }

  if (composing && pendingAsk) {
    focusJarvis()
    return
  }

  const point = screen.getCursorScreenPoint()
  const appName = await getFrontmostApp()

  setCursorWindowVisible(false)
  await delay(40)

  try {
    const selection = await copySelection()
    const live = await readScreenContext({ point, appName, selection })
    const pinned = loadPinnedContext()
    const context = pickContext(live, pinned)
    pendingAsk = { point, appName, context }
    composing = true
    showJarvis('compose', point, true)
    sendJarvis(composePayload(appName, context, Boolean(pinned)))
  } catch (error) {
    composing = false
    pendingAsk = undefined
    const message = error instanceof Error ? error.message : 'Signal lost.'
    showJarvis('answer', point)
    sendJarvis({ status: 'error', text: message, appName })
  } finally {
    if (active) {
      setCursorWindowVisible(true)
    }
  }
}

async function finishAsk(note?: string, options?: JarvisAskOptions): Promise<void> {
  const pending = pendingAsk
  if (!active || asking || !pending) {
    return
  }

  composing = false
  asking = true
  pendingAsk = undefined

  const { point, appName, context } = pending
  if (options?.pin && context.text.trim()) {
    savePinnedContext(context)
  }

  showJarvis('searching', point)
  sendJarvis({ status: 'searching', text: '', appName })

  try {
    const image = options?.includeScreen ? await captureDisplayAt(point) : undefined
    const prompt = buildPrompt(appName, context, note, Boolean(image))
    let output = ''

    await sendCursorPrompt(
      prompt,
      (chunk) => {
        output += chunk
        showJarvis('answer', point)
        sendJarvis({ status: 'answer', text: output, appName })
      },
      image ? [{ data: image, mimeType: 'image/jpeg' }] : undefined
    )

    if (!output) {
      sendJarvis({ status: 'answer', text: 'No response.', appName })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Signal lost.'
    showJarvis('answer', point)
    sendJarvis({ status: 'error', text: message, appName })
  } finally {
    asking = false
  }
}

function buildPrompt(
  appName: string,
  context: ScreenContext,
  note?: string,
  hasImage = false
): string {
  const extra = note?.trim()
  const parts = [
    context.source === 'pin'
      ? 'Reply using the pinned thread below. The user may no longer be looking at it.'
      : `In ${appName || 'the current app'}.`
  ]

  if (context.from) {
    parts.push(`From: ${context.from}`)
  }
  if (context.subject) {
    parts.push(`Subject: ${context.subject}`)
  }
  if (context.title && !context.subject) {
    parts.push(`Title: ${context.title}`)
  }
  if (context.text.trim()) {
    parts.push(`Thread:\n${context.text.trim().slice(0, 8000)}`)
  } else if (!hasImage) {
    parts.push(
      'No on-screen text could be read. Ask for the missing details instead of requesting a screenshot.'
    )
  }

  if (extra) {
    parts.push(extra)
  }

  if (hasImage) {
    parts.push('A screenshot is attached as a last resort. Prefer the thread text above.')
  }

  parts.push(
    'Be concise and practical. Draft from the thread text; do not ask the user to paste or send a picture.'
  )
  return parts.join('\n\n')
}

function pickContext(live: ScreenContext, pinned?: ScreenContext): ScreenContext {
  if (looksLikeMessage(live.text)) {
    return live
  }
  if (pinned && live.text.trim().length < 80) {
    return pinned
  }
  return live.text.trim() ? live : (pinned ?? live)
}

function composePayload(appName: string, context: ScreenContext, hasPin: boolean): JarvisPayload {
  const headline =
    [context.from, context.subject].filter(Boolean).join(' · ') ||
    context.title ||
    context.text.replace(/\s+/g, ' ').trim().slice(0, 120)

  const labels: Record<ScreenContext['source'], string> = {
    mail: 'Read from Mail',
    outlook: 'Read from Outlook',
    ax: 'Read from this window',
    selection: 'Selected text',
    pin: 'Pinned thread',
    empty: hasPin ? 'Nothing here — using pin' : 'No text found'
  }

  return {
    status: 'compose',
    text: headline || labels[context.source],
    appName,
    source: context.source,
    canPin: Boolean(context.text.trim())
  }
}

function showJarvisPulse(): void {
  const point = screen.getCursorScreenPoint()
  showJarvis('pulse', point)
  sendJarvis({ status: 'pulse', text: '', appName: '' })

  setTimeout(() => {
    if (active && !asking && !composing) {
      hideJarvis()
    }
  }, 1800)
}

function showJarvis(
  mode: keyof typeof JARVIS_SIZES,
  point: { x: number; y: number },
  focus = false
): void {
  if (!jarvisWindow || jarvisWindow.isDestroyed()) {
    createJarvisWindow()
  }
  if (!jarvisWindow) {
    return
  }

  const { width, height } = JARVIS_SIZES[mode]
  const keepPlace = jarvisWindow.isVisible() && (mode === 'searching' || mode === 'answer')

  if (keepPlace) {
    const { x, y } = jarvisWindow.getBounds()
    jarvisWindow.setBounds({ x, y, width, height }, false)
  } else {
    const { workArea } = screen.getDisplayNearestPoint(point)
    const x = Math.min(
      Math.max(point.x + 22, workArea.x + 8),
      workArea.x + workArea.width - width - 8
    )
    const y = Math.min(
      Math.max(point.y + 18, workArea.y + 8),
      workArea.y + workArea.height - height - 8
    )
    jarvisWindow.setBounds({ x, y, width, height }, false)
  }
  jarvisWindow.setAlwaysOnTop(true, 'screen-saver', 1)

  if (focus) {
    focusJarvis()
  } else {
    jarvisWindow.showInactive()
  }
}

function focusJarvis(): void {
  if (!jarvisWindow || jarvisWindow.isDestroyed()) {
    return
  }

  jarvisWindow.show()
  jarvisWindow.focus()
  jarvisWindow.webContents.focus()
}

function sendJarvis(payload: JarvisPayload): void {
  if (!jarvisWindow || jarvisWindow.isDestroyed()) {
    return
  }

  jarvisWindow.webContents.send('jarvis:state', payload)
}

function createJarvisWindow(): void {
  if (jarvisWindow && !jarvisWindow.isDestroyed()) {
    return
  }

  jarvisWindow = new BrowserWindow({
    width: JARVIS_SIZES.pulse.width,
    height: JARVIS_SIZES.pulse.height,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    focusable: true,
    transparent: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    ...glassWindowOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  jarvisWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  jarvisWindow.setAlwaysOnTop(true, 'screen-saver', 1)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    jarvisWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/jarvis.html`)
  } else {
    jarvisWindow.loadFile(join(__dirname, '../renderer/jarvis.html'))
  }

  jarvisWindow.on('closed', () => {
    jarvisWindow = undefined
  })
}

function createCursorWindow(): void {
  if (cursorWindow && !cursorWindow.isDestroyed()) {
    return
  }

  cursorWindow = new BrowserWindow({
    width: CURSOR_WINDOW.width,
    height: CURSOR_WINDOW.height,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    focusable: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  cursorWindow.setIgnoreMouseEvents(true, { forward: true })
  cursorWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  cursorWindow.setAlwaysOnTop(true, 'screen-saver', 1)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    cursorWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay.html`)
  } else {
    cursorWindow.loadFile(join(__dirname, '../renderer/overlay.html'))
  }

  cursorWindow.once('ready-to-show', () => {
    cursorWindow?.showInactive()
  })

  cursorWindow.on('closed', () => {
    cursorWindow = undefined
  })
}

function closeCursorWindow(): void {
  if (cursorWindow && !cursorWindow.isDestroyed()) {
    cursorWindow.close()
  }
  cursorWindow = undefined
}

function setCursorWindowVisible(visible: boolean): void {
  if (!cursorWindow || cursorWindow.isDestroyed()) {
    return
  }
  if (visible) {
    cursorWindow.showInactive()
  } else {
    cursorWindow.hide()
  }
}

async function captureDisplayAt(point: { x: number; y: number }): Promise<string> {
  const display = screen.getDisplayNearestPoint(point)
  const width = Math.round(display.size.width * display.scaleFactor)
  const height = Math.round(display.size.height * display.scaleFactor)
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  })

  const source =
    sources.find((item) => item.display_id === String(display.id)) ??
    sources.find((item) => item.id.includes(String(display.id))) ??
    sources[0]

  if (!source) {
    throw new Error('Could not capture the screen')
  }

  const image = source.thumbnail
  const size = image.getSize()
  const maxEdge = 1280
  const scaled =
    size.width > maxEdge || size.height > maxEdge
      ? image.resize({
          width:
            size.width >= size.height ? maxEdge : Math.round((size.width / size.height) * maxEdge),
          height:
            size.height > size.width ? maxEdge : Math.round((size.height / size.width) * maxEdge)
        })
      : image

  return scaled.toJPEG(68).toString('base64')
}

function startPointerLoop(): void {
  stopPointerLoop()
  pointerTimer = setInterval(() => {
    if (!cursorWindow || cursorWindow.isDestroyed()) {
      return
    }

    const point = screen.getCursorScreenPoint()
    const appearance = getCursorAppearance(point)
    const offset = CURSOR_OFFSET[appearance.kind] ?? CURSOR_OFFSET.pointer
    cursorWindow.setBounds(
      {
        x: Math.round(point.x + offset.x),
        y: Math.round(point.y + offset.y),
        width: CURSOR_WINDOW.width,
        height: CURSOR_WINDOW.height
      },
      false
    )
    cursorWindow.webContents.send('companion:pointer', {
      x: 0,
      y: 0,
      kind: appearance.kind
    })
  }, 16)
}

function stopPointerLoop(): void {
  if (pointerTimer) {
    clearInterval(pointerTimer)
    pointerTimer = undefined
  }
}

function emitStatus(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('companion:status', { active })
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
