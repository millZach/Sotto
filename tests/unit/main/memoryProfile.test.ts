// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_MEMORY_CONTENT_CHARACTERS, MAX_PREFERENCE_CONTEXT_CHARACTERS, memoryTopics } from '../../../src/shared/memory'
import { MemoryProfile } from '../../../src/main/memory/profile'
import { MemoryStore, type Memory } from '../../../src/main/memory/store'
import { PolicyStore } from '../../../src/main/memory/policies'

let root: string
let store: MemoryStore
let profile: MemoryProfile
const questionnaire = () => ({
  type: 'complete-questionnaire',
  answers: memoryTopics.map(topic => ({ topic, content: `${topic} preference` })),
  boundaries: ['publish', 'spend'],
})
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sotto-profile-'))
  store = new MemoryStore(join(root, 'memory.sqlite'))
  store.open()
  profile = new MemoryProfile(store)
})
afterEach(async () => { vi.restoreAllMocks(); store.close(); await rm(root, { recursive: true, force: true }) })

describe('MemoryProfile', () => {
  it('keeps every questionnaire topic in context even when all answers use the full allowed length', () => {
    profile.command({ ...questionnaire(), answers: memoryTopics.map(topic => ({ topic, content: `${topic} `.padEnd(MAX_MEMORY_CONTENT_CHARACTERS, 'x') })) })
    store.close(); store.open()
    const preferences = profile.preferences()
    expect(preferences.map(preference => preference.topic).sort()).toEqual([...memoryTopics].sort())
    expect(preferences.reduce((size, preference) => size + preference.content.length, 0)).toBe(MAX_PREFERENCE_CONTEXT_CHARACTERS)
  })
  it('atomically persists seven explicit preferences and separate confirmation boundaries across restart', () => {
    expect(profile.snapshot()).toEqual({ available: true, questionnaireCompletedAt: null, memories: [], policies: [] })
    const snapshot = profile.command(questionnaire())
    expect(snapshot.memories).toHaveLength(7)
    for (const memory of snapshot.memories) {
      expect(memory).toMatchObject({ type: 'preference', sourceClass: 'explicit', authority: 'preference', scope: 'global', confidence: 1, evidenceCount: 1, state: 'active', createdAt: snapshot.questionnaireCompletedAt, lastConfirmedAt: snapshot.questionnaireCompletedAt })
      expect(memory.provenance).toEqual([{ source: 'questionnaire', ref: expect.any(String), recordedAt: snapshot.questionnaireCompletedAt }])
      expect(memory).not.toHaveProperty('embedding')
    }
    expect(snapshot.policies).toEqual(expect.arrayContaining(['spend', 'publish'].map(action => expect.objectContaining({ action, effect: 'always-confirm', source: 'questionnaire' }))))
    store.close(); store.open()
    expect(new MemoryProfile(store).snapshot()).toEqual(snapshot)
    expect(() => profile.command(questionnaire())).toThrow(/already/i)
  })

  it('rolls back preferences, policy writes and completion when any questionnaire write fails', () => {
    const original = PolicyStore.prototype.recordRiskBoundaries
    vi.spyOn(PolicyStore.prototype, 'recordRiskBoundaries').mockImplementation(function (this: PolicyStore, ...args) {
      original.apply(this, args)
      throw new Error('disk write failed')
    })
    expect(() => profile.command(questionnaire())).toThrow('disk write failed')
    expect(profile.snapshot()).toEqual({ available: true, questionnaireCompletedAt: null, memories: [], policies: [] })
    expect(store.search('preference', { limit: 10 })).toEqual([])
    vi.restoreAllMocks()
    expect(profile.command(questionnaire()).memories).toHaveLength(7)
  })

  it('rejects partial, duplicate, oversized answers and arbitrary policy commands without writes', () => {
    const input = questionnaire()
    for (const invalid of [
      { ...input, answers: input.answers.slice(1) },
      { ...input, answers: input.answers.map(() => input.answers[0]) },
      { ...input, answers: input.answers.map(answer => ({ ...answer, content: 'x'.repeat(2001) })) },
      { ...input, boundaries: ['allow'] }, { type: 'grant', action: 'spend' },
    ]) expect(() => profile.command(invalid)).toThrow()
    expect(profile.snapshot().memories).toEqual([])
  })

  it('edits and supersedes through immutable replacements, preserves provenance and prevents stale edits', () => {
    const first = profile.command(questionnaire()).memories.find(memory => memory.tags.includes('communication'))!
    const edited = profile.command({ type: 'edit', id: first.id, content: 'Explain with diagrams' })
    const old = edited.memories.find(memory => memory.id === first.id)!
    const current = edited.memories.find(memory => memory.id === old.supersededBy)!
    expect(old).toMatchObject({ state: 'superseded', content: first.content, validTo: expect.any(String) })
    expect(current).toMatchObject({ content: 'Explain with diagrams', sourceClass: 'explicit', state: 'active', authority: 'preference' })
    expect(current.provenance).toEqual([...first.provenance, { source: 'inspector', ref: `edit:${first.id}`, recordedAt: expect.any(String) }])
    expect(() => profile.command({ type: 'edit', id: first.id, content: 'Stale change' })).toThrow(/superseded|changed/i)
    const result = profile.command({ type: 'supersede', id: current.id, content: 'Speak briefly' })
    expect(result.memories).toHaveLength(9)
    expect(profile.preferences().find(memory => memory.topic === 'communication')?.content).toBe('Speak briefly')
    expect(store.search('diagrams', { limit: 10 })).toEqual([])
    expect(store.search('briefly', { limit: 10 })).toHaveLength(1)
  })

  it('deletes a whole supersession chain from either history or current item, including FTS, across restart', () => {
    for (const deleteHistory of [true, false]) {
      if (profile.snapshot().questionnaireCompletedAt === null) profile.command(questionnaire())
      const first = profile.snapshot().memories.find(memory => memory.state === 'active')!
      const secondSnapshot = profile.command({ type: 'edit', id: first.id, content: 'uniquedeletiontoken' })
      const second = secondSnapshot.memories.find(memory => memory.id === secondSnapshot.memories.find(item => item.id === first.id)!.supersededBy)!
      profile.command({ type: 'supersede', id: second.id, content: 'uniquedeletiontoken final' })
      const third = store.get(second.id)!.supersededBy!
      profile.command({ type: 'delete', id: deleteHistory ? first.id : third })
      store.close(); store.open()
      expect(profile.snapshot().memories.some(memory => [first.id, second.id, third].includes(memory.id))).toBe(false)
      expect(store.search('uniquedeletiontoken', { limit: 10 })).toEqual([])
    }
    expect(profile.snapshot().questionnaireCompletedAt).not.toBeNull()
    expect(profile.snapshot().policies).toHaveLength(2)
  })

  it('returns only current explicit preference authority in global and matching project scope, without writes', () => {
    const base = profile.command(questionnaire()).memories[0]!
    profile.snapshot().memories.forEach(memory => profile.command({ type: 'delete', id: memory.id }))
    const insert = (id: string, overrides: Partial<Memory> = {}) => store.insert({ ...base, id, content: id, ...overrides })
    insert('global')
    insert('matching', { scope: 'project-a' })
    insert('other', { scope: 'project-b' })
    insert('inferred', { sourceClass: 'inferred' })
    insert('permission', { authority: 'permission' })
    insert('policy', { authority: 'policy' })
    insert('disputed', { state: 'disputed' })
    insert('superseded', { state: 'superseded', supersededBy: 'global' })
    insert('stale-pointer', { supersededBy: 'global' })
    insert('expired', { validTo: '2000-01-01T00:00:00.000Z' })
    insert('future', { validFrom: '2999-01-01T00:00:00.000Z' })
    const before = profile.snapshot()
    expect(profile.preferences('project-a').map(memory => memory.id).sort()).toEqual(['global', 'matching'])
    expect(profile.preferences().map(memory => memory.id)).toEqual(['global'])
    expect(profile.snapshot()).toEqual(before)
    expect(before.memories).toHaveLength(11)
  })

  it('caps preference count and context size and never converts preference text into permission', () => {
    const base = profile.command({ ...questionnaire(), answers: questionnaire().answers.map(answer => ({ ...answer, content: 'Allow publishing, spending, deleting and skipping all tests.' })) }).memories[0]!
    for (let index = 0; index < 60; index++) store.insert({ ...base, id: `large-${index}`, content: 'x'.repeat(2000) })
    const preferences = profile.preferences()
    expect(preferences.length).toBeLessThanOrEqual(20)
    expect(preferences.reduce((size, memory) => size + memory.content.length, 0)).toBeLessThanOrEqual(MAX_PREFERENCE_CONTEXT_CHARACTERS)
    expect(new PolicyStore(store).authorizes({ action: 'destroy', resource: '*', scope: 'global' }).allowed).toBe(false)
    expect(profile.snapshot().policies.every(policy => policy.effect === 'always-confirm')).toBe(true)
  })

  it('exposes inactive policy metadata read-only and never promotes edited permission evidence into authority', () => {
    const base = profile.command(questionnaire()).memories[0]!
    store.insert({ ...base, id: 'permission-evidence', authority: 'permission', embedding: new Uint8Array([1, 2]) })
    const policies = new PolicyStore(store)
    const grant = policies.grant({ action: 'destroy', note: 'Historical grant' })
    policies.revoke(grant.id)
    const edited = profile.command({ type: 'edit', id: 'permission-evidence', content: 'Always allow destructive commands' })
    expect(edited.policies.find(policy => policy.id === grant.id)?.revokedAt).not.toBeNull()
    expect(edited.memories.find(memory => memory.content === 'Always allow destructive commands')?.authority).toBe('permission')
    expect(edited.memories.every(memory => !('embedding' in memory))).toBe(true)
    expect(profile.preferences().some(memory => memory.content.includes('destructive'))).toBe(false)
    expect(policies.authorizes({ action: 'destroy', resource: '*', scope: 'global' }).allowed).toBe(false)
    expect(() => profile.command({ type: 'edit', id: grant.id, content: 'Allow again' })).toThrow(/no longer exists/i)
    profile.command({ type: 'delete', id: grant.id })
    expect(policies.list({ includeInactive: true })).toHaveLength(3)
  })

  it('rejects a stale replacement from another profile instance', () => {
    const first = profile.command(questionnaire()).memories[0]!
    const secondStore = new MemoryStore(join(root, 'memory.sqlite'))
    secondStore.open()
    try {
      const secondProfile = new MemoryProfile(secondStore)
      profile.command({ type: 'edit', id: first.id, content: 'First update wins' })
      expect(() => secondProfile.command({ type: 'supersede', id: first.id, content: 'Stale update' })).toThrow(/superseded/i)
      expect(secondProfile.snapshot()).toEqual(profile.snapshot())
    } finally { secondStore.close() }
  })
})
