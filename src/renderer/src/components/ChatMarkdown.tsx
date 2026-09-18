import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  defaultPdfFilename,
  documentTitle,
  parseDocumentBlock
} from '../lib/document-block'

type ChatMarkdownProps = {
  text: string
  tone: 'user' | 'assistant'
  onCite?: (index: number) => void
  hideCopy?: boolean
  /** User prompt that triggered this assistant reply (for document recovery). */
  userRequest?: string
}

function stripRoweEditFences(value: string): string {
  return value
    .replace(/```rowe-edit[^\n]*\r?\n?[\s\S]*?```/gi, '')
    .replace(/```rowe-tool[^\n]*\r?\n?[\s\S]*?```/gi, '')
    .replace(/```rowe-tasks[^\n]*\r?\n?[\s\S]*?```/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<\/?tool_call>|<\/?arg_key>|<\/?arg_value>|<\/?parameter>|<\/?parameters>/gi, '')
    .replace(/\bresponse\s+safety\s*:\s*\w+/gi, '')
    .replace(/\b(?:user\s+|model\s+)?safety\s*:\s*\w+/gi, '')
    .replace(/^\s*(?:user\s+|response\s+|model\s+)?safety\s*:\s*.+$/gim, '')
    .replace(/\[?(?:list_dir|read_file|write_file|mkdir|delete_path|path_exists|run_shell|patch_file)\s*\([^\)]*\)\]?/gi, '')
    .replace(/^[\s>*•\-]*✓?\s*(?:Read|Wrote|Patched|Deleted|Created|Shell|Indexed|Applied)[^\n]*$/gim, '')
    .replace(/^\s*(?:\/Users\/|~\/|[A-Za-z]:\\)[^\n]*?(?:\(\d+\s*chars[^)]*\))?\s*$/gim, '')
    .replace(/\(\d+\s*chars(?:[^)]*)?\)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function linkCitations(text: string): string {
  return text.replace(/(?<![A-Za-z0-9_/])\[(\d{1,2})\]/g, '[$1](#cite-$1)')
}

function ChatMarkdown({
  text,
  tone,
  onCite,
  hideCopy,
  userRequest
}: ChatMarkdownProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [exportLabel, setExportLabel] = useState('Download PDF')
  const doc = parseDocumentBlock(text, userRequest)
  const showCopy = !hideCopy && !doc.hasDocument
  const visibleText = stripRoweEditFences(doc.displayText)
  if (!visibleText && !doc.hasDocument) {
    return <></>
  }

  const copy = async (): Promise<void> => {
    const value = (doc.hasDocument ? doc.markdownBody : text).trim()
    if (!value) {
      return
    }
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      const area = window.document.createElement('textarea')
      area.value = value
      area.style.position = 'fixed'
      area.style.left = '-9999px'
      window.document.body.appendChild(area)
      area.select()
      window.document.execCommand('copy')
      area.remove()
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  const downloadPdf = async (): Promise<void> => {
    if (!doc.hasDocument) return
    setExportLabel('Exporting…')
    try {
      const result = await window.api.exportDocumentPdf({
        markdown: doc.markdownBody,
        meta: {
          ...doc.meta,
          filename: doc.meta.filename || defaultPdfFilename(doc.meta).replace(/\.pdf$/, '')
        }
      })
      if (result.canceled) {
        setExportLabel('Canceled')
      } else {
        setExportLabel('Saved')
      }
    } catch {
      setExportLabel('Failed')
    }
    window.setTimeout(() => setExportLabel('Download PDF'), 1600)
  }

  if (doc.hasDocument) {
    const title = documentTitle(doc.meta)
    const file = defaultPdfFilename(doc.meta)
    const preview =
      doc.markdownBody.length > 900 ? `${doc.markdownBody.slice(0, 900).trimEnd()}…` : doc.markdownBody

    return (
      <div className="group/copy relative">
        <div className="doc-card">
          <div className="doc-card-bar">
            <div className="min-w-0 flex-1">
              <p className="doc-card-kicker">PDF ready</p>
              <p className="doc-card-title">{title}</p>
              <p className="doc-card-file">{file}</p>
            </div>
            <button
              type="button"
              className="doc-card-action"
              disabled={exportLabel === 'Exporting…'}
              onClick={() => {
                void downloadPdf()
              }}
            >
              {exportLabel}
            </button>
          </div>
          {visibleText ? (
            <div className="doc-card-summary chat-md">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{visibleText}</ReactMarkdown>
            </div>
          ) : null}
          <div className="doc-card-preview chat-md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview}</ReactMarkdown>
          </div>
          <button
            type="button"
            className="doc-card-link"
            disabled={exportLabel === 'Exporting…'}
            onClick={() => {
              void downloadPdf()
            }}
          >
            {exportLabel === 'Download PDF' ? `Download ${file}` : exportLabel}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="group/copy relative">
      <div className={tone === 'user' ? 'chat-md chat-md-user' : 'chat-md'}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => {
              const cite = href?.match(/^#cite-(\d+)$/)
              if (cite) {
                const index = Number(cite[1])
                return (
                  <button
                    type="button"
                    className="cite-chip"
                    aria-label={`Source ${index}`}
                    onClick={() => onCite?.(index - 1)}
                  >
                    {index}
                  </button>
                )
              }
              return (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              )
            }
          }}
        >
          {linkCitations(visibleText)}
        </ReactMarkdown>
      </div>
      {showCopy ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="text-[11px] text-current/70 underline-offset-2 hover:underline"
            onClick={() => {
              void copy()
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default ChatMarkdown
