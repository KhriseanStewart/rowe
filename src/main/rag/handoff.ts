import type { RetrievedChunk } from './retrieve'

export type HandoffInput = {
  task: string
  targetWorkspace?: string
  citations: RetrievedChunk[]
  constraints?: string
}

export function buildCursorHandoff(input: HandoffInput): string {
  const selected = input.citations.slice(0, 8)
  const refs = selected
    .map((item) => {
      const start = item.startLine ?? 1
      const end = item.endLine ?? start
      return `  - ${item.projectName}/${item.path}:${start}-${end}${item.symbol ? ` (${item.symbol})` : ''}`
    })
    .join('\n')
  const excerpts = selected
    .map((item) => {
      const start = item.startLine ?? 1
      const end = item.endLine ?? start
      return `<reference project="${item.projectName}" path="${item.path}" lines="${start}-${end}">\n${stripLinePrefixes(item.content)}\n</reference>`
    })
    .join('\n\n')

  return [
    `Task: ${input.task.trim()}`,
    `Target workspace: ${input.targetWorkspace?.trim() || '(current Cursor workspace)'}`,
    'Relevant reference patterns:',
    refs || '  - (none selected)',
    input.constraints?.trim() ? `Constraints and differences:\n${input.constraints.trim()}` : '',
    'Implement in the target workspace, preserving its conventions.',
    'Run the relevant tests and explain deviations from the references.',
    excerpts ? `Selected excerpts:\n${excerpts}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

function stripLinePrefixes(content: string): string {
  return content
    .split('\n')
    .map((line) => line.replace(/^\s*\d+\|\s?/, ''))
    .join('\n')
}
