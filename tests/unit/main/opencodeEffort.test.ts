// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { OpenCodeHost } from '../../../src/main/agents/opencode'
import type { AgentHostSnapshot } from '../../../src/shared/agents'
import type { OpenCodeEvent } from '../../../src/main/agents/opencodeClient'

describe('OpenCode reports thinking Off', () => {
  it('keeps Off after a session.model.selected event and sends none on the next request', () => {
    const host = new OpenCodeHost('/unused-unit-fixture')
    const alias = { sessionId: 'session', sessionConfirmed: true, projectId: 'project', cwd: '/project', title: 'Test', modelId: 'own-test/model', runtimeMode: 'full-access', reasoningEffort: 'high' }
    const entry = { closing: false }
    Reflect.set(host, 'aliases', { thread: alias })
    ;(Reflect.get(host, 'processes') as Map<string, unknown>).set('thread', entry)
    ;(Reflect.get(host, 'state') as AgentHostSnapshot).models = [{ id: alias.modelId, name: 'Model', provider: 'OpenCode', ownServer: true, ready: true, reasoningEfforts: ['off', 'low', 'high'] }]
    Reflect.set(host, 'persist', vi.fn(async () => undefined)); Reflect.set(host, 'emit', vi.fn())
    const event = Reflect.get(host, 'event') as (id: string, entry: unknown, event: OpenCodeEvent) => void
    event.call(host, 'thread', entry, { type: 'session.model.selected', data: { sessionID: 'session', model: { providerID: 'own-test', id: 'model', variant: 'none' } } })
    expect(alias.reasoningEffort).toBe('off')
    const ref = Reflect.get(host, 'modelRef') as (id: string, effort: string) => unknown
    expect(ref.call(host, alias.modelId, alias.reasoningEffort)).toMatchObject({ variant: 'none' })
  })
})


it('chooses a thinking default for ordinary lists and Default for a toggle-only source', () => {
  const host = new OpenCodeHost('/unused-unit-fixture')
  const apply = Reflect.get(host, 'applyCatalog') as (version: string, models: unknown[], providers: unknown[], fallback: undefined) => void
  for (const [levels, expected] of [[['none', 'low', 'high'], 'high'], [['none', 'default'], 'default']] as const) {
    Reflect.set(host, 'knownServers', [{ id: 'own-test', name: 'Test', address: 'https://example.test/v1', keyed: false, models: [{ id: 'model', name: 'Model', context: 128000, images: false, thinking: true, reasoningEfforts: levels }] }])
    apply.call(host, '2.1.4', [{ id: 'model', providerID: 'own-test', name: 'Model', variants: [], capabilities: { input: ['text'] } }], [{ id: 'own-test', name: 'Test' }], undefined)
    expect((Reflect.get(host, 'state') as AgentHostSnapshot).models[0]!.defaultReasoningEffort).toBe(expected)
  }
})
