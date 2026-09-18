import { execFile } from 'child_process'
import { promisify } from 'util'
import { frontWindowTitle } from './platform'

const execFileAsync = promisify(execFile)

export type ActiveAppInfo = {
  appName: string
  windowTitle?: string
  url?: string
  document?: string
  files?: string[]
}

export async function runBrowserJavaScript(appName: string, js: string): Promise<string> {
  if (process.platform !== 'darwin') {
    return ''
  }

  const escaped = js.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

  try {
    if (/safari/i.test(appName) && !/chrome/i.test(appName)) {
      const { stdout } = await execFileAsync(
        'osascript',
        ['-e', `tell application "Safari" to do JavaScript "${escaped}" in front document`],
        { timeout: 2500 }
      )
      return stdout.trim()
    }

    const chrome = chromeLikeName(appName)
    if (!chrome) {
      return ''
    }

    const { stdout } = await execFileAsync(
      'osascript',
      [
        '-e',
        `tell application "${chrome}" to tell active tab of front window to execute javascript "${escaped}"`
      ],
      { timeout: 2500 }
    )
    return stdout.trim()
  } catch {
    return ''
  }
}

const READ_MAIN_PANE_JS = `(function(){
  function textOf(el){
    return el && el.innerText ? String(el.innerText).trim() : '';
  }
  var main = document.querySelector('#main')
    || document.querySelector('[data-testid=conversation-panel-wrapper]')
    || document.querySelector('[data-testid=conversation-panel-body]')
    || document.querySelector('div.copyable-area')
    || document.querySelector('[role=main]')
    || document.querySelector('main');
  var header = document.querySelector('#main header')
    || document.querySelector('[data-testid=conversation-header]');
  var parts = [];
  if (header) parts.push(textOf(header));
  if (main) parts.push(textOf(main));
  var joined = parts.join('\\n\\n').trim();
  if (joined.length > 40) return joined.slice(0,12000);
  return document.body && document.body.innerText ? document.body.innerText.slice(0,12000) : '';
})()`

export async function readBrowserPageText(appName: string): Promise<string> {
  return runBrowserJavaScript(appName, READ_MAIN_PANE_JS)
}

export async function readActiveAppInfo(appName: string): Promise<ActiveAppInfo> {
  const [windowTitle, tab, files, document] = await Promise.all([
    frontWindowTitle(),
    readBrowserTab(appName),
    readFinderSelection(appName),
    readFrontDocument(appName)
  ])

  return {
    appName,
    windowTitle: tab?.title || windowTitle || undefined,
    url: tab?.url,
    document: document || files[0],
    files: files.length ? files : undefined
  }
}

export function chromeLikeName(appName: string): string | undefined {
  if (/safari/i.test(appName) && !/chrome/i.test(appName)) {
    return undefined
  }
  if (/google chrome/i.test(appName) || appName === 'Chrome') {
    return 'Google Chrome'
  }
  if (/brave/i.test(appName)) {
    return 'Brave Browser'
  }
  if (/edge/i.test(appName)) {
    return 'Microsoft Edge'
  }
  if (/^arc$/i.test(appName)) {
    return 'Arc'
  }
  if (/vivaldi/i.test(appName)) {
    return 'Vivaldi'
  }
  if (/opera/i.test(appName)) {
    return 'Opera'
  }
  if (/^dia$/i.test(appName)) {
    return 'Dia'
  }
  if (/comet/i.test(appName)) {
    return 'Comet'
  }
  if (/chrome|chromium/i.test(appName)) {
    return appName
  }
  return undefined
}

async function readBrowserTab(
  appName: string
): Promise<{ url?: string; title?: string } | undefined> {
  if (process.platform !== 'darwin' || !/chrome|safari|arc|brave|edg|firefox|dia|vivaldi|opera|comet|orion/i.test(appName)) {
    return undefined
  }

  try {
    if (/safari/i.test(appName) && !/chrome/i.test(appName)) {
      const { stdout } = await execFileAsync(
        'osascript',
        [
          '-e',
          'tell application "Safari" to get (URL of front document) & linefeed & (name of front document)'
        ],
        { timeout: 1800 }
      )
      return splitTab(stdout)
    }

    const chrome = chromeLikeName(appName)
    if (chrome) {
      const { stdout } = await execFileAsync(
        'osascript',
        [
          '-e',
          `tell application "${chrome}" to get (URL of active tab of front window) & linefeed & (title of active tab of front window)`
        ],
        { timeout: 1800 }
      )
      return splitTab(stdout)
    }
  } catch {
    return undefined
  }

  return undefined
}

async function readFinderSelection(appName: string): Promise<string[]> {
  if (process.platform !== 'darwin' || !/^finder$/i.test(appName.trim())) {
    return []
  }

  try {
    const { stdout } = await execFileAsync(
      'osascript',
      [
        '-e',
        `tell application "Finder"
  set output to ""
  repeat with f in (get selection)
    try
      set output to output & POSIX path of (f as alias) & linefeed
    end try
  end repeat
  if output is "" then
    try
      set output to POSIX path of (target of front window as alias)
    end try
  end if
  return output
end tell`
      ],
      { timeout: 2000 }
    )
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 20)
  } catch {
    return []
  }
}

async function readFrontDocument(appName: string): Promise<string | undefined> {
  if (process.platform !== 'darwin') {
    return undefined
  }

  const script = documentScript(appName)
  if (!script) {
    return undefined
  }

  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 1800 })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

function documentScript(appName: string): string | undefined {
  if (/^textedit$/i.test(appName)) {
    return 'tell application "TextEdit" to get path of front document'
  }
  if (/^preview$/i.test(appName)) {
    return 'tell application "Preview" to get path of front document'
  }
  if (/^pages$/i.test(appName)) {
    return 'tell application "Pages" to get name of front document'
  }
  if (/^numbers$/i.test(appName)) {
    return 'tell application "Numbers" to get name of front document'
  }
  if (/^keynote$/i.test(appName)) {
    return 'tell application "Keynote" to get name of front document'
  }
  if (/^notes$/i.test(appName)) {
    return 'tell application "Notes" to get name of selected note'
  }
  return undefined
}

function splitTab(stdout: string): { url?: string; title?: string } {
  const [url, ...rest] = stdout.trim().split(/\r?\n/)
  const title = rest.join('\n').trim()
  return {
    url: url?.trim() || undefined,
    title: title || undefined
  }
}
