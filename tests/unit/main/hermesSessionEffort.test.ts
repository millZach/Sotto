// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { HermesAcpHost } from '../../../src/main/agents/hermes'
import { HermesRejected } from '../../../src/main/agents/hermesRpc'
import type { AgentHostSnapshot } from '../../../src/shared/agents'

function fixture() {
  const host = new HermesAcpHost('/unused-unit-fixture')
  const alias = { hermesSessionId: 'session', projectId: 'project', cwd: '/project', title: 'Test', modelId: 'own-test/model', runtimeMode: 'full-access', reasoningEffort: 'high' }
  Reflect.set(host, 'aliases', { thread: alias }); Reflect.set(host, 'harnessEffort', true)
  Reflect.set(host, 'persist', vi.fn(async () => undefined)); Reflect.set(host, 'emit', vi.fn())
  ;(Reflect.get(host, 'state') as AgentHostSnapshot).models = [{ id: alias.modelId, name: 'Model', provider: 'Hermes', ready: true, reasoningEfforts: ['off', 'low', 'high', 'default'] }]
  const request = vi.fn(async (_method: string, _params: unknown, apply?: (value: unknown) => void) => { apply?.({ configOptions: [{ id: 'reasoning_effort', currentValue: 'high' }] }) })
  const connection = { rpc: { request }, model: alias.modelId, effort: 'low', supportsEffort: true, replaying: true }
  ;(Reflect.get(host, 'connections') as Map<string, unknown>).set('thread', connection)
  const apply = Reflect.get(host, 'applySettings') as (alias: unknown, connection: unknown, id: string) => Promise<void>
  return { host, alias, connection, request, apply: () => apply.call(host, alias, connection, 'thread') }
}
describe('Hermes session effort', () => {
  it('does not let a replayed config overwrite the choice still waiting to be applied', async () => {
    const f = fixture()
    const update = Reflect.get(f.host, 'liveUpdate') as (id: string, alias: unknown, value: unknown) => void
    update.call(f.host, 'thread', f.alias, { sessionUpdate: 'config_option_update', configOptions: [{ id: 'reasoning_effort', currentValue: 'low' }] })
    expect(f.alias.reasoningEffort).toBe('high')
    await f.apply()
    expect(f.request).toHaveBeenCalledWith('session/set_config_option', { sessionId: 'session', configId: 'reasoning_effort', value: 'high' }, expect.any(Function))
  })
  it('maps Off to none and retains Default as a reset', async () => {
    const f = fixture(); f.alias.reasoningEffort = 'off'
    await f.apply()
    expect(f.request).toHaveBeenCalledWith('session/set_config_option', expect.objectContaining({ value: 'none' }), expect.any(Function))
    f.alias.reasoningEffort = 'default'; await f.apply()
    expect(f.request).toHaveBeenCalledWith('session/set_config_option', expect.objectContaining({ value: 'default' }), expect.any(Function))
  })
  it('degrades on an older method, while a transient error does not remove everyone’s controls', async () => {
    const old = fixture(); old.request.mockImplementation(async method => { if (method === 'session/set_config_option') throw new HermesRejected(-32601) })
    await expect(old.apply()).resolves.toBeUndefined()
    expect(old.connection.supportsEffort).toBe(false)
    const transient = fixture(); transient.request.mockImplementation(async method => { if (method === 'session/set_config_option') throw new Error('Disconnected') })
    await expect(transient.apply()).rejects.toThrow('Disconnected')
    expect(Reflect.get(transient.host, 'harnessEffort')).toBe(true)
  })
})
