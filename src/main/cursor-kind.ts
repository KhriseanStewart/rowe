import { nativeImage } from 'electron'
import koffi from 'koffi'

export type CursorKind =
  | 'pointer'
  | 'text'
  | 'hand'
  | 'cross'
  | 'move'
  | 'resize-ns'
  | 'resize-ew'
  | 'resize-nwse'
  | 'resize-nesw'
  | 'busy'

export type CursorAppearance = {
  kind: CursorKind
}

const TEXT_ROLES = new Set([
  'AXTextField',
  'AXTextArea',
  'AXTextView',
  'AXSearchField',
  'AXComboBox',
  'AXText'
])
const TEXT_ANCESTORS = new Set([
  'AXTextField',
  'AXTextArea',
  'AXTextView',
  'AXSearchField',
  'AXComboBox'
])
const HAND_ROLES = new Set(['AXLink'])
const RESIZE_ROLES = new Set(['AXSplitter', 'AXGrowArea'])
const TEXT_DESCRIPTIONS = [
  'text field',
  'text area',
  'text view',
  'search field',
  'combo box',
  'text editor',
  'code editor',
  'editor'
]

let readAppearance: ((point: { x: number; y: number }) => CursorAppearance) | undefined

export function getCursorAppearance(point: { x: number; y: number }): CursorAppearance {
  if (!readAppearance) {
    readAppearance = createReader()
  }

  try {
    return readAppearance(point)
  } catch {
    return { kind: 'pointer' }
  }
}

export function getCursorKind(point: { x: number; y: number }): CursorKind {
  return getCursorAppearance(point).kind
}

function createReader(): (point: { x: number; y: number }) => CursorAppearance {
  if (process.platform === 'win32') {
    return createWindowsReader()
  }
  if (process.platform === 'darwin') {
    return createMacReader()
  }
  return () => ({ kind: 'pointer' })
}

type CursorRead = {
  kind: CursorKind
  trusted: boolean
}

function createMacReader(): (point: { x: number; y: number }) => CursorAppearance {
  const ns = safeCreate(createMacNsCursorReader)
  const ax = safeCreate(createMacAxReader)

  return (point) => {
    const fromNs = ns?.() ?? { kind: 'pointer', trusted: false }
    if (fromNs.trusted) {
      return { kind: fromNs.kind }
    }

    const fromAx = ax?.(point) ?? 'pointer'
    if (fromAx !== 'pointer') {
      return { kind: fromAx }
    }

    return { kind: fromNs.kind }
  }
}

function safeCreate<T>(create: () => T): T | undefined {
  try {
    return create()
  } catch {
    return undefined
  }
}

function createMacAxReader(): (point: { x: number; y: number }) => CursorKind {
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
  const CFGetTypeID = cf.func('uint64 CFGetTypeID(void *value)')
  const CFStringGetTypeID = cf.func('uint64 CFStringGetTypeID(void)')
  const CFRelease = cf.func('void CFRelease(void *value)')
  const systemWide = AXUIElementCreateSystemWide()
  const roleAttr = CFStringCreateWithCString(null, 'AXRole', 0x08000100)
  const descAttr = CFStringCreateWithCString(null, 'AXRoleDescription', 0x08000100)
  const parentAttr = CFStringCreateWithCString(null, 'AXParent', 0x08000100)
  const stringType = CFStringGetTypeID()
  const buffer = Buffer.alloc(128)

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
      const copied = CFStringGetCString(value, buffer, buffer.length, 0x08000100)
      return copied ? buffer.toString('utf8').replace(/\0.*$/, '') : ''
    } finally {
      CFRelease(value)
    }
  }

  const kindOf = (_element: unknown, roles: string[]): CursorKind => {
    for (const role of roles) {
      if (TEXT_ROLES.has(role)) {
        return 'text'
      }
      if (HAND_ROLES.has(role)) {
        return 'hand'
      }
      if (RESIZE_ROLES.has(role)) {
        return 'resize-ew'
      }
    }

    if (roles.some((role) => role === 'AXStaticText') && roles.some((role) => TEXT_ANCESTORS.has(role))) {
      return 'text'
    }

    return 'pointer'
  }

  return (point) => {
    const elementOut = [null] as [unknown]
    const found = AXUIElementCopyElementAtPosition(systemWide, point.x, point.y, elementOut)
    let element = elementOut[0]
    if (found !== 0 || !element) {
      return 'pointer'
    }

    const roles: string[] = []

    try {
      for (let depth = 0; depth < 4; depth += 1) {
        const role = readString(element, roleAttr)
        const description = readString(element, descAttr).toLowerCase()
        if (role) {
          roles.push(role)
        }

        const direct = kindOf(element, [role])
        if (direct !== 'pointer') {
          return direct
        }

        if (TEXT_DESCRIPTIONS.some((item) => description.includes(item))) {
          return 'text'
        }

        const parentOut = [null] as [unknown]
        const parentOk = AXUIElementCopyAttributeValue(element, parentAttr, parentOut)
        const parent = parentOut[0]
        if (parentOk !== 0 || !parent) {
          break
        }
        if (depth > 0) {
          CFRelease(element)
        }
        element = parent
      }

      return kindOf(element, roles)
    } finally {
      if (element) {
        CFRelease(element)
      }
    }
  }
}

