const HARD_STOP = new Set([
  'a',
  'an',
  'and',
  'for',
  'from',
  'in',
  'is',
  'my',
  'of',
  'on',
  'or',
  'the',
  'to',
  'used',
  'using',
  'what',
  'which',
  'with',
  'how',
  'good',
  'check',
  'let',
  'know',
  'scale',
  'currently',
  'codebase',
  'codebases'
])

/** Soft words kept when attached to a brand-like token ("Payemm app"). */
const SOFT_WORDS = new Set([
  'app',
  'apps',
  'mobile',
  'api',
  'admin',
  'portal',
  'web',
  'ios',
  'android',
  'backend',
  'frontend',
  'project',
  'projects',
  'repo',
  'repos',
  'package',
  'packages',
  'state'
])

export function scoreNameMatch(query: string, name: string): number {
  const q = normalizeName(query)
  const n = normalizeName(name)
  if (!q || !n) return 0
  if (q === n) return 1

  let score = 0

  // Brand / prefix hits should not be crushed by longer folder names.
  if (n.startsWith(q) && q.length >= 4) {
    score = Math.max(score, 0.86)
  } else if (n.includes(q) && q.length >= 5) {
    score = Math.max(score, 0.78)
  } else if (q.includes(n) && n.length >= 5) {
    score = Math.max(score, 0.74)
  } else if (n.includes(q) || q.includes(n)) {
    const ratio = Math.min(q.length, n.length) / Math.max(q.length, n.length)
    score = Math.max(score, Math.min(0.98, ratio + 0.18))
  }

  const qTokens = tokensOf(query)
  const nTokens = tokensOf(name)
  if (qTokens.length && nTokens.length) {
    const overlap = qTokens.filter((token) =>
      nTokens.some((part) => part === token || part.includes(token) || token.includes(part))
    ).length
    const tokenScore = overlap / Math.max(qTokens.length, 1)
    score = Math.max(score, tokenScore)

    // "payemm" + "app" / "mobile" aligning with folder tokens
    const softBoost = qTokens.filter((token) => SOFT_WORDS.has(token) && nTokens.some((part) => part.includes(token)))
      .length
    if (softBoost && overlap) {
      score = Math.min(0.99, score + 0.08 * softBoost)
    }
  }

  score = Math.max(score, levenshteinRatio(q, n))
  return score
}

/** Prefer the right sibling when several projects share a brand (payemm-api vs payemm_mobile_app). */
export function contextualMatchBoost(
  question: string,
  name: string,
  isLocal: boolean,
  path?: string
): number {
  const lower = question.toLowerCase()
  const n = name.toLowerCase()
  let boost = 0
  if (isLocal) boost += 0.1
  if (path && /\/projects\//i.test(path)) boost += 0.12
  if (path && isSdkNoisePath(path)) boost -= 0.5
  if (/\b(app|mobile|flutter|ios|android)\b/.test(lower) && /(mobile|app|flutter)/.test(n)) boost += 0.16
  if (/\b(api|backend|server)\b/.test(lower) && /(api|backend|server)/.test(n)) boost += 0.16
  if (/\b(admin|portal|dashboard)\b/.test(lower) && /(admin|portal|dashboard)/.test(n)) boost += 0.16
  if (/\b(codebase|code base|rate|review|how good|manual|screen|branding)\b/.test(lower) && isLocal) {
    boost += 0.06
  }
  return boost
}

/** Flutter SDK / tooling trees — not user apps. */
export function isSdkNoisePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  if (/\/flutter\/(bin|dev|examples|packages|engine|artifacts|flutter_frontend_server)\b/i.test(normalized)) {
    return true
  }
  if (/\/(manual_tests|robot_tester|flutter_tools|customer_testing)\b/i.test(normalized)) {
    return true
  }
  return false
}

export function extractNameQueries(question: string): string[] {
  const out = new Set<string>()
  for (const match of question.matchAll(/\b[a-zA-Z][a-zA-Z0-9]*(?:[-_][a-zA-Z0-9]+)+\b/g)) {
    out.add(match[0])
  }

  const raw = question
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !/^\d+$/.test(token))

  for (let i = 0; i < raw.length; i += 1) {
    const token = raw[i]
    const next = raw[i + 1]
    const next2 = raw[i + 2]

    // "payemm app", "payemm mobile app"
    if (!HARD_STOP.has(token) && token.length >= 3) {
      if (next && SOFT_WORDS.has(next)) {
        out.add(`${token} ${next}`)
        if (next2 && SOFT_WORDS.has(next2)) {
          out.add(`${token} ${next} ${next2}`)
        }
      }
      if (!SOFT_WORDS.has(token)) {
        out.add(token)
      }
    }
  }

  const content = raw.filter((token) => token.length >= 3 && !HARD_STOP.has(token) && !SOFT_WORDS.has(token))
  for (let i = 0; i < content.length; i += 1) {
    out.add(content[i])
    if (i + 1 < content.length) out.add(`${content[i]} ${content[i + 1]}`)
  }

  return [...out].sort((a, b) => b.length - a.length)
}

export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function tokensOf(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
}

function levenshteinRatio(a: string, b: string): number {
  if (!a.length || !b.length) return 0
  if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.5) return 0
  const rows = a.length + 1
  const cols = b.length + 1
  const matrix = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  for (let i = 0; i < rows; i += 1) matrix[i][0] = i
  for (let j = 0; j < cols; j += 1) matrix[0][j] = j
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      )
    }
  }
  const distance = matrix[a.length][b.length]
  return 1 - distance / Math.max(a.length, b.length)
}
