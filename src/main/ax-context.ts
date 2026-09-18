import { execFile } from 'child_process'
import { promisify } from 'util'
import koffi from 'koffi'
import { chromeLikeName, readActiveAppInfo, readBrowserPageText } from './app-context'

const execFileAsync = promisify(execFile)

export type ScreenContext = {
  source: 'mail' | 'outlook' | 'ax' | 'selection' | 'clipboard' | 'pin' | 'app' | 'empty'
  appName?: string
  windowTitle?: string
  url?: string
  document?: string
  files?: string[]
  extras?: string
  title?: string
  from?: string
  subject?: string
  text: string
}

const TEXT_LIMIT = 8000
const VISIBLE_LIMIT = 12000

export function readAxHighlight(point: { x: number; y: number }): string {
  return readAxContext(point).selected?.trim() ?? ''
}

export function isBrowserApp(appName: string): boolean {
  return /chrome|safari|arc|brave|edg|firefox|dia|vivaldi|opera|comet|orion/i.test(appName)
}

export async function readBrowserSelection(appName: string): Promise<string> {
  if (process.platform !== 'darwin' || !isBrowserApp(appName)) {
    return ''
  }

  const script = browserSelectionScript(appName)
  if (!script) {
    return ''
  }

  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 2000 })
    return stdout.trim().slice(0, TEXT_LIMIT)
  } catch {
    return ''
  }
}

export async function readScreenContext(input: {
  point: { x: number; y: number }
  appName: string
  selection: string
  clipboard?: string
  highlight?: string
  staleClipboard?: string
}): Promise<ScreenContext> {
  const selected = input.selection.trim()
  const highlighted = input.highlight?.trim() ?? ''
  const clipped = input.clipboard?.trim() ?? ''
  const stale = input.staleClipboard?.trim() ?? ''
  const [app, browser, pageText, mail, outlook] = await Promise.all([
    readActiveAppInfo(input.appName),
    readBrowserSelection(input.appName),
    readBrowserPageText(input.appName),
    readMailSelection(input.appName),
    readOutlookSelection(input.appName)
  ])
  const ax = readAxContext(input.point)
  const visible = [pageText, ax.visible, ax.text].filter(Boolean).join('\n\n')

  let source: ScreenContext['source'] = 'empty'
  let text = ''
  let from = mail?.from ?? outlook?.from
  let subject = mail?.subject ?? outlook?.subject

  if (selected) {
    source = 'selection'
    text = selected
  } else if (highlighted) {
    source = 'selection'
    text = highlighted
  } else if (browser) {
    source = 'selection'
    text = browser
  } else if (mail && mail.text.length > 40) {
    source = 'mail'
    text = mail.text
  } else if (outlook && outlook.text.length > 40) {
    source = 'outlook'
    text = outlook.text
  } else if (clipped && clipped !== stale && !isBrowserApp(input.appName)) {
    source = 'clipboard'
    text = clipped
  } else if (ax.selected) {
    source = 'selection'
    text = ax.selected
  } else if (pageText.trim().length > 20) {
    source = 'ax'
    text = pageText
  } else if (visible.trim().length > 20) {
    source = 'ax'
    text = visible
  } else if (app.windowTitle || app.url || app.document || app.files?.length) {
    source = 'app'
  }

  const extras = joinUnique(
    [
      visible !== text ? visible : '',
      ax.text !== text ? ax.text : '',
      app.windowTitle && app.windowTitle !== text ? app.windowTitle : '',
      subject && subject !== text ? `Subject: ${subject}` : ''
    ].filter(Boolean)
  ).slice(0, VISIBLE_LIMIT)

  return {
    source,
    appName: input.appName,
    windowTitle: app.windowTitle || ax.title,
    url: app.url,
    document: app.document,
    files: app.files,
    extras: extras && extras !== text.trim() ? extras : undefined,
    title: app.windowTitle || ax.title,
    from,
    subject,
    text: text.slice(0, TEXT_LIMIT)
  }
}

export function contextIsThin(context: ScreenContext): boolean {
  let meat = [context.text, context.extras].filter(Boolean).join('\n')
  for (const part of [context.windowTitle, context.appName, context.url, 'WhatsApp']) {
    if (part) {
      meat = meat.split(part).join(' ')
    }
  }
  const compact = meat.replace(/\s+/g, ' ').trim()
  if (compact.length < 120) {
    return true
  }
  return looksLikeSidebarOnly(meat, context)
}

