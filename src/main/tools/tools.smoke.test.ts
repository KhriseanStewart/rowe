import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createServer } from 'net'

const testRoot = mkdtempSync(join(tmpdir(), 'rowe-tools-smoke-'))
const settingsRoot = join(testRoot, 'settings')
const workspace = join(testRoot, 'workspace')

const electronApi = {
  app: {
    getPath: (_name?: string) => settingsRoot,
    on: () => undefined,
    startAccessingSecurityScopedResource: () => () => undefined
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  BrowserWindow: Object.assign(
    class MockBrowserWindow {
      webContents = { id: 1, send: () => undefined }
      isDestroyed() {
        return false
      }
      setIgnoreMouseEvents() {
        return undefined
      }
      setAlwaysOnTop() {
        return undefined
      }
      showInactive() {
        return undefined
      }
      close() {
        return undefined
      }
      async loadURL() {
        return undefined
      }
    },
    {
      fromWebContents: () => undefined,
      getFocusedWindow: () => undefined,
      getAllWindows: () => []
    }
  ),
  dialog: {
    showSaveDialog: async () => ({ canceled: true })
  },
  shell: {
    showItemInFolder: () => undefined,
    openExternal: async () => undefined
  },
  screen: {
    getPrimaryDisplay: () => ({ bounds: { width: 1280, height: 800, x: 0, y: 0 } })
  }
}

mock.module('electron', () => ({
  ...electronApi,
  default: electronApi
}))

describe('tools router smoke', () => {
  beforeAll(async () => {
    mkdirSync(workspace, { recursive: true })
    mkdirSync(join(settingsRoot, 'logs'), { recursive: true })
    writeFileSync(join(workspace, 'note.txt'), 'hello\n', 'utf8')

    const { updateSettings } = await import('../settings')
    updateSettings({
      trayWorkspaceRoots: [workspace],
      trayFileAccessGranted: true,
      trustedMode: true
    })
  })

  afterAll(() => {
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: true })
  })

  test('TOOL_NAMES includes clone/push/md', async () => {
    const { TOOL_NAMES } = await import('./router')
    expect(TOOL_NAMES).toContain('github.clone')
    expect(TOOL_NAMES).toContain('github.pull')
    expect(TOOL_NAMES).toContain('github.push')
    expect(TOOL_NAMES).toContain('documents.md')
    expect(TOOL_NAMES).toContain('os.click')
  })

  test('filesystem.read resolves under granted root', async () => {
    const { invokeTool } = await import('./router')
    const res = await invokeTool({
      tool: 'filesystem.read',
      params: { path: 'note.txt' },
      requestId: 'smoke-read-1'
    })
    expect(res.status).toBe('success')
    expect(String(res.result?.path || '')).toContain('note.txt')
  })

  test('filesystem.write in trusted mode writes and audits', async () => {
    const { invokeTool } = await import('./router')
    const { listAuditLog } = await import('./audit-log')
    const res = await invokeTool({
      tool: 'filesystem.write',
      params: { path: 'written.txt', content: 'smoke-ok' },
      requestId: 'smoke-write-1'
    })
    expect(res.status).toBe('success')
    const out = join(workspace, 'written.txt')
    expect(existsSync(out)).toBe(true)
    expect(readFileSync(out, 'utf8')).toBe('smoke-ok')
    const audit = listAuditLog(20)
    expect(audit.some((e) => e.tool === 'filesystem.write' && e.status === 'success')).toBe(true)
  })

  test('mutating write needs confirmation when trusted mode is off', async () => {
    const { updateSettings } = await import('../settings')
    updateSettings({ trustedMode: false })
    const { invokeTool, confirmTool } = await import('./router')
    const pending = await invokeTool({
      tool: 'filesystem.write',
      params: { path: 'confirm-me.txt', content: 'after-confirm' },
      requestId: 'smoke-confirm-1'
    })
    expect(pending.status).toBe('needs_confirmation')
    expect(pending.confirmation?.title).toBeTruthy()

    const declined = await confirmTool('smoke-confirm-1', false)
    expect(declined.status).toBe('error')
    expect(existsSync(join(workspace, 'confirm-me.txt'))).toBe(false)

    const pending2 = await invokeTool({
      tool: 'filesystem.write',
      params: { path: 'confirm-me.txt', content: 'after-confirm' },
      requestId: 'smoke-confirm-2'
    })
    expect(pending2.status).toBe('needs_confirmation')
    const approved = await confirmTool('smoke-confirm-2', true)
    expect(approved.status).toBe('success')
    expect(readFileSync(join(workspace, 'confirm-me.txt'), 'utf8')).toBe('after-confirm')

    updateSettings({ trustedMode: true })
  })

  test('documents.md writes under granted root', async () => {
    const { invokeTool } = await import('./router')
    const res = await invokeTool({
      tool: 'documents.md',
      params: { path: 'SMOKE.md', title: 'Smoke', content: '# Smoke\n\nok' },
      requestId: 'smoke-md-1'
    })
    expect(res.status).toBe('success')
    const out = join(workspace, 'SMOKE.md')
    expect(existsSync(out)).toBe(true)
    expect(readFileSync(out, 'utf8')).toContain('# Smoke')
  })

  test('github tools without auth return needs_permission/error cleanly', async () => {
    const { updateSettings } = await import('../settings')
    updateSettings({ githubToken: undefined, github: undefined })
    const { invokeTool } = await import('./router')
    const res = await invokeTool({
      tool: 'github.get_repo',
      params: { repo: 'KhriseanStewart/rowe' },
      requestId: 'smoke-gh-1'
    })
    expect(['error', 'needs_permission']).toContain(res.status)
    expect(res.error || '').toMatch(/GitHub|connect|token|APP/i)
  })

  test('stream server binds localhost port', async () => {
    const { startToolStreamServer, getToolStreamPort, stopToolStreamServer } = await import('./stream-server')
    const port = startToolStreamServer()
    expect(port).toBeGreaterThan(0)
    expect(getToolStreamPort()).toBe(port)
    const canBind = await new Promise<boolean>((resolve) => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(true))
      })
    })
    expect(canBind).toBe(false)
    stopToolStreamServer()
  })
})
