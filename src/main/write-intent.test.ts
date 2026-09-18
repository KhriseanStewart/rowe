import { describe, expect, test } from 'bun:test'
import {
  extractNamedWriteTarget,
  isGeneratedDocumentWriteRequest,
  isPrimarilyDevCommandAsk,
  wantsFileMutation
} from './write-intent'

describe('write intent', () => {
  test('detects README generate-and-write asks', () => {
    const question = 'Write a README.md that describes this project'
    expect(extractNamedWriteTarget(question)).toBe('README.md')
    expect(isGeneratedDocumentWriteRequest(question)).toBe(true)
    expect(wantsFileMutation(question)).toBe(true)
  })

  test('does not treat comment asks as generated document writes', () => {
    const question = 'Add a comment at the top of main.dart saying HELLO'
    expect(extractNamedWriteTarget(question)).toBe('main.dart')
    expect(isGeneratedDocumentWriteRequest(question)).toBe(false)
  })

  test('requires a named file for generated document writes', () => {
    expect(isGeneratedDocumentWriteRequest('generate a good readme for this project')).toBe(false)
  })

  test('detects replace/update the README asks', () => {
    expect(extractNamedWriteTarget('replace the Rowe README with a guide')).toBe('README.md')
    expect(isGeneratedDocumentWriteRequest('replace the Rowe README with a guide')).toBe(true)
    expect(isGeneratedDocumentWriteRequest('update the README.md')).toBe(true)
  })

  test('git branch/push asks are developer commands, not file mutations', () => {
    const question = 'Create a new branch and push the commits to it'
    expect(isPrimarilyDevCommandAsk(question)).toBe(true)
    expect(wantsFileMutation(question)).toBe(false)
    expect(wantsFileMutation('push this branch to origin')).toBe(false)
    expect(wantsFileMutation('run npm test')).toBe(false)
    expect(wantsFileMutation('create a new file notes.md')).toBe(true)
    expect(wantsFileMutation('run typecheck')).toBe(false)
    expect(wantsFileMutation('execute this shell command: bun test')).toBe(false)
  })
})
