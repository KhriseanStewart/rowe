import { clipboard } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { runBrowserJavaScript } from './app-context'
import { activateApp, pasteText } from './platform'

const execFileAsync = promisify(execFile)

export async function insertDraft(input: {
  text: string
  appName: string
  mode: 'paste' | 'reply'
  url?: string
  windowTitle?: string
}): Promise<void> {
  const body = toPlainReply(input.text)
  if (!body) {
    throw new Error('No short reply to paste. Ask Rowe to draft a message.')
  }

  await activateApp(input.appName)
  await delay(320)

  if (input.mode === 'reply') {
    if (await openMailReply(input.appName)) {
      await delay(500)
      await pasteText(body)
      return
    }
    if (await openOutlookReply(input.appName)) {
      await delay(500)
      await pasteText(body)
      return
    }
  }

  if (await openWebReply(input.appName)) {
    await delay(550)
    await pasteText(body)
    return
  }

  await pasteText(body)
}

export function copyDraft(text: string): string {
  const body = extractPasteReply(text) || cleanReply(text)
  clipboard.writeText(body)
  return body
}

export function extractPasteReply(text: string): string {
  const raw = text.trim()
  if (!raw) {
    return ''
  }

  const fenced = raw.match(/```(?:reply|message|sms|text)?\s*\n([\s\S]*?)```/i)
  if (fenced?.[1]?.trim()) {
    return cleanReply(fenced[1])
  }

  const quoted = raw.match(/^[“"]([\s\S]+?)[”"]$/m)
  if (quoted?.[1] && quoted[1].length < 500) {
    return cleanReply(quoted[1])
  }

  const cleaned = cleanReply(raw)
    .split(/\n(?=If you want it tighter|Alternatively|Option \d|Another option)/i)[0]
    .trim()

  if (/^(hi|hey|hello|dear|yo)\b/i.test(cleaned) || cleaned.includes('\n')) {
    return cleaned.slice(0, 2500)
  }

  const labeled = raw.match(
    /(?:^|\n)(?:reply|draft|message|paste(?: this)?)[:\s—-]+([\s\S]+?)(?:\n\n[A-Z][\s\S]+)?$/i
  )
  if (labeled?.[1] && !isAnalysis(labeled[1]) && labeled[1].trim().length < 2500) {
    return cleanReply(labeled[1])
  }

  const blocks = raw
    .split(/\n{2,}/)
    .map((block) => cleanReply(block))
    .filter(Boolean)
  const sendable = blocks.filter((block) => isSendableReply(block))
  if (sendable.length) {
    return sendable[0]
  }

  return cleaned.slice(0, 2500)
}

function toPlainReply(text: string): string {
  return extractPasteReply(text)
}

function cleanReply(text: string): string {
  return text
    .replace(/^```(?:reply|message|sms|text)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/(^|[^\w])\*(.*?)\*(?!\w)/g, '$1$2')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .trim()
}

function isSendableReply(text: string): boolean {
  return text.length >= 2 && text.length <= 2500 && !isAnalysis(text)
}

function isAnalysis(text: string): boolean {
  return /you've already|here are a few|you can paste|window title|screenshot|focused app|i only have|the context i have|natural moment|follow up with/i.test(
    text
  )
}

async function openMailReply(appName: string): Promise<boolean> {
  if (process.platform !== 'darwin' || !/^mail$/i.test(appName.trim())) {
    return false
  }

  try {
    await execFileAsync(
      'osascript',
      [
        '-e',
        `tell application "Mail"
  activate
  if (count of selected messages) is 0 then error "No message selected"
  set msg to item 1 of (get selected messages)
  reply msg with opening window
end tell`
      ],
      { timeout: 3000 }
    )
    return true
  } catch {
    return false
  }
}

async function openOutlookReply(appName: string): Promise<boolean> {
  if (process.platform !== 'darwin' || !/outlook/i.test(appName)) {
    return false
  }

  try {
    await execFileAsync(
      'osascript',
      [
        '-e',
        `tell application "Microsoft Outlook"
  activate
  if (count of selected objects) is 0 then error "No message selected"
  set msg to item 1 of (get selected objects)
  reply to msg
end tell`
      ],
      { timeout: 3000 }
    )
    return true
  } catch {
    return false
  }
}

const OPEN_WEB_REPLY_JS = `(function(){
  function visible(el){
    if (!el) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    var box = el.getBoundingClientRect();
    return box.width > 8 && box.height > 8;
  }
  function focusEditor(el){
    el.focus();
    try { el.click(); } catch (e) {}
    return 'compose';
  }
  var editors = document.querySelectorAll('[contenteditable=true], textarea, [role=textbox]');
  var last = null;
  for (var i = 0; i < editors.length; i++) {
    if (!visible(editors[i])) continue;
    var box = editors[i].getBoundingClientRect();
    if (box.top > window.innerHeight * 0.55) return focusEditor(editors[i]);
    last = editors[i];
  }
  var labels = ['reply', 'respond', 'write a comment', 'add a comment', 'leave a comment', 'write a reply', 'send a message', 'type a message', 'write a message'];
  var nodes = document.querySelectorAll('button, [role=button], a, [data-tooltip], [aria-label]');
  for (var k = 0; k < labels.length; k++) {
    var want = labels[k];
    for (var n = 0; n < nodes.length; n++) {
      if (!visible(nodes[n])) continue;
      var text = ((nodes[n].getAttribute('aria-label')||'')+' '+(nodes[n].getAttribute('data-tooltip')||'')+' '+(nodes[n].textContent||'')).toLowerCase().replace(/\\s+/g,' ').trim();
      if (want === 'reply' && text.indexOf('reply all') !== -1) continue;
      if (text.indexOf(want) !== -1 && text.length < 56) {
        nodes[n].click();
        return 'clicked';
      }
    }
  }
  if (last) return focusEditor(last);
  return 'missing';
})()`

async function openWebReply(appName: string): Promise<boolean> {
  if (!/chrome|safari|arc|brave|edg|firefox|dia|vivaldi|opera|comet|orion/i.test(appName)) {
    return false
  }
  const result = await runBrowserJavaScript(appName, OPEN_WEB_REPLY_JS)
  return result === 'compose' || result === 'clicked'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
