export type DocumentMeta = {
  title?: string
  filename?: string
  subtitle?: string
  accent?: string
}

export type DocumentBlock = {
  hasDocument: boolean
  markdownBody: string
  meta: DocumentMeta
  /** Chat text with the deliverable fence removed (no code block shown). */
  displayText: string
}

const FENCE_RE = /```(?:markdown|md)\s*\n([\s\S]*?)```/gi
const OPEN_FENCE_RE = /```(?:markdown|md)\s*\n([\s\S]+)$/i
const META_LINE_RE = /^\s*(?:user\s+|response\s+|model\s+)?safety\s*:\s*.+$/gim
const RESPONSE_SAFETY_RE = /\bresponse\s+safety\s*:\s*\w+/gi
const TOOL_TAG_RE = /<\|[^|>]*tool[^|>]*\|>/gi
const FILENAME_RE =
  /(?:^|\n)\s*(?:\*{0,2}Filename\*{0,2}|filename)\s*:\s*[`"'[]?([A-Za-z0-9][\w.-]{1,80})[`"'\]]?/i
const DOCUMENT_REQUEST_RE =
  /\b(pdf|manual|handout|one-?pager|report|document|export|user guide|readme for stakeholders)\b/i
const DOWNLOADABLE_HINT_RE =
  /\b(downloadable|download (as |this )?(pdf|document)|pdf document|user guide|export)\b/i

function parseFrontmatter(raw: string): { meta: DocumentMeta; body: string } {
  const trimmed = raw.replace(/^\uFEFF/, '')
  if (!trimmed.startsWith('---')) {
    return { meta: {}, body: trimmed.trim() }
  }
  const end = trimmed.indexOf('\n---', 3)
  if (end === -1) {
    return { meta: {}, body: trimmed.trim() }
  }
  const yaml = trimmed.slice(3, end).trim()
  const body = trimmed.slice(end + 4).replace(/^\n/, '').trim()
  const meta: DocumentMeta = {}
  for (const line of yaml.split('\n')) {
    const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/)
    if (!match) continue
    const key = match[1].toLowerCase()
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key === 'title') meta.title = value
    else if (key === 'filename') meta.filename = value
    else if (key === 'subtitle') meta.subtitle = value
    else if (key === 'accent') meta.accent = value
  }
  return { meta, body }
}

function cleanPreamble(text: string): string {
  return text
    .replace(META_LINE_RE, '')
    .replace(RESPONSE_SAFETY_RE, '')
    .replace(TOOL_TAG_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Strip tool tags, safety meta, and tool-progress dumps from visible chat. */
export function sanitizeChatText(text: string): string {
  let cleaned = text
    .replace(TOOL_TAG_RE, '')
    .replace(RESPONSE_SAFETY_RE, '')
    .replace(META_LINE_RE, '')
    // Mid-line / trailing safety crumbs after a path
    .replace(/\s*response\s+safety\s*:\s*\w+/gi, '')
    .replace(/\s*(?:user\s+|model\s+)?safety\s*:\s*\w+/gi, '')
    // Tool call leftovers
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<dots_function_call>[\s\S]*?<\/dots_function_call>/gi, '')
    .replace(/<dots_function_call>/gi, '')
    .replace(/`<\/?dots_function_call\b[^>]*>`/gi, '')
    .replace(/<\/?dots_function_call\b[^>]*>/gi, '')
    .replace(/&lt;\/?dots_function_call\b[^&]*&gt;/gi, '')
    .replace(/(?:^|\n)\s*dots_function_call\s*(?=\n|$)/gi, '')
    .replace(/<\/?tool_call>|<\/?arg_key>|<\/?arg_value>|<\/?parameter>|<\/?parameters>/gi, '')
    .replace(
      /\[?(?:list_dir|read_file|write_file|mkdir|delete_path|path_exists|run_shell|patch_file)\s*\([^\)]*\)\]?/gi,
      ''
    )
    // Progress lines belong in AgentTrail, not the reply bubble
    .replace(
      /^[\s>*•\-]*✓?\s*(?:Read|Wrote|Patched|Deleted|Created|Shell|Indexed|Applied)[^\n]*$/gim,
      ''
    )
    .replace(/^\s*(?:\/Users\/|~\/|[A-Za-z]:\\)[^\n]*?(?:\(\d+\s*chars[^)]*\))?\s*$/gim, '')
    .replace(/\(\d+\s*chars(?:[^)]*)?\)/gi, '')

  cleaned = cleaned.replace(/```[\s\S]*?```/g, (block) => {
    if (
      /%PDF|%%EOF|xref|startxref|endobj|\/Type\s*\/Font/i.test(block) ||
      /open\s*\([^)]*\.pdf['"]\s*,\s*['"]wb['"]\)/i.test(block) ||
      /f\.write\s*\(\s*content\s*\)/i.test(block) ||
      /reportlab|fpdf|pdfkit|pypdf/i.test(block)
    ) {
      return ''
    }
    return block
  })
  if (/%PDF|\\nxref|\\nstartxref|%%EOF/.test(cleaned)) {
    cleaned = cleaned
      .replace(/[\s\S]*?%%EOF[\s\S]*/g, '')
      .replace(/%PDF[\s\S]*/g, '')
  }
  return cleanPreamble(cleaned)
}

export function isDocumentRequest(text: string): boolean {
  return DOCUMENT_REQUEST_RE.test(text)
}

