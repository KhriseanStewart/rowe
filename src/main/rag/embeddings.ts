export type EmbeddingModel = {
  id: string
  dimensions: number
}

const DEFAULT_MODEL = 'openai/text-embedding-3-small'
const DEFAULT_DIMENSIONS = 1536

/** Prefer free/cheap models when the primary returns 402 Payment Required. */
const FALLBACK_MODELS = [
  'openai/text-embedding-3-small',
  'text-embedding-3-small',
  'openai/text-embedding-ada-002',
  'thenlper/gte-small',
  'openrouter/auto'
]

export function embeddingModel(): EmbeddingModel {
  return {
    id: env('RAG_EMBEDDING_MODEL') || env('OPENROUTER_EMBEDDING_MODEL') || DEFAULT_MODEL,
    dimensions: Number(env('RAG_EMBEDDING_DIMENSIONS') || DEFAULT_DIMENSIONS)
  }
}

export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmbeddingUnavailableError'
  }
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) return []
  const primary = embeddingModel()
  const attempts = embeddingEndpoints()
  if (!attempts.length) {
    throw new EmbeddingUnavailableError(
      'Set OPENROUTER_API_KEY or RAG_OMNIROUTE_API_KEY to enable embeddings.'
    )
  }

  const models = uniqueModels([
    primary.id,
    ...FALLBACK_MODELS,
    env('RAG_EMBEDDING_FALLBACK_MODEL') || ''
  ])

  let lastError: unknown
  let sawPaymentRequired = false

  for (const modelId of models) {
    for (const endpoint of attempts) {
      try {
        const response = await fetch(`${endpoint.base}/embeddings`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${endpoint.key}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://rowe.local',
            'X-Title': 'Rowe'
          },
          body: JSON.stringify({ model: modelId, input: texts })
        })
        if (response.status === 402) {
          sawPaymentRequired = true
          lastError = new EmbeddingUnavailableError(
            `Embedding request failed (402) for model "${modelId}".`
          )
          continue
        }
        if (!response.ok) {
          lastError = new Error(`Embedding request failed (${response.status}) for model "${modelId}".`)
          continue
        }
        const payload = (await response.json()) as {
          data?: Array<{ embedding?: number[]; index?: number }>
        }
        const rows = payload.data || []
        return texts.map((_, index) => {
          const row = rows.find((item) => item.index === index) || rows[index]
          const vector = row?.embedding
          if (!vector?.length) {
            throw new Error('Embedding response was incomplete.')
          }
          return normalizeDimensions(vector, primary.dimensions)
        })
      } catch (caught) {
        lastError = caught
      }
    }
  }

  if (sawPaymentRequired) {
    throw new EmbeddingUnavailableError(
      lastError instanceof Error
        ? lastError.message
        : 'Embedding request failed (402). Indexed without vectors; keyword search still works.'
    )
  }
  throw lastError instanceof Error ? lastError : new EmbeddingUnavailableError('Embedding request failed.')
}

export async function embedQuery(question: string): Promise<number[] | null> {
  if (!embeddingsConfigured() || !question.trim()) {
    return null
  }
  try {
    const [vector] = await embedTexts([question.slice(0, 8000)])
    return vector
  } catch (error) {
    if (error instanceof EmbeddingUnavailableError) return null
    throw error
  }
}

export function toVectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`
}

function normalizeDimensions(vector: number[], dimensions: number): number[] {
  if (vector.length === dimensions) return vector
  if (vector.length > dimensions) return vector.slice(0, dimensions)
  return [...vector, ...Array.from({ length: dimensions - vector.length }, () => 0)]
}

export function embeddingsConfigured(): boolean {
  return embeddingEndpoints().length > 0
}

function uniqueModels(ids: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function embeddingEndpoints(): Array<{ base: string; key: string }> {
  const openrouterKey = env('OPENROUTER_API_KEY')
  const omniKey = env('RAG_OMNIROUTE_API_KEY')
  const openrouterBase = (env('RAG_OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1').replace(
    /\/$/,
    ''
  )
  const omniBase = (env('RAG_OMNIROUTE_BASE_URL') || 'http://127.0.0.1:20128/v1').replace(/\/$/, '')
  const gateway = (env('RAG_AI_GATEWAY') || '').toLowerCase()
  const endpoints: Array<{ base: string; key: string }> = []
  // Prefer OmniRoute first for local/cheap routing when configured.
  if (omniKey) endpoints.push({ base: omniBase, key: omniKey })
  if (openrouterKey && !endpoints.some((item) => item.base === openrouterBase)) {
    endpoints.push({ base: openrouterBase, key: openrouterKey })
  }
  if (gateway === 'openrouter' && openrouterKey) {
    return [{ base: openrouterBase, key: openrouterKey }, ...endpoints.filter((e) => e.base !== openrouterBase)]
  }
  return endpoints
}

function env(name: string): string | undefined {
  const viteEnv = import.meta.env as unknown as Record<string, string | undefined>
  return process.env[name]?.trim() || viteEnv[name]?.trim()
}
