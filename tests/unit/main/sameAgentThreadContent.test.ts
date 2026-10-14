// @vitest-environment node
import { isDeepStrictEqual } from 'node:util'
import { describe, expect, it } from 'vitest'
import { ownAgentThreadSnapshot, sameAgentThreadContent } from '../../../src/main/agents/sameAgentThreadContent'
import { cloneAgentThread } from '../../../src/shared/cloneAgentThread'
import { clientAgentState } from '../../../src/shared/clientIdentity'
import { agentThread, threadsStateFixture } from '../../fixtures/agentState'

describe('inert owned shell thread content', () => {
  it('matches Node for whole inert data, absent keys, order, scalar distinctions and sparse arrays', () => {
    const values: unknown[] = [undefined, null, false, 0, -0, NaN, '', 'value', [], [undefined], new Array(1),
      { value: undefined }, {}, { a: 1, b: 2 }, { b: 2, a: 1 }, { a: { b: ['nested'] } }, JSON.parse('{"__proto__":{"own":true},"constructor":"own"}')]
    for (const first of values) for (const second of values) {
      const owned = ownAgentThreadSnapshot(Object.assign(agentThread(), { extra: first }))
      const incoming = Object.assign(agentThread(), { extra: second })
      expect(sameAgentThreadContent(owned, incoming)).toBe(isDeepStrictEqual(owned, incoming))
    }
    const owned = cloneAgentThread(agentThread())
    expect(sameAgentThreadContent(owned, { ...agentThread(), reasoningEffort: undefined })).toBe(false)
    const incoming = Object.assign(agentThread(), { extra: { other: undefined } })
    Object.defineProperty(incoming.extra, 'value', { value: undefined, enumerable: false })
    const previous = cloneAgentThread(Object.assign(agentThread(), { extra: { value: undefined } }))
    expect(sameAgentThreadContent(previous, incoming)).toBe(isDeepStrictEqual(previous, incoming))
  })

  it('preserves native exotic, prototype, symbol, deep and cyclic behavior', () => {
    const shared = { nested: 'value' }
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    let deep: Record<string, unknown> = { value: 'leaf' }
    for (let i = 0; i < 70; i++) deep = { child: deep }
    const sparse = new Array(3) as unknown[]; sparse[0] = undefined
    const array = Object.assign([1], { extra: 'own' })
    const values: unknown[] = [new Date(0), new Map([['entry', shared]]), new Set([shared]), new Uint8Array([1, 2]),
      Object.create(null) as unknown, { first: shared, second: shared }, { first: { nested: 'value' }, second: { nested: 'value' } }, cycle, deep, sparse, array]
    for (const extra of values) {
      const incoming = Object.assign(agentThread(), { extra }), owned = ownAgentThreadSnapshot(incoming)
      expect(sameAgentThreadContent(owned, incoming)).toBe(isDeepStrictEqual(owned, incoming))
    }
    const incoming = Object.assign(agentThread(), { [Symbol('field')]: 'value' }), owned = cloneAgentThread(incoming)
    expect(sameAgentThreadContent(owned, incoming)).toBe(isDeepStrictEqual(owned, incoming))
  })

  it('keeps local and host-projected snapshots inert and detects nested same-reference edits', () => {
    const state = threadsStateFixture({ threads: [{ id: 'thread', worktree: { mode: 'shared', status: 'ready', branch: 'main' } }], topLevel: { hostId: 'aaaaaaaa-0000-4000-8000-000000000000' } })
    for (const snapshot of [structuredClone(state), clientAgentState(structuredClone(state))]) {
      const incoming = snapshot.host.threads[0]!, owned = cloneAgentThread(incoming)
      const inert = (value: unknown): void => {
        if (!value || typeof value !== 'object') return
        for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
          expect('get' in descriptor || 'set' in descriptor).toBe(false)
          inert(descriptor.value)
        }
      }
      inert(incoming)
      incoming.worktree!.branch = 'changed'
      incoming.requests.push({ id: 'question', kind: 'question', text: 'Which option?', options: [] })
      expect(sameAgentThreadContent(owned, incoming)).toBe(isDeepStrictEqual(owned, incoming))
      expect(sameAgentThreadContent(cloneAgentThread(incoming), incoming)).toBe(true)
    }
  })
})