function createMacNsCursorReader(): () => CursorRead {
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit')
  const objc = koffi.load('libobjc.A.dylib')
  const libc = koffi.load('/usr/lib/libSystem.B.dylib')
  const NSPoint = koffi.struct('NSPoint', { x: 'double', y: 'double' })
  const NSSize = koffi.struct('NSSize', { width: 'double', height: 'double' })
  const sel_registerName = objc.func('sel_registerName', 'void *', ['str'])
  const objc_getClass = objc.func('objc_getClass', 'void *', ['str'])
  const class_respondsToSelector = objc.func('bool class_respondsToSelector(void *cls, void *sel)')
  const msgSend = objc.func('objc_msgSend', 'void *', ['void *', 'void *'])
  const msgSendPoint = objc.func('NSPoint objc_msgSend(void *self, void *sel)')
  const msgSendSize = objc.func('NSSize objc_msgSend(void *self, void *sel)')
  const msgSendU64 = objc.func('uint64 objc_msgSend(void *self, void *sel)')
  const memcpy = libc.func('void *memcpy(void *dest, const void *src, uint64 n)')
  void NSPoint
  void NSSize

  const NSCursor = objc_getClass('NSCursor')
  const currentSel = class_respondsToSelector(NSCursor, sel_registerName('currentSystemCursor'))
    ? sel_registerName('currentSystemCursor')
    : sel_registerName('currentCursor')
  const imageSel = sel_registerName('image')
  const hotSel = sel_registerName('hotSpot')
  const sizeSel = sel_registerName('size')
  const tiffSel = sel_registerName('TIFFRepresentation')
  const lengthSel = sel_registerName('length')
  const bytesSel = sel_registerName('bytes')

  const names: Array<[string, CursorKind]> = [
    ['IBeamCursor', 'text'],
    ['IBeamCursorForVerticalLayout', 'text'],
    ['pointingHandCursor', 'hand'],
    ['crosshairCursor', 'cross'],
    ['openHandCursor', 'move'],
    ['closedHandCursor', 'move'],
    ['resizeUpDownCursor', 'resize-ns'],
    ['resizeLeftRightCursor', 'resize-ew'],
    ['arrowCursor', 'pointer']
  ]
  const known = names.map(([name, kind]) => ({
    handle: String(msgSend(NSCursor, sel_registerName(name))),
    kind
  }))
  const arrowHandle = known.find((item) => item.kind === 'pointer')?.handle

  return () => {
    const cursor = msgSend(NSCursor, currentSel)
    if (!cursor) {
      return { kind: 'pointer', trusted: false }
    }

    const matched = known.find((item) => item.handle === String(cursor))?.kind
    if (matched) {
      return { kind: matched, trusted: true }
    }

    if (String(cursor) === arrowHandle) {
      return { kind: 'pointer', trusted: true }
    }

    const image = msgSend(cursor, imageSel)
    const hot = image ? msgSendPoint(cursor, hotSel) : { x: 0, y: 0 }
    const size = image ? msgSendSize(image, sizeSel) : { width: 16, height: 16 }
    if (hot.x <= 2.5 && hot.y <= 2.5) {
      return { kind: 'pointer', trusted: true }
    }

    const fromPixels = kindFromCursorImage(image, tiffSel, lengthSel, bytesSel, msgSend, msgSendU64, memcpy)
    if (fromPixels) {
      return { kind: fromPixels, trusted: true }
    }

    return { kind: kindFromHotspot(hot.x, hot.y, size.width, size.height), trusted: false }
  }
}

