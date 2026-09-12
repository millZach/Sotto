// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ConfiguredProviderHost } from '../../../src/main/agents/providerSwitch'
import { agentCommandSchema, agentConfigurationSchema, defaultAgentConfiguration, type ProviderId } from '../../../src/shared/agents'
import { FakeProviderHost } from '../../fixtures/fakeProviderHost'

describe('configured provider', () => {
  it('defaults new configurations to Codex', () => {
    const legacy: Record<string, unknown> = { ...defaultAgentConfiguration() }; delete legacy.provider
    expect(agentConfigurationSchema.parse(legacy).provider).toBe('codex')
    expect(agentCommandSchema.parse({ type: 'configure', patch: { speak: false } })).toEqual({ type: 'configure', patch: { speak: false } })
  })
  it.each(['codex', 'claude', 'grok'] as const)('selects %s after configuration loads and isolates inactive providers', async selected => {
    const hosts = { codex: new FakeProviderHost(), claude: new FakeProviderHost(), grok: new FakeProviderHost() }
    let provider: ProviderId = 'codex'
    const host = new ConfiguredProviderHost({ hosts, provider: () => provider })
    const events: string[] = []; const unsubscribe = host.subscribe(s => events.push(s.name))
    for (const [name, adapter] of Object.entries(hosts)) { adapter.state.name = name; adapter.state.connected = true }
    host.observeThreads(['session-workshop'])
    provider = selected
    expect((await host.connect()).name).toBe(selected)
    expect(hosts[selected].observed).toEqual(['session-workshop'])
    for (const [name, adapter] of Object.entries(hosts)) { expect(adapter.state.connected).toBe(name === selected); adapter.emit() }
    expect(events).toEqual([selected])
    await host.execute({ type: 'interrupt', commandId: 'stop', threadId: 'session-workshop' })
    for (const [name, adapter] of Object.entries(hosts)) expect(adapter.commands).toHaveLength(name === selected ? 1 : 0)
    provider = selected === 'codex' ? 'claude' : 'codex'
    await host.connect(); expect(hosts[selected].state.connected).toBe(false)
    expect((await host.snapshot()).name).toBe(provider)
    unsubscribe(); host.disconnect(); expect(hosts[provider].state.connected).toBe(false)
  })
})
