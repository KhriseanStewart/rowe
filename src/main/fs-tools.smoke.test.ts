import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const testRoot = mkdtempSync(join(tmpdir(), 'rowe-fs-smoke-'))
const settingsRoot = join(testRoot, 'settings')
const workspace = join(testRoot, 'workspace')

mock.module('electron', () => {
  const api = {
    app: {
      getPath: () => settingsRoot,
      on: () => undefined,
      startAccessingSecurityScopedResource: () => () => undefined
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString()
    },
    BrowserWindow: {
      fromWebContents: () => undefined,
      getFocusedWindow: () => undefined,
      getAllWindows: () => []
    },
    dialog: {},
    shell: {
      showItemInFolder: () => undefined,
      openExternal: async () => undefined
    },
    screen: {
      getPrimaryDisplay: () => ({ bounds: { width: 1280, height: 800, x: 0, y: 0 } })
    }
  }
  return { ...api, default: api }
})

describe('filesystem write smoke test', () => {
  beforeAll(async () => {
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'README.md'), 'before\n', 'utf8')
    writeFileSync(join(workspace, 'settings.json'), '{"before":true}\n', 'utf8')

    const { updateSettings } = await import('./settings')
    updateSettings({
      trayWorkspaceRoots: [workspace],
      trayFileAccessGranted: true
    })
  })

  afterAll(() => {
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true, force: true })
  })

  test('replaces a stem-named file and verifies the write', async () => {
    const { fulfillExplicitTextFileRewrite } = await import('./fs-tools')
    const result = await fulfillExplicitTextFileRewrite(
      'Override the current README file and ensure the content in it says Hello Khrisean'
    )

    expect(result?.ok).toBe(true)
    expect(result?.path).toBe(join(workspace, 'README.md'))
    expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toBe('Hello Khrisean\n')
  })

  test('replaces an arbitrary named file through the same path', async () => {
    const { fulfillExplicitTextFileRewrite } = await import('./fs-tools')
    const result = await fulfillExplicitTextFileRewrite(
      'Replace the current settings file and ensure the content in it says enabled'
    )

    expect(result?.ok).toBe(true)
    expect(result?.path).toBe(join(workspace, 'settings.json'))
    expect(readFileSync(join(workspace, 'settings.json'), 'utf8')).toBe('enabled\n')
  })

  test('parses a one-line rowe-tool fence emitted by the gateway', async () => {
    const { extractToolCalls } = await import('./fs-tools')
    const parsed = extractToolCalls(
      '```rowe-tool {"name":"write_file","args":{"path":"settings.json","content":"enabled"}}\n```'
    )

    expect(parsed.calls).toHaveLength(1)
    expect(parsed.calls[0]).toEqual({
      name: 'write_file',
      args: { path: 'settings.json', content: 'enabled' }
    })
    expect(parsed.text).toBe('')
  })

  test('executes real CRUD through the Python worker', async () => {
    const { executeFsTool } = await import('./fs-tools')
    const target = join(workspace, 'python-worker.txt')
    const folder = join(workspace, 'python-worker-folder')

    expect((await executeFsTool({ name: 'write_file', args: { path: target, content: 'alpha' } })).ok).toBe(true)
    expect((await executeFsTool({ name: 'read_file', args: { path: target } })).data).toMatchObject({ content: 'alpha' })
    expect((await executeFsTool({ name: 'patch_file', args: { path: target, old: 'alpha', new: 'beta' } })).ok).toBe(true)
    expect((await executeFsTool({ name: 'mkdir', args: { path: folder } })).ok).toBe(true)
    expect((await executeFsTool({ name: 'delete_path', args: { path: target } })).ok).toBe(true)
    expect((await executeFsTool({ name: 'path_exists', args: { path: target } })).data).toMatchObject({ exists: false })
  })
})