function looksLikeSidebarOnly(text: string, context: ScreenContext): boolean {
  const surface = [context.url, context.windowTitle, context.appName].filter(Boolean).join(' ')
  if (!/whatsapp|slack|discord|telegram|messenger|messages/i.test(surface)) {
    return false
  }
  const lines = text
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const short = lines.filter((line) => line.length < 80).length
  const long = lines.filter((line) => line.length > 110).length
  return short >= 8 && long < 2
}

export function looksLikeMessage(text: string): boolean {
  const value = text.trim()
  if (value.length >= 180) {
    return true
  }
  return /^(from|subject|to|date):/im.test(value)
}

function browserSelectionScript(appName: string): string | undefined {
  const js = 'window.getSelection().toString()'
  if (/safari/i.test(appName) && !/chrome/i.test(appName)) {
    return `tell application "Safari" to do JavaScript "${js}" in front document`
  }
  const app = chromeLikeName(appName)
  if (!app) {
    return undefined
  }
  return `tell application "${app}" to tell active tab of front window to execute javascript "${js}"`
}

async function readMailSelection(appName: string): Promise<ScreenContext | undefined> {
  if (process.platform !== 'darwin' || !/^mail$/i.test(appName.trim())) {
    return undefined
  }

  try {
    const { stdout } = await execFileAsync(
      'osascript',
      [
        '-e',
        `tell application "Mail"
  if (count of selected messages) is 0 then return ""
  set msg to item 1 of (get selected messages)
  set theSender to sender of msg
  set theSubject to subject of msg
  set theContent to content of msg
  return "From: " & theSender & linefeed & "Subject: " & theSubject & linefeed & linefeed & theContent
end tell`
      ],
      { timeout: 2500 }
    )
    const text = stdout.trim()
    if (!text) {
      return undefined
    }
    return {
      source: 'mail',
      from: matchField(text, 'From'),
      subject: matchField(text, 'Subject'),
      text: text.slice(0, TEXT_LIMIT)
    }
  } catch {
    return undefined
  }
}

async function readOutlookSelection(appName: string): Promise<ScreenContext | undefined> {
  if (process.platform !== 'darwin' || !/outlook/i.test(appName)) {
    return undefined
  }

  try {
    const { stdout } = await execFileAsync(
      'osascript',
      [
        '-e',
        `tell application "Microsoft Outlook"
  if (count of selected objects) is 0 then return ""
  set msg to item 1 of (get selected objects)
  try
    set theSender to sender of msg
    set theSubject to subject of msg
    set theContent to content of msg
    return "From: " & theSender & linefeed & "Subject: " & theSubject & linefeed & linefeed & theContent
  on error
    return ""
  end try
end tell`
      ],
      { timeout: 2500 }
    )
    const text = stdout.trim()
    if (!text) {
      return undefined
    }
    return {
      source: 'outlook',
      from: matchField(text, 'From'),
      subject: matchField(text, 'Subject'),
      text: text.slice(0, TEXT_LIMIT)
    }
  } catch {
    return undefined
  }
}

function matchField(text: string, name: string): string | undefined {
  const match = text.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'))
  return match?.[1]?.trim()
}

function joinUnique(parts: string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    const value = part.trim()
    if (!value || seen.has(value)) {
      continue
    }
    seen.add(value)
    out.push(value)
  }
  return out.join('\n\n')
}

type AxSnapshot = { title?: string; text: string; selected?: string; visible?: string }
type AxReader = (point: { x: number; y: number }) => AxSnapshot

let axReader: AxReader | undefined

function readAxContext(point: { x: number; y: number }): AxSnapshot {
  if (process.platform !== 'darwin') {
    return { text: '' }
  }
  if (!axReader) {
    try {
      axReader = createAxReader()
    } catch {
      axReader = () => ({ text: '' })
    }
  }
  try {
    return axReader(point)
  } catch {
    return { text: '' }
  }
}

