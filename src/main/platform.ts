import { clipboard, type BrowserWindowConstructorOptions } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export function askShortcut(): string {
  return process.platform === 'darwin' ? 'Command+Control+T' : 'Control+Alt+T'
}

export function askShortcutLabel(): string {
  return process.platform === 'darwin' ? 'Control-Command-T' : 'Ctrl+Alt+T'
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

export async function copySelection(): Promise<string> {
  const previous = clipboard.readText()

  try {
    if (process.platform === 'darwin') {
      await execFileAsync('osascript', [
        '-e',
        'tell application "System Events" to keystroke "c" using command down'
      ])
    } else if (process.platform === 'win32') {
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-WindowStyle',
        'Hidden',
        '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')"
      ])
    } else {
      return previous
    }

    await delay(160)
    const selected = clipboard.readText()
    clipboard.writeText(previous)

    if (!selected || selected === previous) {
      return ''
    }

    return selected
  } catch {
    clipboard.writeText(previous)
    return ''
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
