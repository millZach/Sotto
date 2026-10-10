import { expect, it } from 'vitest'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { watcherNativeReadProof } from '../fixtures/watcherNativeReadProof'

const activity = (patch: Partial<AgentActivity>): AgentActivity => ({ id: 'new', turnId: 'turn', sequence: 1, kind: 'tool', status: 'completed', title: 'Read', text: '{"file_path":"source.txt"}', output: 'native_read_marker', ...patch })
const proof = (rows: AgentActivity[], previous = new Set<string>()) => watcherNativeReadProof(rows, previous, 'source.txt', 'native_read_marker')

it('requires a native read and a separate text search with successful matching output', () => {
  expect(proof([activity({})])).toEqual({ read: true, search: false })
  expect(proof([activity({}), activity({ id: 'search', title: 'Grep', text: '{"path":"source.txt","pattern":"native_read_"}' })])).toEqual({ read: true, search: true })
  expect(proof([activity({ title: 'grep_search', text: '{"path":".","query":"native_read_"}', output: 'source.txt: native_read_marker' })])).toEqual({ read: false, search: true })
  expect(proof([activity({ kind: 'command', title: 'Command', command: "Get-Content source.txt; Select-String -Path source.txt -Pattern 'native_read_'" })])).toEqual({ read: true, search: true })
})

it('rejects old, failed, unrelated and output-free native activity as proof', () => {
  expect(proof([activity({})], new Set(['new']))).toEqual({ read: false, search: false })
  expect(proof([activity({ title: 'list_threads', text: '{"query":"native_read_"}', output: 'source.txt: native_read_marker' })])).toEqual({ read: false, search: false })
  expect(proof([activity({ title: 'Read', text: '{"path":"source.txt","query":"native_read_"}', output: 'source.txt: native_read_marker' })])).toEqual({ read: true, search: false })
  for (const patch of [{ status: 'failed' as const }, { exitCode: 1 }, { title: 'list_threads' }, { output: '' }, { text: 'other.txt' }]) expect(proof([activity(patch)])).toEqual({ read: false, search: false })
})