function kindFromCursorImage(
  image: unknown,
  tiffSel: unknown,
  lengthSel: unknown,
  bytesSel: unknown,
  msgSend: (obj: unknown, sel: unknown) => unknown,
  msgSendU64: (obj: unknown, sel: unknown) => number | bigint,
  memcpy: (dest: Buffer, src: unknown, n: number | bigint) => unknown
): CursorKind | undefined {
  if (!image) {
    return undefined
  }

  try {
    const tiff = msgSend(image, tiffSel)
    if (!tiff) {
      return undefined
    }
    const length = Number(msgSendU64(tiff, lengthSel))
    const bytes = msgSend(tiff, bytesSel)
    if (!bytes || length <= 0 || length > 512_000) {
      return undefined
    }

    const dest = Buffer.alloc(length)
    memcpy(dest, bytes, length)
    const native = nativeImage.createFromBuffer(dest)
    const bitmap = native.toBitmap()
    const { width, height } = native.getSize()
    if (!width || !height || bitmap.length < 4) {
      return undefined
    }
    const pixelCount = bitmap.length / 4
    const scale = Math.max(1, Math.round(Math.sqrt(pixelCount / (width * height))))
    return kindFromBitmap(bitmap, width * scale, height * scale)
  } catch {
    return undefined
  }
}

function kindFromBitmap(bitmap: Buffer, width: number, height: number): CursorKind | undefined {
  let minX = width
  let minY = height
  let maxX = 0
  let maxY = 0
  const rowWidths: number[] = []

  for (let y = 0; y < height; y += 1) {
    let rowMin = width
    let rowMax = -1
    for (let x = 0; x < width; x += 1) {
      const alpha = bitmap[(y * width + x) * 4 + 3]
      if (alpha < 48) {
        continue
      }
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (x < rowMin) rowMin = x
      if (x > rowMax) rowMax = x
    }
    if (rowMax >= rowMin) {
      rowWidths.push(rowMax - rowMin + 1)
    }
  }

  if (!rowWidths.length || maxX < minX || maxY < minY) {
    return undefined
  }

  const boxWidth = maxX - minX + 1
  const boxHeight = maxY - minY + 1
  const n = rowWidths.length
  const avg = (start: number, end: number): number => {
    const part = rowWidths.slice(start, Math.max(start + 1, end))
    return part.reduce((sum, value) => sum + value, 0) / part.length
  }
  const top = avg(0, Math.floor(n * 0.25))
  const mid = avg(Math.floor(n * 0.35), Math.ceil(n * 0.65))
  const bottom = avg(Math.floor(n * 0.75), n)
  const sorted = [...rowWidths].sort((left, right) => left - right)
  const median = sorted[Math.floor(sorted.length / 2)] ?? boxWidth

  const wideningArrow = top + 2 < mid && mid <= bottom + 3 && top <= 6
  if (wideningArrow) {
    return undefined
  }

  const shaft = mid <= 6 && mid <= top + 1.5 && mid <= bottom + 1.5
  if (boxHeight >= 10 && (shaft || (boxWidth <= 9 && median <= 7))) {
    return 'text'
  }
  if (boxWidth >= boxHeight * 1.45 && median <= boxHeight) {
    return 'resize-ew'
  }

  return undefined
}

function kindFromHotspot(hx: number, hy: number, width: number, height: number): CursorKind {
  if (hx <= 2.5 && hy <= 2.5) {
    return 'pointer'
  }
  if (width + 1 < height && Math.abs(hx - width / 2) <= 4) {
    return 'text'
  }
  if (width > height * 1.3) {
    return 'resize-ew'
  }
  if (height > width * 1.3 && Math.abs(hx - width / 2) <= 4) {
    return 'resize-ns'
  }
  return 'pointer'
}

