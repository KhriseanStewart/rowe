
import { describe, expect, test } from 'bun:test'
import { buildCursorHandoff } from './handoff'
import { chunkText, redactSecrets } from './ingest'
import { reciprocalRankFusion } from './retrieve'
import { compressionPolicy } from './system-ai'

describe('secret redaction', () => {
  test('redacts api keys and connection strings', () => {
    const input = [
      'api_key = "sk-abcdefghijklmnopqrstuvwxyz"',
      'DATABASE_URL=postgresql://user:pass@localhost:5432/db',
      '-----BEGIN RSA PRIVATE KEY-----',
      'abc',
      '-----END RSA PRIVATE KEY-----'
    ].join('\n')
    const redacted = redactSecrets(input)
    expect(redacted).toContain('[REDACTED]')
    expect(redacted).toContain('[REDACTED_CONNECTION]')
    expect(redacted).toContain('[REDACTED_PRIVATE_KEY]')
    expect(redacted).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    expect(redacted).not.toContain('user:pass@localhost')
  })
})

describe('chunking', () => {
  test('keeps line ranges and symbols', () => {
    const source = Array.from({ length: 120 }, (_, index) => {
      if (index === 10) return 'export function searchRag() {'
      if (index === 11) return '  return []'
      if (index === 12) return '}'
      return `line ${index + 1}`
    }).join('\n')
    const chunks = chunkText(source)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].start).toBe(1)
    expect(chunks.some((chunk) => chunk.symbol === 'searchRag')).toBe(true)
    expect(chunks.every((chunk) => chunk.end >= chunk.start)).toBe(true)
  })
})

describe('retrieval helpers', () => {
  test('reciprocal rank fusion merges lists', () => {
    const a = [
      hit('1', 1),
      hit('2', 0.5)
    ]
    const b = [
      hit('2', 0.9),
      hit('3', 0.8)
    ]
    const fused = reciprocalRankFusion([a, b], 60)
    expect(fused[0].id).toBe('2')
    expect(fused.map((item) => item.id).sort()).toEqual(['1', '2', '3'])
  })
})

describe('system ai helpers', () => {
  test('OpenRouter skips OmniRoute compression because Snip handles it', () => {
    expect(
      compressionPolicy({
        gateway: 'OpenRouter',
        containsCode: true,
        containsJson: false,
        isRagContext: true,
        cameFromSnip: false
      })
    ).toBe('off')
  })

  test('OmniRoute uses its built-in compressor for RAG', () => {
    expect(
      compressionPolicy({
        gateway: 'OmniRoute',
        containsCode: true,
        containsJson: false,
        isRagContext: true,
        cameFromSnip: false
      })
    ).toBe('safe')
  })
})

describe('cursor handoff', () => {
  test('builds citation-preserving brief', () => {
    const brief = buildCursorHandoff({
      task: 'Port auth middleware',
      targetWorkspace: '/Users/me/app',
      citations: [
        {
          id: '1',
          projectId: 'p1',
          projectName: 'auth-lib',
          path: 'src/session.ts',
          language: 'ts',
          symbol: 'createSession',
          startLine: 20,
          endLine: 74,
          content: '20| export function createSession() {}',
          score: 1
        }
      ]
    })
    expect(brief).toContain('Task: Port auth middleware')
    expect(brief).toContain('auth-lib/src/session.ts:20-74')
    expect(brief).toContain('createSession')
    expect(brief).not.toContain('20|')
  })
})

describe('workspace name matching', () => {
  test('maps misspellings to the closest local app name', async () => {
    const { scoreNameMatch, extractNameQueries, contextualMatchBoost } = await import('./workspace-match')
    expect(scoreNameMatch('payemm-mobile', 'payemm_mobile_app')).toBeGreaterThan(0.7)
    expect(scoreNameMatch('payemm mobile', 'payemm_mobile_app')).toBeGreaterThan(0.7)
    expect(scoreNameMatch('Dating-App', 'Dating-App-Api')).toBeGreaterThan(0.7)
    expect(extractNameQueries('What package is used for state management in payemm-mobile')).toContain(
      'payemm-mobile'
    )
    expect(extractNameQueries('Check the codebase for Payemm app')).toContain('payemm app')

    const question = 'Check the codebase for Payemm app and let me know on a scale of 1 - 10 how good it is currently'
    const names = [
      { name: 'Dating-App-Api', local: false, path: undefined as string | undefined },
      { name: 'EduDesk_LMS', local: false, path: undefined },
      {
        name: 'payemm_mobile_app',
        local: true,
        path: '/Users/me/dev/projects/flutter/payemm_mobile_app'
      },
      { name: 'payemm-admin-portal', local: true, path: '/Users/me/dev/projects/React/payemm-admin-portal' },
      { name: 'payemm-api', local: true, path: '/Users/me/dev/projects/Laravel/payemm-api' },
      { name: 'manual_tests', local: true, path: '/Users/me/dev/flutter/dev/manual_tests' }
    ]
    const queries = extractNameQueries(question)
    let best = { name: '', score: 0 }
    for (const query of queries) {
      for (const candidate of names) {
        const score =
          scoreNameMatch(query, candidate.name) +
          contextualMatchBoost(question, candidate.name, candidate.local, candidate.path)
        if (score > best.score) best = { name: candidate.name, score }
      }
    }
    expect(best.name).toBe('payemm_mobile_app')
  })
})

function hit(id: string, score: number) {
  return {
    id,
    documentId: id,
    chunkIndex: 0,
    projectId: 'p',
    projectName: 'demo',
    path: 'a.ts',
    language: 'ts',
    symbol: null,
    startLine: 1,
    endLine: 2,
    content: 'code',
    score
  }
}
