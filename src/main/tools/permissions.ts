import { execFile } from 'child_process'
import { promisify } from 'util'
import { platform } from 'os'

const execFileAsync = promisify(execFile)

export type PermissionState = 'granted' | 'denied' | 'unknown'

export type PermissionStatus = {
  screenRecording: PermissionState
  accessibility: PermissionState
}

export async function getPermissionStatus(): Promise<PermissionStatus> {
  if (platform() !== 'darwin') {
    return { screenRecording: 'unknown', accessibility: 'unknown' }
  }
  const [accessibility, screenRecording] = await Promise.all([
    checkAccessibility(),
    checkScreenRecording()
  ])
  return { accessibility, screenRecording }
}

async function checkAccessibility(): Promise<PermissionState> {
  try {
    // AXIsProcessTrusted via Swift — returns true/false
    const { stdout } = await execFileAsync(
      'swift',
      [
        '-e',
        'import ApplicationServices; print(AXIsProcessTrusted() ? "granted" : "denied")'
      ],
      { timeout: 8000 }
    )
    const v = stdout.trim()
    if (v === 'granted' || v === 'denied') return v
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

async function checkScreenRecording(): Promise<PermissionState> {
  try {
    // CGPreflightScreenCaptureAccess (macOS 10.15+)
    const { stdout } = await execFileAsync(
      'swift',
      [
        '-e',
        'import CoreGraphics; print(CGPreflightScreenCaptureAccess() ? "granted" : "denied")'
      ],
      { timeout: 8000 }
    )
    const v = stdout.trim()
    if (v === 'granted' || v === 'denied') return v
    return 'unknown'
  } catch {
    return 'unknown'
  }
}