function createAxReader(): AxReader {
  const ax = koffi.load(
    '/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices'
  )
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
  const AXUIElementCreateSystemWide = ax.func('AXUIElementCreateSystemWide', 'void *', [])
  const AXUIElementCopyElementAtPosition = ax.func(
    'int AXUIElementCopyElementAtPosition(void *app, float x, float y, _Out_ void **element)'
  )
  const AXUIElementCopyAttributeValue = ax.func(
    'int AXUIElementCopyAttributeValue(void *element, void *attribute, _Out_ void **value)'
  )
  const AXUIElementGetPid = ax.func('int AXUIElementGetPid(void *element, _Out_ int *pid)')
  const CFStringCreateWithCString = cf.func(
    'void * CFStringCreateWithCString(void *alloc, const char *value, uint32 encoding)'
  )
  const CFStringGetCString = cf.func(
    'bool CFStringGetCString(void *string, _Out_ char *buffer, int64 size, uint32 encoding)'
  )
  const CFStringGetLength = cf.func('int64 CFStringGetLength(void *string)')
  const CFGetTypeID = cf.func('uint64 CFGetTypeID(void *value)')
  const CFStringGetTypeID = cf.func('uint64 CFStringGetTypeID(void)')
  const CFArrayGetTypeID = cf.func('uint64 CFArrayGetTypeID(void)')
  const CFArrayGetCount = cf.func('int64 CFArrayGetCount(void *array)')
  const CFArrayGetValueAtIndex = cf.func('void * CFArrayGetValueAtIndex(void *array, int64 index)')
  const CFRelease = cf.func('void CFRelease(void *value)')
  const systemWide = AXUIElementCreateSystemWide()
  const encoding = 0x08000100
  const focusedAttr = CFStringCreateWithCString(null, 'AXFocusedUIElement', encoding)
  const focusedAppAttr = CFStringCreateWithCString(null, 'AXFocusedApplication', encoding)
  const focusedWindowAttr = CFStringCreateWithCString(null, 'AXFocusedWindow', encoding)
  const roleAttr = CFStringCreateWithCString(null, 'AXRole', encoding)
  const titleAttr = CFStringCreateWithCString(null, 'AXTitle', encoding)
  const valueAttr = CFStringCreateWithCString(null, 'AXValue', encoding)
  const selectedAttr = CFStringCreateWithCString(null, 'AXSelectedText', encoding)
  const descAttr = CFStringCreateWithCString(null, 'AXDescription', encoding)
  const parentAttr = CFStringCreateWithCString(null, 'AXParent', encoding)
  const visibleChildrenAttr = CFStringCreateWithCString(null, 'AXVisibleChildren', encoding)
  const childrenAttr = CFStringCreateWithCString(null, 'AXChildren', encoding)
  const stringType = CFStringGetTypeID()
  const arrayType = CFArrayGetTypeID()

  const readString = (element: unknown, attribute: unknown): string => {
    const valueOut = [null] as [unknown]
    const ok = AXUIElementCopyAttributeValue(element, attribute, valueOut)
    const value = valueOut[0]
    if (ok !== 0 || !value) {
      return ''
    }
    try {
      if (CFGetTypeID(value) !== stringType) {
        return ''
      }
      const length = Math.min(Number(CFStringGetLength(value)) * 4 + 8, 32_768)
      const buffer = Buffer.alloc(Math.max(length, 64))
      const copied = CFStringGetCString(value, buffer, buffer.length, encoding)
      return copied ? buffer.toString('utf8').replace(/\0.*$/s, '').trim() : ''
    } finally {
      CFRelease(value)
    }
  }

  const copyElement = (element: unknown, attribute: unknown): unknown => {
    const valueOut = [null] as [unknown]
    const ok = AXUIElementCopyAttributeValue(element, attribute, valueOut)
    return ok === 0 ? valueOut[0] : null
  }

  const childList = (element: unknown): { items: unknown[]; array: unknown } | undefined => {
    const tryAttr = (attribute: unknown): { items: unknown[]; array: unknown } | undefined => {
      const valueOut = [null] as [unknown]
      const ok = AXUIElementCopyAttributeValue(element, attribute, valueOut)
      const array = valueOut[0]
      if (ok !== 0 || !array) {
        return undefined
      }
      if (CFGetTypeID(array) !== arrayType) {
        CFRelease(array)
        return undefined
      }
      const count = Math.min(Number(CFArrayGetCount(array)), 80)
      const items: unknown[] = []
      for (let index = 0; index < count; index += 1) {
        const item = CFArrayGetValueAtIndex(array, index)
        if (item) {
          items.push(item)
        }
      }
      return { items, array }
    }
    return tryAttr(visibleChildrenAttr) ?? tryAttr(childrenAttr)
  }

  const harvest = (root: unknown): string => {
    if (!root) {
      return ''
    }
    const chunks: string[] = []
    const seen = new Set<string>()
    let nodes = 0

    const visit = (element: unknown, depth: number): void => {
      if (!element || nodes > 450 || depth > 16 || chunks.join('\n').length >= VISIBLE_LIMIT) {
        return
      }
      nodes += 1
      const value = readString(element, valueAttr)
      const selected = readString(element, selectedAttr)
      const heading = readString(element, titleAttr)
      const description = readString(element, descAttr)
      for (const part of [selected, value, heading, description]) {
        if (part.length < 2 || seen.has(part)) {
          continue
        }
        seen.add(part)
        chunks.push(part)
      }
      const kids = childList(element)
      if (!kids) {
        return
      }
      try {
        for (const child of kids.items) {
          visit(child, depth + 1)
        }
      } finally {
        CFRelease(kids.array)
      }
    }

    visit(root, 0)
    return joinUnique(chunks).slice(0, VISIBLE_LIMIT)
  }

  const pidOf = (element: unknown): number => {
    if (!element) {
      return 0
    }
    const pidOut = [0] as [number]
    const ok = AXUIElementGetPid(element, pidOut)
    return ok === 0 ? pidOut[0] : 0
  }

  const walk = (start: unknown): AxSnapshot => {
    let element = start
    if (!element) {
      return { text: '' }
    }

    const chunks: string[] = []
    const selectedParts: string[] = []
    let title = ''

    try {
      for (let depth = 0; depth < 12; depth += 1) {
        const role = readString(element, roleAttr)
        const selected = readString(element, selectedAttr)
        const value = readString(element, valueAttr)
        const description = readString(element, descAttr)
        const heading = readString(element, titleAttr)
        if (heading && !title) {
          title = heading
        }
        if (selected.length > 1) {
          selectedParts.push(selected)
        }
        for (const part of [selected, value, description, heading]) {
          if (part && part.length > 1 && !chunks.includes(part)) {
            chunks.push(part)
          }
        }
        if (role === 'AXWindow' || role === 'AXApplication') {
          break
        }
        const parent = copyElement(element, parentAttr)
        if (!parent) {
          break
        }
        CFRelease(element)
        element = parent
      }
    } finally {
      if (element) {
        CFRelease(element)
      }
    }

    const selected = selectedParts.sort((left, right) => right.length - left.length)[0]
    return {
      title: title || undefined,
      selected,
      text: joinUnique(chunks).slice(0, TEXT_LIMIT)
    }
  }

  return (point) => {
    const focusedApp = copyElement(systemWide, focusedAppAttr)
    const focusedWindow = focusedApp ? copyElement(focusedApp, focusedWindowAttr) : null
    const visible = harvest(focusedWindow)
    if (focusedWindow) {
      CFRelease(focusedWindow)
    }
    if (focusedApp) {
      CFRelease(focusedApp)
    }

    const focused = copyElement(systemWide, focusedAttr)
    const atPointOut = [null] as [unknown]
    const found = AXUIElementCopyElementAtPosition(systemWide, point.x, point.y, atPointOut)
    const atPoint = found === 0 ? atPointOut[0] : null
    const pointPid = pidOf(atPoint)
    const focusPid = pidOf(focused)
    const sameApp = Boolean(pointPid && focusPid && pointPid === focusPid)
    const visibleAtPoint = atPoint ? harvest(atPoint) : ''

    const fromPoint = atPoint ? walk(atPoint) : { text: '' }
    let fromFocus: AxSnapshot = { text: '' }
    if (focused && focused !== atPoint) {
      if (sameApp) {
        fromFocus = walk(focused)
      } else {
        CFRelease(focused)
      }
    }

    return {
      title: fromPoint.title || fromFocus.title,
      selected: fromPoint.selected || (sameApp ? fromFocus.selected : undefined),
      visible: [visibleAtPoint, visible].filter(Boolean).join('\n\n') || undefined,
      text: (fromPoint.selected || fromPoint.text || (sameApp ? fromFocus.text : '')).slice(
        0,
        TEXT_LIMIT
      )
    }
  }
}
