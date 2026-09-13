import { execFile } from 'child_process'
import { promisify } from 'util'
import koffi from 'koffi'

const execFileAsync = promisify(execFile)

export type ScreenContext = {
  source: 'mail' | 'outlook' | 'ax' | 'selection' | 'pin' | 'empty'
  title?: string
  from?: string
  subject?: string
  text: string
}

const TEXT_LIMIT = 8000

export async function readScreenContext(input: {
  point: { x: number; y: number }
  appName: string
  selection: string
}): Promise<ScreenContext> {
  const mail = await readMailSelection(input.appName)
  if (mail && mail.text.length > 40) {
    return mail
  }

  const outlook = await readOutlookSelection(input.appName)
  if (outlook && outlook.text.length > 40) {
    return outlook
  }

  const ax = readAxContext(input.point)
  const combined = joinUnique([input.selection.trim(), ax.text])
  if (combined.length > 20) {
    return {
      source: ax.text.length >= input.selection.trim().length ? 'ax' : 'selection',
      title: ax.title,
      text: combined.slice(0, TEXT_LIMIT)
    }
  }

  if (input.selection.trim()) {
    return { source: 'selection', text: input.selection.trim().slice(0, TEXT_LIMIT) }
  }

  return { source: 'empty', text: '' }
}

export function looksLikeMessage(text: string): boolean {
  const value = text.trim()
  if (value.length >= 180) {
    return true
  }
  return /^(from|subject|to|date):/im.test(value)
}

async function readMailSelection(_appName: string): Promise<ScreenContext | undefined> {
  if (process.platform !== 'darwin' || !(await appIsRunning('Mail'))) {
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

async function appIsRunning(name: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'osascript',
      ['-e', `tell application "System Events" to (name of processes) contains "${name}"`],
      { timeout: 1200 }
    )
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

async function readOutlookSelection(_appName: string): Promise<ScreenContext | undefined> {
  if (process.platform !== 'darwin' || !(await appIsRunning('Microsoft Outlook'))) {
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

type AxReader = (point: { x: number; y: number }) => { title?: string; text: string }

let axReader: AxReader | undefined

function readAxContext(point: { x: number; y: number }): { title?: string; text: string } {
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
  const CFStringCreateWithCString = cf.func(
    'void * CFStringCreateWithCString(void *alloc, const char *value, uint32 encoding)'
  )
  const CFStringGetCString = cf.func(
    'bool CFStringGetCString(void *string, _Out_ char *buffer, int64 size, uint32 encoding)'
  )
  const CFStringGetLength = cf.func('int64 CFStringGetLength(void *string)')
  const CFGetTypeID = cf.func('uint64 CFGetTypeID(void *value)')
  const CFStringGetTypeID = cf.func('uint64 CFStringGetTypeID(void)')
  const CFRelease = cf.func('void CFRelease(void *value)')
  const systemWide = AXUIElementCreateSystemWide()
  const encoding = 0x08000100
  const focusedAttr = CFStringCreateWithCString(null, 'AXFocusedUIElement', encoding)
  const roleAttr = CFStringCreateWithCString(null, 'AXRole', encoding)
  const titleAttr = CFStringCreateWithCString(null, 'AXTitle', encoding)
  const valueAttr = CFStringCreateWithCString(null, 'AXValue', encoding)
  const selectedAttr = CFStringCreateWithCString(null, 'AXSelectedText', encoding)
  const descAttr = CFStringCreateWithCString(null, 'AXDescription', encoding)
  const parentAttr = CFStringCreateWithCString(null, 'AXParent', encoding)
  const stringType = CFStringGetTypeID()

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

  return (point) => {
    let element = copyElement(systemWide, focusedAttr)
    if (!element) {
      const elementOut = [null] as [unknown]
      const found = AXUIElementCopyElementAtPosition(systemWide, point.x, point.y, elementOut)
      element = found === 0 ? elementOut[0] : null
    }
    if (!element) {
      return { text: '' }
    }

    const chunks: string[] = []
    let title = ''

    try {
      for (let depth = 0; depth < 10; depth += 1) {
        const role = readString(element, roleAttr)
        const selected = readString(element, selectedAttr)
        const value = readString(element, valueAttr)
        const description = readString(element, descAttr)
        const heading = readString(element, titleAttr)
        if (heading && !title) {
          title = heading
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

    return {
      title: title || undefined,
      text: joinUnique(chunks).slice(0, TEXT_LIMIT)
    }
  }
}
