import { BrowserWindow, dialog } from 'electron'
import { writeFile } from 'fs/promises'
import { marked } from 'marked'

export type DocumentExportMeta = {
  title?: string
  filename?: string
  subtitle?: string
  accent?: string
}

export type ExportDocumentPdfInput = {
  markdown: string
  meta?: DocumentExportMeta
}

export type ExportDocumentPdfResult =
  | { canceled: true }
  | { canceled: false; path: string }

function sanitizeAccent(value: string | undefined): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^#[0-9A-Fa-f]{3,8}$/.test(trimmed)) return trimmed
  if (/^[0-9A-Fa-f]{3,8}$/.test(trimmed)) return `#${trimmed}`
  return undefined
}

function defaultFilename(meta: DocumentExportMeta | undefined): string {
  const base = (meta?.filename || meta?.title || 'document')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${base || 'document'}.pdf`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildPrintHtml(markdown: string, meta: DocumentExportMeta | undefined): string {
  const accent = sanitizeAccent(meta?.accent) || '#111111'
  const title = meta?.title?.trim()
  const subtitle = meta?.subtitle?.trim()
  const bodyHtml = marked.parse(markdown, { async: false, gfm: true }) as string

  const header =
    title || subtitle
      ? `<header class="doc-header">
  ${title ? `<h1 class="doc-title">${escapeHtml(title)}</h1>` : ''}
  ${subtitle ? `<p class="doc-subtitle">${escapeHtml(subtitle)}</p>` : ''}
</header>`
      : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title || 'Document')}</title>
<style>
  :root {
    --doc-accent: ${accent};
    --doc-text: #1a1a1a;
    --doc-muted: #555555;
    --doc-rule: #d0d0d0;
    --doc-code-bg: #f4f4f4;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: #ffffff;
    color: var(--doc-text);
    font-family: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
    font-size: 11pt;
    line-height: 1.45;
  }
  .page {
    padding: 0.75in 0.85in;
    max-width: 8.5in;
  }
  .doc-header {
    margin-bottom: 1.25em;
    padding-bottom: 0.65em;
    border-bottom: 1.5px solid var(--doc-accent);
  }
  .doc-title {
    margin: 0;
    font-size: 20pt;
    font-weight: 650;
    letter-spacing: -0.01em;
    color: var(--doc-accent);
    line-height: 1.2;
  }
  .doc-subtitle {
    margin: 0.35em 0 0;
    font-size: 11pt;
    color: var(--doc-muted);
  }
  .content > :first-child { margin-top: 0; }
  .content > :last-child { margin-bottom: 0; }
  h1, h2, h3, h4 {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: var(--doc-accent);
    line-height: 1.25;
    page-break-after: avoid;
  }
  h1 { font-size: 16pt; margin: 1.4em 0 0.45em; }
  h2 { font-size: 13pt; margin: 1.25em 0 0.4em; }
  h3, h4 { font-size: 11.5pt; margin: 1.1em 0 0.35em; color: var(--doc-text); }
  p { margin: 0 0 0.75em; }
  ul, ol { margin: 0 0 0.85em; padding-left: 1.35em; }
  li + li { margin-top: 0.25em; }
  li > p { margin: 0; }
  a { color: var(--doc-accent); text-decoration: underline; }
  hr {
    border: 0;
    border-top: 1px solid var(--doc-rule);
    margin: 1.25em 0;
  }
  strong { font-weight: 650; }
  code {
    font-family: "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.88em;
    background: var(--doc-code-bg);
    padding: 0.1em 0.3em;
    border-radius: 3px;
  }
  pre {
    background: var(--doc-code-bg);
    padding: 0.75em 0.9em;
    overflow-x: auto;
    border-radius: 4px;
    page-break-inside: avoid;
    margin: 0 0 0.9em;
  }
  pre code {
    background: none;
    padding: 0;
    font-size: 0.85em;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 0 0 1em;
    font-size: 10pt;
    page-break-inside: avoid;
  }
  th, td {
    border: 1px solid var(--doc-rule);
    padding: 0.4em 0.55em;
    text-align: left;
    vertical-align: top;
  }
  th {
    background: #f7f7f7;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-weight: 600;
  }
  blockquote {
    margin: 0 0 0.9em;
    padding: 0.15em 0 0.15em 0.85em;
    border-left: 3px solid var(--doc-accent);
    color: var(--doc-muted);
  }
  img { max-width: 100%; }
</style>
</head>
<body>
  <div class="page">
    ${header}
    <div class="content">${bodyHtml}</div>
  </div>
</body>
</html>`
}

export async function exportDocumentPdf(
  input: ExportDocumentPdfInput,
  sender?: Electron.WebContents
): Promise<ExportDocumentPdfResult> {
  const markdown = input.markdown?.trim()
  if (!markdown) {
    throw new Error('Document markdown is empty.')
  }

  const parent = sender ? BrowserWindow.fromWebContents(sender) : BrowserWindow.getFocusedWindow()
  const defaultPath = defaultFilename(input.meta)
  const save = parent
    ? await dialog.showSaveDialog(parent, {
        title: 'Save PDF',
        defaultPath,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
    : await dialog.showSaveDialog({
        title: 'Save PDF',
        defaultPath,
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })

  if (save.canceled || !save.filePath) {
    return { canceled: true }
  }

  const html = buildPrintHtml(markdown, input.meta)
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'Letter',
      margins: {
        marginType: 'default'
      }
    })
    const target = save.filePath.endsWith('.pdf') ? save.filePath : `${save.filePath}.pdf`
    await writeFile(target, pdf)
    return { canceled: false, path: target }
  } finally {
    if (!win.isDestroyed()) {
      win.destroy()
    }
  }
}
