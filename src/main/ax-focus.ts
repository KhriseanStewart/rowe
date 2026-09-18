import koffi from 'koffi'

const REPLY_HINT =
  /reply|respond|comment|message|write|type a|compose|chat|say something|send a|new conversation/i
const SKIP_HINT = /search|filter|find|jump to|reply all/i
const FIELD_ROLES = new Set(['AXTextArea', 'AXTextField', 'AXComboBox'])
const BUTTON_ROLES = new Set(['AXButton', 'AXLink', 'AXMenuItem', 'AXPopUpButton'])

let focusReply: (() => boolean) | undefined

export function focusReplyField(): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  if (!focusReply) {
    try {
      focusReply = createFocuser()
    } catch {
      focusReply = () => false
    }
  }
  try {
    return focusReply()
  } catch {
    return false
  }
}

function createFocuser(): () => boolean {
  const ax = koffi.load(
    '/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices'
  )
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
  const AXUIElementCreateSystemWide = ax.func('AXUIElementCreateSystemWide', 'void *', [])
  const AXUIElementCopyAttributeValue = ax.func(
    'int AXUIElementCopyAttributeValue(void *element, void *attribute, _Out_ void **value)'
  )
  const AXUIElementSetAttributeValue = ax.func(
    'int AXUIElementSetAttributeValue(void *element, void *attribute, void *value)'
  )
  const AXUIElementPerformAction = ax.func('int AXUIElementPerformAction(void *element, void *action)')
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
  const encoding = 0x08000100
  const systemWide = AXUIElementCreateSystemWide()
  const focusedAppAttr = CFStringCreateWithCString(null, 'AXFocusedApplication', encoding)
  const focusedWindowAttr = CFStringCreateWithCString(null, 'AXFocusedWindow', encoding)
  const roleAttr = CFStringCreateWithCString(null, 'AXRole', encoding)
  const titleAttr = CFStringCreateWithCString(null, 'AXTitle', encoding)
  const descAttr = CFStringCreateWithCString(null, 'AXDescription', encoding)
  const placeholderAttr = CFStringCreateWithCString(null, 'AXPlaceholderValue', encoding)
  const childrenAttr = CFStringCreateWithCString(null, 'AXChildren', encoding)
  const visibleChildrenAttr = CFStringCreateWithCString(null, 'AXVisibleChildren', encoding)
  const focusedAttr = CFStringCreateWithCString(null, 'AXFocused', encoding)
  const pressAction = CFStringCreateWithCString(null, 'AXPress', encoding)
  const stringType = CFStringGetTypeID()
  const arrayType = CFArrayGetTypeID()
  let boolTrue: unknown
  try {
    boolTrue = cf.symbol('kCFBooleanTrue') as unknown
  } catch {
    boolTrue = null
  }

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
      const length = Math.min(Number(CFStringGetLength(value)) * 4 + 8, 2048)
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
    for (const attribute of [visibleChildrenAttr, childrenAttr]) {
      const valueOut = [null] as [unknown]
      const ok = AXUIElementCopyAttributeValue(element, attribute, valueOut)
      const array = valueOut[0]
      if (ok !== 0 || !array) {
        continue
      }
      if (CFGetTypeID(array) !== arrayType) {
        CFRelease(array)
        continue
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
    return undefined
  }

  const focus = (element: unknown): boolean => {
    const set = boolTrue ? AXUIElementSetAttributeValue(element, focusedAttr, boolTrue) : 1
    const pressed = AXUIElementPerformAction(element, pressAction)
    return set === 0 || pressed === 0
  }

  return () => {
    const app = copyElement(systemWide, focusedAppAttr)
    const window = app ? copyElement(app, focusedWindowAttr) : null
    if (app) {
      CFRelease(app)
    }
    if (!window) {
      return false
    }

    type Candidate = { element: unknown; score: number; kind: 'field' | 'button' }
    const candidates: Candidate[] = []
    let nodes = 0

    const visit = (element: unknown, depth: number): void => {
      if (!element || nodes > 450 || depth > 16) {
        return
      }
      nodes += 1
      const role = readString(element, roleAttr)
      const hint = [readString(element, titleAttr), readString(element, descAttr), readString(element, placeholderAttr)]
        .join(' ')
        .trim()
      if (SKIP_HINT.test(hint) && !/reply(?! all)/i.test(hint)) {
        const kids = childList(element)
        if (kids) {
          try {
            for (const child of kids.items) {
              visit(child, depth + 1)
            }
          } finally {
            CFRelease(kids.array)
          }
        }
        return
      }
      if (BUTTON_ROLES.has(role) && REPLY_HINT.test(hint) && hint.length < 48) {
        candidates.push({ element, score: /reply|respond|comment/i.test(hint) ? 80 : 40, kind: 'button' })
      }
      if (FIELD_ROLES.has(role)) {
        const score = REPLY_HINT.test(hint) ? 100 : 30
        candidates.push({ element, score, kind: 'field' })
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

    try {
      visit(window, 0)
      const buttons = candidates.filter((item) => item.kind === 'button').sort((a, b) => b.score - a.score)
      if (buttons[0] && focus(buttons[0].element)) {
        return true
      }
      const fields = candidates.filter((item) => item.kind === 'field').sort((a, b) => b.score - a.score)
      return Boolean(fields[0] && focus(fields[0].element))
    } finally {
      CFRelease(window)
    }
  }
}
