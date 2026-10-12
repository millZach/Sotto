import { expect, it } from 'vitest'
import { watcherGrokSearchProof } from '../fixtures/watcherGrokSearchProof'

const started = { sessionUpdate: 'tool_call', toolCallId: 'synthetic', kind: 'search', status: 'in_progress', rawInput: { path: 'source.txt', pattern: 'native_read_' } }
const completed = { sessionUpdate: 'tool_call_update', toolCallId: 'synthetic', status: 'completed', rawOutput: { matchCount: 1 } }
const prompt = { sessionUpdate: 'user_message_chunk' }
const proof = (updates: Record<string, unknown>[]) => watcherGrokSearchProof([prompt, ...updates], 'source.txt', 'native_read_')

it('requires a completed explicit ACP search with this file and text pattern', () => {
  expect(proof([started, completed])).toBe(true)
  expect(proof([started])).toBe(false)
  expect(proof([{ ...started, kind: 'other' }, completed])).toBe(false)
  expect(proof([{ ...started, rawInput: { path: 'other.txt', pattern: 'native_read_' } }, completed])).toBe(false)
  expect(proof([{ ...started, rawInput: { path: 'source.txt', pattern: 'different' } }, completed])).toBe(false)
  expect(proof([started, { ...completed, status: 'failed' }])).toBe(false)
  expect(proof([started, { ...completed, rawOutput: { isError: true } }])).toBe(false)
  expect(proof([started, { ...completed, rawOutput: { exitCode: 1 } }])).toBe(false)
})

it('never uses a search from an earlier turn to prove the latest turn', () => {
  expect(proof([started, completed, prompt])).toBe(false)
  expect(proof([started, prompt, completed])).toBe(false)
  expect(proof([started, completed, prompt, started, completed])).toBe(true)
  expect(watcherGrokSearchProof([started, completed], 'source.txt', 'native_read_')).toBe(false)
})
