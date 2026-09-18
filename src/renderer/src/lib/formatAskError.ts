/** Turn IPC / provider errors into short user-facing copy. */
export function formatAskError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Something went wrong'
  const text = raw.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '').trim()

  if (/rate[- ]?limit|429|too many requests/i.test(text)) {
    const model = text.match(/model ['"]([^'"]+)['"]/i)?.[1]
    if (model) {
      return `OpenRouter rate-limited ${model}. Wait a moment and try again, or switch models / add credits in Settings.`
    }
    return 'OpenRouter rate-limited this model. Wait a moment and try again, or switch models / add credits in Settings.'
  }

  if (/network|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(text)) {
    return 'Network error talking to the model. Check your connection and try again.'
  }

  if (/folder access was not granted|not granted/i.test(text)) {
    return text
  }

  if (/ENOENT|no such file or directory/i.test(text)) {
    const path = text.match(/['"]([^'"]+)['"]/)?.[1] || text.match(/stat '([^']+)'/)?.[1]
    if (path) {
      return `That path doesn’t exist on disk: ${path}. Check the folder name and try again.`
    }
    return 'That file or folder doesn’t exist on disk. Check the path and try again.'
  }

  // Drop Electron IPC wrapper noise; keep the useful bit
  return text || 'Something went wrong'
}