function createWindowsReader(): (point: { x: number; y: number }) => CursorAppearance {
  const user32 = koffi.load('user32.dll')
  const gdi32 = koffi.load('gdi32.dll')
  const CursorInfo = koffi.struct('CURSORINFO', {
    cbSize: 'uint32',
    flags: 'uint32',
    hCursor: 'void *',
    x: 'int32',
    y: 'int32'
  })
  const IconInfo = koffi.struct('ICONINFO', {
    fIcon: 'int32',
    xHotspot: 'uint32',
    yHotspot: 'uint32',
    hbmMask: 'void *',
    hbmColor: 'void *'
  })
  const Bitmap = koffi.struct('BITMAP', {
    bmType: 'int32',
    bmWidth: 'int32',
    bmHeight: 'int32',
    bmWidthBytes: 'int32',
    bmPlanes: 'uint16',
    bmBitsPixel: 'uint16',
    bmBits: 'void *'
  })
  const GetCursorInfo = user32.func('bool __stdcall GetCursorInfo(_Inout_ CURSORINFO *info)')
  const LoadCursorW = user32.func('void * __stdcall LoadCursorW(void *instance, uintptr id)')
  const GetIconInfo = user32.func('bool __stdcall GetIconInfo(void *cursor, _Out_ ICONINFO *info)')
  const GetObjectW = gdi32.func('int __stdcall GetObjectW(void *object, int size, _Out_ BITMAP *out)')
  const GetBitmapBits = gdi32.func('int __stdcall GetBitmapBits(void *bitmap, int count, _Out_ uint8 *bits)')
  const DeleteObject = gdi32.func('bool __stdcall DeleteObject(void *object)')
  void IconInfo
  void Bitmap

  const ids: Array<[number, CursorKind]> = [
    [32513, 'text'],
    [32649, 'hand'],
    [32515, 'cross'],
    [32646, 'move'],
    [32645, 'resize-ns'],
    [32644, 'resize-ew'],
    [32642, 'resize-nwse'],
    [32643, 'resize-nesw'],
    [32514, 'busy'],
    [32650, 'busy'],
    [32512, 'pointer']
  ]
  const handles = ids.map(([id, kind]) => ({
    handle: String(LoadCursorW(null, id)),
    kind
  }))

  return () => {
    const info = {
      cbSize: koffi.sizeof(CursorInfo),
      flags: 0,
      hCursor: null,
      x: 0,
      y: 0
    }
    if (!GetCursorInfo(info) || !info.hCursor) {
      return { kind: 'pointer' }
    }

    const stock = handles.find((item) => item.handle === String(info.hCursor))?.kind
    if (stock) {
      return { kind: stock }
    }

    const icon = {
      fIcon: 0,
      xHotspot: 0,
      yHotspot: 0,
      hbmMask: null,
      hbmColor: null
    }
    if (!GetIconInfo(info.hCursor, icon)) {
      return { kind: 'pointer' }
    }

    if (icon.xHotspot <= 2 && icon.yHotspot <= 2) {
      if (icon.hbmMask) {
        DeleteObject(icon.hbmMask)
      }
      if (icon.hbmColor) {
        DeleteObject(icon.hbmColor)
      }
      return { kind: 'pointer' }
    }

    const bitmap = {
      bmType: 0,
      bmWidth: 0,
      bmHeight: 0,
      bmWidthBytes: 0,
      bmPlanes: 0,
      bmBitsPixel: 0,
      bmBits: null
    }
    const source = icon.hbmColor ?? icon.hbmMask
    if (source) {
      GetObjectW(source, koffi.sizeof(Bitmap), bitmap)
    }

    let fromPixels: CursorKind | undefined
    if (source && bitmap.bmWidth > 0 && bitmap.bmHeight > 0 && bitmap.bmBitsPixel === 32) {
      const height = icon.hbmColor ? bitmap.bmHeight : Math.floor(bitmap.bmHeight / 2) || bitmap.bmHeight
      const bytes = Buffer.alloc(bitmap.bmWidthBytes * height)
      if (GetBitmapBits(source, bytes.length, bytes) > 0) {
        fromPixels = kindFromWindowsBits(bytes, bitmap.bmWidth, height, bitmap.bmWidthBytes)
      }
    }

    if (icon.hbmMask) {
      DeleteObject(icon.hbmMask)
    }
    if (icon.hbmColor) {
      DeleteObject(icon.hbmColor)
    }

    if (fromPixels) {
      return { kind: fromPixels }
    }

    const width = bitmap.bmWidth || 32
    const height = Math.max(1, icon.hbmColor ? bitmap.bmHeight : Math.floor(bitmap.bmHeight / 2) || 32)
    return { kind: stock ?? kindFromHotspot(icon.xHotspot, icon.yHotspot, width, height) }
  }
}

function kindFromWindowsBits(
  bits: Buffer,
  width: number,
  height: number,
  stride: number
): CursorKind | undefined {
  const bitmap = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const src = y * stride + x * 4
      const dest = (y * width + x) * 4
      bitmap[dest] = bits[src]
      bitmap[dest + 1] = bits[src + 1]
      bitmap[dest + 2] = bits[src + 2]
      bitmap[dest + 3] = bits[src + 3] || Math.max(bits[src], bits[src + 1], bits[src + 2])
    }
  }
  return kindFromBitmap(bitmap, width, height)
}
