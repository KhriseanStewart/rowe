/** Pure write-intent helpers (no Electron) — safe for unit tests. */

export function extractNamedWriteTarget(question: string): string | null {
  const explicitPath = question.match(
    /\b([\w./-]+\.(?:dart|tsx?|jsx?|py|swift|kt|java|go|rs|css|scss|html|md|json|ya?ml|txt|xml|sh|rb))\b/i
  )
  if (explicitPath?.[1]) return explicitPath[1]

  const named = question.match(
    /\b(?:the\s+)?(?:current\s+)?([A-Za-z][\w.-]{1,80})\s+(?:file|document)\b/i
  )
  if (
    named?.[1] &&
    !['this', 'that', 'current', 'content', 'contents', 'text'].includes(named[1].toLowerCase())
  ) {
    return named[1]
  }

  const called = question.match(/\b(?:file|document)\s+(?:named|called)\s+["']?([\w./-]+)["']?/i)
  if (called?.[1]) return called[1]

  // "the README" / "README.md" — not bare "readme" inside other phrases
  const bareDoc =
    question.match(
      /\b(?:the(?:\s+[\w.-]+){0,3}\s+|our\s+|project\s+)(readme|changelog|license|contributing)(?:\.md)?\b/i
    ) || question.match(/\b(readme|changelog|license|contributing)\.md\b/i)
  if (bareDoc?.[1]) {
    const base = bareDoc[1]
    return /\./.test(base) ? base : `${base}.md`
  }

  return null
}

export function isGeneratedDocumentWriteRequest(question: string): boolean {
  const value = question.toLowerCase()
  const named = Boolean(extractNamedWriteTarget(question))
  if (!named) return false
  const wantsWrite =
    /\b(write|update|create|generate|make|put|save|draft|replace|overwrite|rewrite|refresh)\b/.test(
      value
    )
  const wantsDoc =
    /\b(readme|changelog|license|contributing|description|docs?|documentation|content|contents)\b/.test(
      value
    ) || /\.(md|txt|rst)\b/.test(value)
  return wantsWrite && wantsDoc
}

/** Git / package-manager / build / CLI asks that should use shell (or github tools), not write_file. */
export function isPrimarilyDevCommandAsk(question: string): boolean {
  const q = question.toLowerCase()
  const namedFile = Boolean(extractNamedWriteTarget(question))

  if (/\b(create|make|cut)\s+(a\s+)?(new\s+)?branch\b/.test(q)) return true
  if (/\b(checkout|switch)\s+(to\s+)?(a\s+)?(new\s+)?branch\b/.test(q)) return true
  if (/\bgit\b/.test(q) && !namedFile) return true
  if (
    /\b(push|pull|clone|fetch|merge|rebase|commit|stash|tag)\b/.test(q) &&
    /\b(branch|commits?|origin|remote|pr|pull request|repo|repository|upstream)\b/.test(q) &&
    !namedFile
  ) {
    return true
  }
  if (/\b(open|create|make)\s+(a\s+)?(pr|pull request)\b/.test(q) && !namedFile) return true
  // Explicit "run/execute this command" style asks
  if (
    /\b(run|execute|invoke)\b/.test(q) &&
    /\b(command|shell|terminal|cli|script|npm|pnpm|yarn|bun|npx|git|gh|docker|kubectl|flutter|dart|cargo|pip|make|cmake|tsc|typecheck)\b/.test(
      q
    ) &&
    !namedFile
  ) {
    return true
  }
  if (
    /\b(npm|pnpm|yarn|bun|npx|cargo|pip|poetry|gradle|mvn|make|cmake|docker|kubectl|flutter|dart|gh|tsc)\b/.test(
      q
    ) &&
    /\b(install|test|build|run|start|lint|format|publish|deploy|typecheck|check|dev|serve|compile|exec)\b/.test(
      q
    ) &&
    !namedFile
  ) {
    return true
  }
  // Bare developer workflows without a named file target
  if (
    /\b(typecheck|unit tests?|e2e|smoke test|ci|deploy|docker compose|kubectl)\b/.test(q) &&
    !namedFile
  ) {
    return true
  }
  return false
}

export function wantsFileMutation(question: string): boolean {
  if (isPrimarilyDevCommandAsk(question)) return false
  return /\b(add|edit|update|change|write|create|delete|remove|rename|fix|insert|comment|fix_file|create_file|make|generate|replace|overwrite|rewrite|refresh)\b/i.test(
    question
  )
}
