// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { defaultAgentConfiguration, defaultThreadModelId, publicProviderEntityId, type AgentModel, type ProviderId } from '../../../src/shared/agents'

const model = (provider: ProviderId, id: string, ready = true): AgentModel =>
  ({ id: publicProviderEntityId(provider, 'model', id), provider, providerId: provider, name: id, ready })
// The saved order puts Grok first, as a user's cached workspace did.
const models = [model('grok', 'grok-4.6'), model('codex', 'gpt-6-astra'), model('claude', 'default'), model('claude', 'opus[1m]')]
const configuration = (patch: Partial<ReturnType<typeof defaultAgentConfiguration>>) => ({ ...defaultAgentConfiguration(), ...patch })

describe('default model for a new thread', () => {
  it('uses the chosen default for new threads when it is ready', () => {
    expect(defaultThreadModelId(configuration({ defaultModelId: models[1]!.id, reasoning: 'claude' }), models)).toBe(models[1]!.id)
  })
  it('falls back to the selected agent model, then that provider, before the first ready model', () => {
    expect(defaultThreadModelId(configuration({ reasoning: 'claude', reasoningModel: 'opus[1m]' }), models)).toBe(models[3]!.id)
    expect(defaultThreadModelId(configuration({ reasoning: 'claude', reasoningModel: '' }), models)).toBe(models[2]!.id)
    expect(defaultThreadModelId(configuration({ reasoning: 'claude', reasoningModel: 'retired' }), models)).toBe(models[2]!.id)
  })
  it('skips unready choices for the older default provider, then the first ready model', () => {
    const unready = [model('claude', 'default', false), ...models.slice(0, 2)]
    expect(defaultThreadModelId(configuration({ defaultModelId: unready[0]!.id, reasoning: 'claude', provider: 'codex' }), unready)).toBe(models[1]!.id)
    expect(defaultThreadModelId(configuration({ reasoning: 'openrouter', provider: 'claude' }), [model('claude', 'default', false), models[0]!])).toBe(models[0]!.id)
    expect(defaultThreadModelId(configuration({ reasoning: 'none' }), [model('grok', 'grok-4.6', false)])).toBe('')
  })
})
