// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore, type Memory } from '../../../src/main/memory/store'
import { retrieveExplicitMemories, threadMemoryScope, RETRIEVAL_CONTEXT_CHARACTERS } from '../../../src/main/memory/retrieval.mjs'

const at = '2026-09-11T12:00:00.000Z'
let store: MemoryStore
function insert(id: string, overrides: Partial<Memory> = {}) {
  store.insert({ id, type: 'preference', scope: 'global', content: 'Verification: run focused tests',
    sourceClass: 'explicit', authority: 'preference', confidence: 1, evidenceCount: 1, importance: 0.8,
    createdAt: at, lastConfirmedAt: at, lastUsedAt: null, validFrom: at, validTo: null,
    supersededBy: null, provenance: [], tags: ['verification'], state: 'active', ...overrides })
}
const retrieve = (query: string, projectId = 'project-a', threadId = 'thread-a') =>
  retrieveExplicitMemories(store.database(), { query, projectId, threadId, at })

beforeEach(() => { store = new MemoryStore(':memory:'); store.open() })
afterEach(() => store.close())

describe('explicit lexical retrieval', () => {
  it('orders thread, project, global and never includes another project or thread', () => {
    insert('global')
    insert('project', { scope: 'project-a' })
    insert('thread', { scope: threadMemoryScope('project-a', 'thread-a') })
    insert('other-project', { scope: 'project-b' })
    insert('other-thread', { scope: threadMemoryScope('project-a', 'thread-b') })
    insert('same-thread-other-project', { scope: threadMemoryScope('project-b', 'thread-a') })
    expect(retrieve('verification').map(m => m.id)).toEqual(['thread', 'project', 'global'])
    expect(retrieveExplicitMemories(store.database(), { query: 'verification', at }).map(m => m.id)).toEqual(['global'])
  })
  it('abstains on no evidence and below threshold, with punctuation and FTS operators treated as text', () => {
    insert('partial', { content: 'compiler configuration', tags: [] })
    expect(retrieve('compiler database deployment networking')).toEqual([])
    expect(retrieve('What is my preference?')).toEqual([])
    expect(retrieve('absent')).toEqual([])
    expect(retrieve('" OR * : NEAR ()')).toEqual([])
    expect(retrieve('Compiler configuration?').map(m => m.id)).toEqual(['partial'])
  })
  it('requires explicit preference authority, current validity and an eligible state', () => {
    insert('current')
    insert('temporary', { state: 'temporary' })
    insert('expired', { validTo: at })
    insert('future', { validFrom: '2026-09-12T00:00:00.000Z' })
    for (const sourceClass of ['observed', 'imported', 'inferred', 'agent-confirmed'] as const) insert(sourceClass, { sourceClass })
    for (const authority of ['permission', 'policy'] as const) insert(authority, { authority })
    for (const state of ['archived', 'disputed', 'superseded'] as const) insert(state, { state })
    insert('old', { supersededBy: 'current' })
    expect(retrieve('verification').map(m => m.id).sort()).toEqual(['current', 'temporary'])
  })
  it('caps the complete serialized context, preserving whole memories and exact IDs', () => {
    for (let i = 0; i < 30; i++) insert(`memory-${i}`, { content: `Verification ${'quoted "text" '.repeat(100)}` })
    insert('oversized', { content: `Verification ${'x'.repeat(RETRIEVAL_CONTEXT_CHARACTERS)}` })
    const result = retrieve('verification')
    expect(result.length).toBeGreaterThan(0)
    expect(result.length).toBeLessThanOrEqual(20)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(RETRIEVAL_CONTEXT_CHARACTERS)
    for (const memory of result) expect(memory.content).toBe(store.get(memory.id)?.content)
    expect(result.some(m => m.id === 'oversized')).toBe(false)
  })
  it('reflects correction/deletion without a stale cache and leaves provenance/history untouched', () => {
    insert('original')
    const before = store.get('original')
    expect(retrieve('verification')).toHaveLength(1)
    expect(store.get('original')).toEqual(before)
    store.database().prepare('DELETE FROM memories WHERE id = ?').run('original')
    expect(retrieve('verification')).toEqual([])
  })
})
