// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ConfiguredProviderHost } from '../../../src/main/agents/providerSwitch'
import { agentCommandSchema, agentConfigurationSchema, defaultAgentConfiguration } from '../../../src/shared/agents'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

describe('configured provider', () => {
  it('defaults legacy configurations to t3', () => {
    const legacy: Record<string, unknown> = { ...defaultAgentConfiguration() }; delete legacy.provider
    expect(agentConfigurationSchema.parse(legacy).provider).toBe('t3')
    expect(agentCommandSchema.parse({ type: 'configure', patch: { speak: false } })).toEqual({ type: 'configure', patch: { speak: false } })
  })
  it('selects after configuration loads and forwards only active events and observations', async () => {
    const t3 = new FakeProviderHost(); const codex = new FakeProviderHost()
    let provider: 't3' | 'codex' = 't3'
    const host = new ConfiguredProviderHost({ hosts: { t3, codex }, provider: () => provider })
    const events: string[] = []; const unsubscribe = host.subscribe(s => events.push(s.name))
    codex.state.name = 'Codex'; t3.state.name = 'T3'
    host.observeThreads(['session-workshop'])
    provider = 'codex'
    expect((await host.connect({ endpoint: '', credential: '' })).name).toBe('Codex')
    expect(codex.observed).toEqual(['session-workshop']); expect(t3.state.connected).toBe(false)
    t3.emit(); codex.emit(); expect(events).toEqual(['Codex'])
    await host.execute({ type: 'interrupt', commandId: 'stop', threadId: 'session-workshop' })
    expect(codex.commands).toHaveLength(1); expect(t3.commands).toHaveLength(0)
    provider = 't3'; await host.connect({ endpoint: '', credential: '' }); expect(codex.state.connected).toBe(false)
    expect((await host.snapshot()).name).toBe('T3')
    unsubscribe(); host.disconnect(); expect(t3.state.connected).toBe(false)
  })
})