export function looksLikeFailedDocumentExport(text: string): boolean {
  return (
    /<\|[^|>]*tool[^|>]*\|>/i.test(text) ||
    /%PDF|%%EOF|\\nxref|\\nstartxref|\/Type\s*\/Font|endobj/i.test(text) ||
    /open\s*\([^)]*\.pdf['"]\s*,\s*['"]wb['"]\)/i.test(text) ||
    /f\.write\s*\(\s*content\s*\)/i.test(text) ||
    /reportlab|fpdf|pdfkit|pypdf/i.test(text)
  )
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'document'
  )
}

function titleFromMarkdown(body: string): string | undefined {
  const heading = body.match(/^#\s+(.+)$/m)
  return heading?.[1]?.trim()
}

/** Recover a simple markdown deliverable when the model tried to emit PDF/code instead. */
export function inferDocumentFromRequest(userText: string): DocumentBlock | null {
  if (!isDocumentRequest(userText)) return null

  const saysMatch = userText.match(
    /\b(?:says?|with text|containing|that reads?|text)\s+["']?([^"'\n.]+?)["']?(?:\s*$|[.!?,])/i
  )
  const titleMatch = userText.match(/\b(?:called|named|titled)\s+["']?([^"'\n.]+)["']?/i)

  let content = saysMatch?.[1]?.trim()
  if (!content && /hello\s+world/i.test(userText)) {
    content = 'Hello World'
  }
  if (!content) return null

  const title = titleMatch?.[1]?.trim() || content
  const filename = slugify(titleMatch?.[1] || content)

  return {
    hasDocument: true,
    markdownBody: `# ${title}\n\n${content}`,
    meta: { title, filename },
    displayText: ''
  }
}

/**
 * Models often skip the ```markdown fence and dump Filename + body inline.
 * Recover that shape so Download PDF still appears.
 */
function parseLooseDocument(text: string, userRequest?: string): DocumentBlock | null {
  const filenameMatch = text.match(FILENAME_RE)
  const wantsDocument =
    Boolean(userRequest && isDocumentRequest(userRequest)) ||
    DOWNLOADABLE_HINT_RE.test(text) ||
    Boolean(filenameMatch)

  if (!wantsDocument) return null

  let body = text
  let displayText = ''
  const filename = filenameMatch?.[1]

  if (filenameMatch && filenameMatch.index != null) {
    const after = text.slice(filenameMatch.index + filenameMatch[0].length).replace(/^\s*\n+/, '')
    const before = cleanPreamble(text.slice(0, filenameMatch.index))
    if (/^#\s+/m.test(after) || after.length > 120) {
      body = after.replace(/^\s*-{3,}\s*\n+/, '').trim()
      displayText = before
    }
  }

  const headingAt = body.search(/^#\s+/m)
  if (headingAt > 40) {
    const preamble = cleanPreamble(body.slice(0, headingAt))
    const rest = body.slice(headingAt).trim()
    if (rest.length > 80) {
      displayText = [displayText, preamble].filter(Boolean).join('\n\n').trim()
      body = rest
    }
  }

  body = body.trim()
  if (!body || body.length < 40) return null
  if (!/^#\s+/m.test(body) && body.length < 200) return null

  const title = titleFromMarkdown(body)
  return {
    hasDocument: true,
    markdownBody: body,
    meta: {
      title,
      filename: filename || (title ? slugify(title) : undefined)
    },
    displayText
  }
}

function parseOpenFence(text: string): DocumentBlock | null {
  const match = text.match(OPEN_FENCE_RE)
  if (!match) return null
  if (/```(?:markdown|md)\s*\n[\s\S]*?```/i.test(text)) return null
  const { meta, body } = parseFrontmatter(match[1])
  if (!body.trim()) return null
  const index = match.index ?? 0
  const displayText = cleanPreamble(text.slice(0, index))
  return { hasDocument: true, markdownBody: body.trim(), meta, displayText }
}

/** Prefer the largest fenced markdown block (deliverable), else recover loose/open forms. */
export function parseDocumentBlock(text: string, userRequest?: string): DocumentBlock {
  const sanitized = sanitizeChatText(text)
  const matches: Array<{ raw: string; full: string; index: number }> = []
  FENCE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FENCE_RE.exec(sanitized)) !== null) {
    matches.push({ raw: match[1], full: match[0], index: match.index })
  }

  if (matches.length) {
    const chosen = matches.reduce((best, cur) => (cur.raw.length >= best.raw.length ? cur : best))
    const { meta, body } = parseFrontmatter(chosen.raw)
    if (body.trim()) {
      const before = cleanPreamble(sanitized.slice(0, chosen.index))
      const after = cleanPreamble(sanitized.slice(chosen.index + chosen.full.length))
      const displayText = [before, after].filter(Boolean).join('\n\n').trim()
      return { hasDocument: true, markdownBody: body, meta, displayText }
    }
  }

  const open = parseOpenFence(sanitized)
  if (open) return open

  const loose = parseLooseDocument(sanitized, userRequest)
  if (loose) return loose

  if (userRequest && looksLikeFailedDocumentExport(text) && isDocumentRequest(userRequest)) {
    const inferred = inferDocumentFromRequest(userRequest)
    if (inferred) return inferred
  }

  return {
    hasDocument: false,
    markdownBody: '',
    meta: {},
    displayText: sanitized
  }
}

export function defaultPdfFilename(meta: DocumentMeta): string {
  const base = slugify(meta.filename || meta.title || 'document')
  return `${base}.pdf`
}

export function documentTitle(meta: DocumentMeta): string {
  return meta.title || meta.filename || 'Document'
}
