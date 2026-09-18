interface ImportMetaEnv {
  readonly CURSOR_API_KEY?: string
  readonly GITHUB_CLIENT_ID?: string
  readonly GITHUB_CLIENT_SECRET?: string
  readonly GITHUB_EXCHANGE_URL?: string
  readonly RAG_DATABASE_URL?: string
  readonly OPENROUTER_API_KEY?: string
  readonly OPENROUTER_CHAT_MODEL?: string
  readonly OPENROUTER_EMBEDDING_MODEL?: string
  readonly RAG_CHAT_MODEL?: string
  readonly RAG_OPENROUTER_BASE_URL?: string
  readonly RAG_OMNIROUTE_BASE_URL?: string
  readonly RAG_OMNIROUTE_API_KEY?: string
  readonly RAG_AI_GATEWAY?: string
  readonly RAG_EMBEDDING_MODEL?: string
  readonly RAG_EMBEDDING_DIMENSIONS?: string
  readonly RAG_COMPRESSION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
