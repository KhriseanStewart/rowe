import { clipboard, type BrowserWindowConstructorOptions } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import koffi from 'koffi'

const execFileAsync = promisify(execFile)

export function askShortcut(): string {
  return process.platform === 'darwin' ? 'Command+Control+T' : 'Control+Alt+T'
}

export function askShortcutLabel(): string {
  return process.platform === 'darwin' ? 'Control-Command-T' : 'Ctrl+Alt+T'
}

export function trayShowShortcut(): string {
  return process.platform === 'darwin' ? 'Command+Control+S' : 'Control+Alt+S'
}

export function trayShowShortcutLabel(): string {
  return process.platform === 'darwin' ? 'Control-Command-S' : 'Ctrl+Alt+S'
}

export function glassWindowOptions(): BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return {
      type: 'panel',
      vibrancy: 'hud',
      visualEffectState: 'active',
      roundedCorners: true
    }
  }

  if (process.platform === 'win32') {
    return {
      backgroundMaterial: 'acrylic'
    }
  }

  return {}
}

export async function readQuotedText(): Promise<{ selection: string; clipboard: string }> {
  const previous = clipboard.readText()

  try {
    await waitForShortcutKeysReleased()
    await postCopyKeystroke()
    await delay(220)
    const after = clipboard.readText()
    clipboard.writeText(previous)

    if (after.trim() && after !== previous) {
      return { selection: after, clipboard: previous }
    }

    return { selection: '', clipboard: previous }
  } catch {
    clipboard.writeText(previous)
    return { selection: '', clipboard: previous }
  }
}

export async function getFrontmostApp(): Promise<string> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('osascript', [
        '-e',
        'tell application "System Events" to get name of first application process whose frontmost is true'
      ])
      return stdout.trim()
    }

    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-WindowStyle',
        'Hidden',
        '-Command',
        "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;using System.Text;public class W{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder t,int n);}'; $b = New-Object System.Text.StringBuilder 256; [void][W]::GetWindowText([W]::GetForegroundWindow(), $b, 256); $b.ToString()"
      ])
      return stdout.trim()
    }
  } catch {
    return ''
  }

  return ''
}

async function waitForShortcutKeysReleased(): Promise<void> {
  if (process.platform !== 'darwin') {
    await delay(80)
    return
  }

  const flagsState = macFlagsState()
  const deadline = Date.now() + 900
  while (Date.now() < deadline) {
    if ((flagsState() & (macFlag.command | macFlag.control | macFlag.option)) === 0) {
      await delay(40)
      return
    }
    await delay(30)
  }
}

export async function activateApp(appName: string): Promise<void> {
  const name = appName.trim()
  if (!name || isSelfApp(name)) {
    return
  }

  try {
    if (process.platform === 'darwin') {
      await execFileAsync(
        'osascript',
        [
          '-e',
          `tell application "System Events" to set frontmost of first process whose name is "${escapeApple(name)}" to true`
        ],
        { timeout: 1500 }
      )
      return
    }
    if (process.platform === 'win32') {
      await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-WindowStyle',
          'Hidden',
          '-Command',
          `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate('${name.replace(/'/g, "''")}')`
        ],
        { timeout: 1500 }
      )
    }
  } catch {
    // The paste target may already be frontmost.
  }
}

export async function pasteText(text: string): Promise<void> {
  const body = text.trim()
  if (!body) {
    return
  }

  const previous = clipboard.readText()
  clipboard.writeText(body)
  try {
    await postPasteKeystroke()
    await delay(180)
  } finally {
    clipboard.writeText(previous)
  }
}

export async function pressReplyKey(): Promise<void> {
  if (process.platform === 'darwin') {
    if (!postMacKey(15, 0)) {
      await execFileAsync('osascript', ['-e', 'tell application "System Events" to keystroke "r"'])
    }
    return
  }
  if (process.platform === 'win32') {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-WindowStyle',
      'Hidden',
      '-Command',
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('r')"
    ])
  }
}

export async function frontWindowTitle(): Promise<string> {
  if (process.platform !== 'darwin') {
    return ''
  }
  try {
    const { stdout } = await execFileAsync(
      'osascript',
      [
        '-e',
        'tell application "System Events" to get name of front window of first process whose frontmost is true'
      ],
      { timeout: 1200 }
    )
    return stdout.trim()
  } catch {
    return ''
  }
}

async function postCopyKeystroke(): Promise<void> {
  await postKeystroke('c', true)
}

async function postPasteKeystroke(): Promise<void> {
  await postKeystroke('v', true)
}

async function postKeystroke(key: 'c' | 'v', command: boolean): Promise<void> {
  const codes = { c: 8, v: 9 }
  if (process.platform === 'darwin') {
    if (postMacKey(codes[key], command ? macFlag.command : 0)) {
      return
    }
    const using = command ? ' using command down' : ''
    await execFileAsync('osascript', [
      '-e',
      `tell application "System Events" to keystroke "${key}"${using}`
    ])
    return
  }

  if (process.platform === 'win32') {
    const send = command ? `^${key}` : key
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-WindowStyle',
      'Hidden',
      '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${send}')`
    ])
  }
}

function isSelfApp(appName: string): boolean {
  return /^(rowe|electron)$/i.test(appName.trim())
}

function escapeApple(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

const macFlag = {
  command: 0x100000,
  control: 0x40000,
  option: 0x80000
}

let readMacFlags: (() => number) | undefined

function macFlagsState(): () => number {
  if (!readMacFlags) {
    try {
      const quartz = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
      const CGEventSourceFlagsState = quartz.func('uint64 CGEventSourceFlagsState(int state)')
      readMacFlags = () => Number(CGEventSourceFlagsState(0))
    } catch {
      readMacFlags = () => 0
    }
  }
  return readMacFlags
}

let macKey: ((keyCode: number, flags: number) => boolean) | undefined

function postMacKey(keyCode: number, flags: number): boolean {
  if (!macKey) {
    try {
      const quartz = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
      const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
      const CGEventCreateKeyboardEvent = quartz.func(
        'void * CGEventCreateKeyboardEvent(void *source, uint16 key, bool down)'
      )
      const CGEventSetFlags = quartz.func('void CGEventSetFlags(void *event, uint64 flags)')
      const CGEventPost = quartz.func('void CGEventPost(uint32 tap, void *event)')
      const CFRelease = cf.func('void CFRelease(void *value)')
      macKey = (code, eventFlags) => {
        const down = CGEventCreateKeyboardEvent(null, code, true)
        const up = CGEventCreateKeyboardEvent(null, code, false)
        if (!down || !up) {
          return false
        }
        CGEventSetFlags(down, eventFlags)
        CGEventSetFlags(up, eventFlags)
        CGEventPost(0, down)
        CGEventPost(0, up)
        CFRelease(down)
        CFRelease(up)
        return true
      }
    } catch {
      macKey = () => false
    }
  }
  return macKey(keyCode, flags)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
