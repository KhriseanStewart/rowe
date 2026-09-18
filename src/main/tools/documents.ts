import { app, shell } from 'electron'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx'
import ExcelJS from 'exceljs'
import { exportDocumentPdf } from '../documents'
import { getWorkspaceRoots, isPathGranted } from '../local-folder'
import { getSettings } from '../settings'
import { appendAudit } from './audit-log'
import { putPending } from './pending'
import type { ToolCallResponse, ToolContext } from './types'

function assertWritableTarget(absolute: string): void {
  const roots = getWorkspaceRoots()
  const ok =
    roots.some((root) => absolute === root || absolute.startsWith(root.endsWith('/') ? root : root + '/')) ||
    isPathGranted(absolute) ||
    isPathGranted(dirname(absolute))
  if (!ok) {
    throw new Error(`Blocked path outside granted folders: ${absolute}`)
  }
}

function resolveOutPath(params: Record<string, unknown>, fallbackName: string): string {
  const raw = String(params.path || params.filename || fallbackName).trim()
  if (!raw) throw new Error('Missing output path')
  if (raw.startsWith('/')) return resolve(raw)
  const roots = getWorkspaceRoots()
  const base = roots[0] || app.getPath('documents')
  return resolve(base, raw)
}

async function writeDocx(params: Record<string, unknown>): Promise<{ path: string }> {
  const title = String(params.title || 'Document')
  const body = String(params.content || params.markdown || params.text || '')
  const out = resolveOutPath(params, `${title.replace(/[^\w.-]+/g, '-') || 'document'}.docx`)
  assertWritableTarget(out)
  mkdirSync(dirname(out), { recursive: true })
  const paragraphs = body.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n')
    return new Paragraph({
      children: lines.flatMap((line, i) => {
        const runs = [new TextRun(line)]
        if (i < lines.length - 1) runs.push(new TextRun({ break: 1 }))
        return runs
      })
    })
  })
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
          ...paragraphs
        ]
      }
    ]
  })
  const buffer = await Packer.toBuffer(doc)
  writeFileSync(out, buffer)
  return { path: out }
}

async function writeXlsx(params: Record<string, unknown>): Promise<{ path: string }> {
  const title = String(params.title || 'Sheet')
  const out = resolveOutPath(params, `${title.replace(/[^\w.-]+/g, '-') || 'workbook'}.xlsx`)
  assertWritableTarget(out)
  mkdirSync(dirname(out), { recursive: true })
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(String(params.sheetName || 'Sheet1').slice(0, 31))
  const rows = params.rows
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (Array.isArray(row)) sheet.addRow(row)
      else if (row && typeof row === 'object') sheet.addRow(Object.values(row as Record<string, unknown>))
    }
  } else if (typeof params.content === 'string') {
    for (const line of params.content.split('\n')) {
      sheet.addRow(line.split('\t'))
    }
  } else {
    sheet.addRow([title])
  }
  await workbook.xlsx.writeFile(out)
  return { path: out }
}

export async function runDocumentsTool(
  tool: string,
  params: Record<string, unknown>,
  requestId: string,
  ctx: ToolContext
): Promise<ToolCallResponse> {
  const trusted = ctx.trusted ?? Boolean(getSettings().trustedMode)

  const execute = async (): Promise<ToolCallResponse> => {
    try {
      if (tool === 'documents.pdf') {
        const result = await exportDocumentPdf(
          {
            markdown: String(params.markdown || params.content || ''),
            meta: {
              title: params.title ? String(params.title) : undefined,
              filename: params.filename ? String(params.filename) : undefined,
              subtitle: params.subtitle ? String(params.subtitle) : undefined,
              accent: params.accent ? String(params.accent) : undefined
            }
          },
          ctx.sender
        )
        if ('canceled' in result && result.canceled) {
          appendAudit({ tool, action: 'pdf', status: 'denied', detail: 'User canceled save dialog' })
          return { requestId, status: 'error', error: 'PDF export canceled' }
        }
        const path = (result as { path: string }).path
        appendAudit({ tool, action: 'pdf', path, status: 'success' })
        return { requestId, status: 'success', result: { path, summary: `Wrote PDF ${path}` } }
      }
      if (tool === 'documents.docx') {
        const { path } = await writeDocx(params)
        appendAudit({ tool, action: 'docx', path, status: 'success' })
        return { requestId, status: 'success', result: { path, summary: `Wrote DOCX ${path}` } }
      }
      if (tool === 'documents.xlsx') {
        const { path } = await writeXlsx(params)
        appendAudit({ tool, action: 'xlsx', path, status: 'success' })
        return { requestId, status: 'success', result: { path, summary: `Wrote XLSX ${path}` } }
      }

      if (tool === 'documents.md') {
        const title = String(params.title || 'README')
        const body = String(params.content || params.markdown || params.text || '')
        const out = resolveOutPath(params, `${title.replace(/[^\w.-]+/g, '-') || 'document'}.md`)
        assertWritableTarget(out)
        mkdirSync(dirname(out), { recursive: true })
        const text = body.endsWith('\n') ? body : `${body}\n`
        writeFileSync(out, text, 'utf8')
        appendAudit({ tool, action: 'md', path: out, status: 'success' })
        return { requestId, status: 'success', result: { path: out, summary: `Wrote Markdown ${out}` } }
      }
      if (tool === 'documents.reveal') {
        const path = String(params.path || '')
        if (!path || !existsSync(path)) {
          return { requestId, status: 'error', error: 'File not found to reveal' }
        }
        shell.showItemInFolder(path)
        appendAudit({ tool, action: 'reveal', path, status: 'success' })
        return { requestId, status: 'success', result: { path } }
      }
      return { requestId, status: 'error', error: `Unknown documents tool: ${tool}` }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Document tool failed'
      appendAudit({ tool, action: tool, status: 'error', detail: message })
      return { requestId, status: 'error', error: message }
    }
  }

  if (!trusted && tool !== 'documents.reveal') {
    putPending(requestId, { tool, params, requestId }, execute)
    appendAudit({ tool, action: tool, status: 'pending', detail: 'Awaiting confirmation' })
    return {
      requestId,
      status: 'needs_confirmation',
      confirmation: {
        title: 'Confirm document write',
        summary: `${tool} → ${String(params.path || params.filename || params.title || 'document')}`,
        preview: { tool, params: { ...params, content: params.content ? '[…]' : undefined, markdown: params.markdown ? '[…]' : undefined } }
      }
    }
  }

  return execute()
}
