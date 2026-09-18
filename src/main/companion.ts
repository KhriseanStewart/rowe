import { BrowserWindow, desktopCapturer, globalShortcut, screen, systemPreferences } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { hideTrayWindow } from './tray-window'
import { sendCursorPrompt, getCursorApiKey } from './cursor'
import { getCursorAppearance } from './cursor-kind'
import { answerWithRag, ragIsConfigured, trimChatHistory, type ChatTurn } from './rag/system-ai'
import { selectedReadyProjects } from './rag/projects'
import { resolveProjectsForQuestion } from './rag/workspace'
import { getSettings, updateSettings, planAllowsAskLocal, recordLocalPlanUsage, type CompanionAi } from './settings'
import { askShortcut, getFrontmostApp, glassWindowOptions, readQuotedText } from './platform'
import {
  contextIsThin,
  isBrowserApp,
  readAxHighlight,
  readScreenContext,
  type ScreenContext
} from './ax-context'
import { loadPinnedContext, savePinnedContext } from './pinned-context'
import { copyDraft, insertDraft } from './insert-reply'

const ASK_SHORTCUT = askShortcut()
const JARVIS_SIZES = {
  pulse: { width: 280, height: 196 },
  pick: { width: 320, height: 268 },
  compose: { width: 320, height: 204 },
  searching: { width: 280, height: 196 },
  answer: { width: 336, height: 348 }
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
  canInsert?: boolean
  canReply?: boolean
  cursorReady?: boolean
  ragReady?: boolean
  engine?: CompanionAi
  pickError?: string
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
let picking = false
let companionEngine: CompanionAi | undefined
let companionHistory: ChatTurn[] = []
let asking = false
let composing = false
let pendingAsk: PendingAsk | undefined
let pointerTimer: ReturnType<typeof setInterval> | undefined
let lastQuote = ''
let lastAsk: PendingAsk | undefined
let lastInsert:
  | {
      text: string
      appName: string
      source?: ScreenContext['source']
      url?: string
      windowTitle?: string
    }
  | undefined

export function isCompanionActive(): boolean {
  return active
}

export function startCompanion(): void {
  if (active) {
    return
  }

  active = true
  picking = true
  companionEngine = undefined
  companionHistory = []
  if (process.platform === 'darwin') {
    systemPreferences.isTrustedAccessibilityClient(true)
  }

  hideTrayWindow()
  createCursorWindow()
  createJarvisWindow()
  startPointerLoop()
  emitStatus()

  const pick = (): void => {
    if (active && picking) {
      showCompanionPick()
    }
  }

  if (jarvisWindow?.webContents.isLoading()) {
    jarvisWindow.webContents.once('did-finish-load', pick)
  } else {
    pick()
  }
}

export async function selectCompanionAi(engine: CompanionAi): Promise<void> {
  if (!active || !picking) {
    return
  }

  if (engine === 'cursor' && !getCursorApiKey()) {
    showCompanionPick('Connect Cursor in Rowe first.')
    return
  }
  if (engine === 'system') {
    if (!ragIsConfigured()) {
      showCompanionPick('Add an OpenRouter or OmniRoute key in .env, then restart Rowe.')
      return
    }
    const projects = await selectedReadyProjects()
    if (!projects.length) {
      showCompanionPick('Select indexed reference projects in Rowe first.')
      return
    }
  }

  companionEngine = engine
  picking = false
  updateSettings({ companionAi: engine })

  if (
    !globalShortcut.register(ASK_SHORTCUT, () => {
      void askCompanion()
    })
  ) {
    console.error(`Could not register ${ASK_SHORTCUT}`)
  }

  showJarvisPulse()
}

function showCompanionPick(pickError?: string): void {
  const point = screen.getCursorScreenPoint()
  showJarvis('pick', point, true)
  void selectedReadyProjects().then((projects) => {
    sendJarvis({
      status: 'pick',
      text: '',
      appName: '',
      cursorReady: Boolean(getCursorApiKey()),
      ragReady: ragIsConfigured() && projects.length > 0,
      engine: getSettings().companionAi,
      pickError
    })
  })
}

export function stopCompanion(): void {
  if (!active) {
    return
  }

  active = false
  picking = false
  companionEngine = undefined
  companionHistory = []
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
  if (picking) {
    stopCompanion()
    return
  }
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

export function insertJarvisDraft(mode: 'paste' | 'reply' = 'paste'): void {
  void finishInsert(mode)
}

export function copyJarvisDraft(): string {
  if (!lastInsert?.text.trim()) {
    return ''
  }
  return copyDraft(lastInsert.text)
}

async function askCompanion(): Promise<void> {
  if (!active || asking || picking || !companionEngine) {
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
    const highlight = readAxHighlight(point)
    const quoted = await readQuotedText()
    const live = await readScreenContext({
      point,
      appName,
      selection: quoted.selection,
      clipboard: quoted.clipboard,
      highlight,
      staleClipboard: lastQuote
    })
    const pinned = loadPinnedContext()
    const context = pickContext(live, pinned, appName)
    lastQuote = context.text.trim()
    pendingAsk = { point, appName, context }
    lastAsk = pendingAsk
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
  const pending = pendingAsk ?? lastAsk
  if (!active || asking || !pending || !companionEngine) {
    return
  }

  composing = false
  asking = true
  pendingAsk = pending
  lastAsk = pending

  const { point, appName, context } = pending
  if (options?.pin && context.text.trim()) {
    savePinnedContext(context)
  }

  showJarvis('searching', point)
  sendJarvis({ status: 'searching', text: '', appName })

  try {
    const intent = askIntent(note)
    const thin = contextIsThin(context)
    const image = options?.includeScreen || thin ? await captureDisplayAt(point) : undefined
    const prompt = buildPrompt(appName, context, note, Boolean(image), thin && Boolean(image), intent)
    let output = ''
    const onDelta = (chunk: string): void => {
      output += chunk
      showJarvis('answer', point)
      sendJarvis(answerPayload(output, appName, context.source, intent))
    }
    const imagePayload = image ? { data: image, mimeType: 'image/jpeg' } : undefined
    let final = ''
    if (companionEngine === 'system') {
      const allowed = planAllowsAskLocal()
      if (!allowed.ok) {
        throw new Error(allowed.message)
      }
      const projects = await selectedReadyProjects()
      if (!ragIsConfigured()) {
        throw new Error('Configure OmniRoute or OpenRouter credentials for System AI.')
      }
      const question = ragQuestion(note, context, appName)
      const resolved = await resolveProjectsForQuestion(
        question,
        projects.map((project) => project.id),
        companionHistory
      )
      const result = await answerWithRag({
        question,
        projectIds: resolved.projectIds,
        subjectIds: resolved.subjectIds,
        referenceIds: resolved.referenceIds,
        liveContext: prompt,
        image: imagePayload,
        history: companionHistory,
        resolutionNote: resolved.note,
        onDelta
      })
      final = result.text
      if (result.usage) {
        recordLocalPlanUsage({
          openRouterSpendUsd: result.usage.costUsd,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          askCount: 1,
          source: 'companion-system'
        })
      } else {
        recordLocalPlanUsage({ askCount: 1, source: 'companion-system' })
      }
    } else {
      const allowed = planAllowsAskLocal()
      if (!allowed.ok) {
        throw new Error(allowed.message)
      }
      final = await sendCursorPrompt(prompt, onDelta, imagePayload ? [imagePayload] : undefined)
      recordLocalPlanUsage({ askCount: 1, source: 'companion-cursor' })
    }

    const text = final.trim() || output.trim() || 'No response.'
    if (companionEngine === 'system') {
      companionHistory = trimChatHistory([
        ...companionHistory,
        { role: 'user', content: note?.trim() || ragQuestion(note, context, appName) },
        { role: 'assistant', content: text }
      ])
    }
    lastInsert = {
      text,
      appName,
      source: context.source,
      url: context.url,
      windowTitle: context.windowTitle
    }
    sendJarvis(answerPayload(text, appName, context.source, intent))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Signal lost.'
    showJarvis('answer', point)
    sendJarvis({ status: 'error', text: message, appName })
  } finally {
    asking = false
    pendingAsk = pending
  }
}

function ragQuestion(note: string | undefined, context: ScreenContext, appName: string): string {
  return [
    note?.trim(),
    context.subject,
    context.windowTitle,
    context.document,
    context.appName || appName,
    context.text.trim().slice(0, 800)
  ]
    .filter(Boolean)
    .join('\n')
}

function buildPrompt(
  appName: string,
  context: ScreenContext,
  note?: string,
  hasImage = false,
  usedScreenFallback = false,
  intent: 'ask' | 'draft' = 'ask'
): string {
  const extra = note?.trim()
  const quoted = context.text.trim().slice(0, 8000)
  const draft = intent === 'draft'
  const source =
    context.source === 'selection'
      ? 'highlighted text'
      : context.source === 'clipboard'
        ? 'clipboard'
        : context.source === 'pin'
          ? 'pinned text'
          : context.source === 'app'
            ? 'the focused app'
            : `text from ${appName || 'the current app'}`

  const parts = [
    extra
      ? `The user asked:\n${extra}`
      : draft
        ? 'Draft a reply using the focused app context.'
        : 'Answer using the focused app context below.'
  ]

  const appLines = [
    `App: ${context.appName || appName || 'unknown'}`,
    context.windowTitle ? `Window: ${context.windowTitle}` : '',
    context.url ? `URL: ${context.url}` : '',
    context.document ? `Document: ${context.document}` : '',
    context.files?.length ? `Files:\n${context.files.join('\n')}` : '',
    context.from ? `From: ${context.from}` : '',
    context.subject ? `Subject: ${context.subject}` : ''
  ].filter(Boolean)
  if (appLines.length) {
    parts.push(`Focused Mac app when they pressed the shortcut:\n${appLines.join('\n')}`)
  }

  if (quoted) {
    parts.push(`Primary ${source}:\n"""\n${quoted}\n"""`)
  }

  if (context.extras && context.extras.trim() !== quoted) {
    parts.push(`More text from that app window:\n"""\n${context.extras.trim()}\n"""`)
  }

  if (!quoted && !context.extras && !hasImage && !appLines.length) {
    parts.push('No app or highlighted text was available.')
  }

  if (hasImage) {
    parts.push(
      usedScreenFallback
        ? 'A screenshot of the focused screen is attached because little text could be read. Read the visible chat, names, and messages from the image.'
        : 'A screenshot is attached only as backup. Prefer the text and app context.'
    )
  }

  parts.push(
    [
      'Rules:',
      '- Use the focused app, window title, URL, document, highlight, and nearby text as context.',
      '- Highlighted text is the best source of facts when present. Do not invent numbers or visit other pages.',
      '- If the quote says a percent used, say that percent and the remaining percent. Example: 86% used means about 14% left of that quota.',
      draft
        ? '- They asked for a draft. Put the sendable reply only inside a ```reply fenced block. One short message. No analysis inside the fence.'
        : '- This is a question. Answer it. Do not draft a chat or email. Do not use a ```reply block.',
      draft
        ? '- If you explain first, keep that outside the ```reply block. Paste uses only that block.'
        : '- Do not offer paste-ready alternatives unless they asked you to write a reply.',
      '- If the context does not contain the answer, say exactly what it shows and what it does not.',
      '- Never send a message.',
      '- Do not ask the user to paste text or send a picture.'
    ].join('\n')
  )

  return parts.join('\n\n')
}

function askIntent(note?: string): 'ask' | 'draft' {
  const extra = note?.trim() ?? ''
  if (!extra) {
    return 'ask'
  }
  if (looksLikeQuestion(extra) && !/\b(draft|reply|respond|write back)\b/i.test(extra)) {
    return 'ask'
  }
  if (wantsDraft(extra)) {
    return 'draft'
  }
  return 'ask'
}

function wantsDraft(note: string): boolean {
  return /\b(draft|reply|respond|write back|text them|write (them )?a (reply|message))\b/i.test(
    note
  )
}

function looksLikeQuestion(note: string): boolean {
  return /^(how|what|why|who|when|where|is|are|can|does|do|did|should|explain|tell me|summarize|what's|whats)\b/i.test(
    note
  )
}

function pickContext(
  live: ScreenContext,
  pinned: ScreenContext | undefined,
  appName: string
): ScreenContext {
  if (live.text.trim() || live.url || live.windowTitle || live.document) {
    return live
  }
  if (pinned && !isBrowserApp(appName)) {
    return {
      ...pinned,
      appName: live.appName || pinned.appName,
      windowTitle: live.windowTitle || pinned.windowTitle,
      url: live.url || pinned.url
    }
  }
  return live
}

async function finishInsert(mode: 'paste' | 'reply'): Promise<void> {
  const current = lastInsert
  if (!current?.text.trim() || asking) {
    return
  }

  hideJarvis()
  setCursorWindowVisible(false)
  try {
    await insertDraft({
      text: current.text,
      appName: current.appName,
      mode,
      url: current.url,
      windowTitle: current.windowTitle
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not insert the draft.'
    const point = screen.getCursorScreenPoint()
    showJarvis('answer', point)
    sendJarvis({ status: 'error', text: message, appName: current.appName })
  } finally {
    if (active) {
      setCursorWindowVisible(true)
    }
  }
}

function answerPayload(
  text: string,
  appName: string,
  source?: ScreenContext['source'],
  intent: 'ask' | 'draft' = 'ask'
): JarvisPayload {
  const drafting = intent === 'draft' && Boolean(text.trim())
  return {
    status: 'answer',
    text,
    appName,
    source,
    canInsert: drafting,
    canReply: drafting
  }
}

function composePayload(appName: string, context: ScreenContext, hasPin: boolean): JarvisPayload {
  const headline =
    [context.from, context.subject].filter(Boolean).join(' · ') ||
    context.windowTitle ||
    context.title ||
    context.url ||
    context.document ||
    context.text.replace(/\s+/g, ' ').trim().slice(0, 120)

  const labels: Record<ScreenContext['source'], string> = {
    mail: 'Read from Mail',
    outlook: 'Read from Outlook',
    ax: 'Read from this window',
    selection: 'Highlighted',
    clipboard: 'Clipboard',
    pin: 'Pinned thread',
    app: context.appName ? `From ${context.appName}` : 'From this app',
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
  sendJarvis({
    status: 'pulse',
    text: companionEngine === 'system' ? 'System AI' : 'Cursor',
    appName: '',
    engine: companionEngine
  })

  setTimeout(() => {
    if (active && !asking && !composing && !picking) {
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
