// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { defaultAgentConfiguration, defaultThreadModelId, publicProviderEntityId, type AgentModel, type ProviderId, type SubscriptionAccount } from '../../../src/shared/agents'

const model = (provider: ProviderId, id: string, ready = true): AgentModel =>
  ({ id: publicProviderEntityId(provider, 'model', id), provider, providerId: provider, name: id, ready })
// The saved order puts Grok first, as a user's cached workspace did.
const models = [model('grok', 'grok-4.6'), model('codex', 'gpt-6-astra'), model('claude', 'default'), model('claude', 'opus[1m]')]
const configuration = (patch: Partial<ReturnType<typeof defaultAgentConfiguration>>) => ({ ...defaultAgentConfiguration(), ...patch })
const account = (provider: SubscriptionAccount['provider'], defaultModelId?: string): SubscriptionAccount =>
  ({ provider, label: provider, installed: true, ready: true, detail: '', models: [], ...(defaultModelId ? { defaultModelId } : {}) })

describe('default model for a new thread', () => {
  it('inherits the selected agent instead of an older Grok thread default', () => {
    expect(defaultThreadModelId(configuration({ defaultModelId: models[0]!.id, reasoning: 'claude', reasoningModel: 'opus[1m]' }), models)).toBe(models[3]!.id)
  })

  it.each(['unavailable', 'missing'] as const)('keeps the exact configured model when it is %s instead of switching providers', state => {
    const catalog = state === 'unavailable' ? [...models.slice(0, 3), model('claude', 'opus[1m]', false)] : models.slice(0, 3)
    expect(defaultThreadModelId(configuration({ reasoning: 'claude', reasoningModel: 'opus[1m]' }), catalog)).toBe(models[3]!.id)
  })

  it('keeps the selected agent while provider catalogs arrive and disappear', () => {
    const config = configuration({ reasoning: 'claude', reasoningModel: 'opus[1m]' })
    for (const catalog of [[], models.slice(0, 2), models, []]) {
      expect(defaultThreadModelId(config, catalog)).toBe(models[3]!.id)
    }
  })

  it('uses the selected account default rather than catalog order or another account default', () => {
    const accounts = [account('codex', 'gpt-6-astra'), account('claude', 'opus[1m]')]
    expect(defaultThreadModelId(configuration({ reasoning: 'claude' }), models, accounts)).toBe(models[3]!.id)
    expect(defaultThreadModelId(configuration({ reasoning: 'claude' }), models.slice(0, 3), accounts)).toBe(models[3]!.id)
  })

  it('prefers an explicit agent model to the account default', () => {
    expect(defaultThreadModelId(configuration({ reasoning: 'claude', reasoningModel: 'opus[1m]' }), models, [account('claude', 'default')])).toBe(models[3]!.id)
  })

  it('stays within the selected provider when no account default was reported', () => {
    const config = configuration({ reasoning: 'claude', defaultModelId: models[0]!.id })
    expect(defaultThreadModelId(config, models)).toBe(models[2]!.id)
    expect(defaultThreadModelId(config, [models[0]!, model('claude', 'default', false), models[3]!])).toBe(models[3]!.id)
    expect(defaultThreadModelId(config, [models[0]!, model('claude', 'default', false)])).toBe(models[2]!.id)
    expect(defaultThreadModelId(config, models.slice(0, 2))).toBe('')
  })

  it.each(['none', 'openrouter', 'openai'] as const)('uses ready thread providers for %s without reviving the retired thread default', reasoning => {
    const config = configuration({ reasoning, defaultModelId: models[0]!.id, provider: 'codex' })
    expect(defaultThreadModelId(config, models)).toBe(models[1]!.id)
    expect(defaultThreadModelId(config, [model('codex', 'gpt-6-astra', false), models[0]!])).toBe(models[0]!.id)
    expect(defaultThreadModelId(config, [model('grok', 'grok-4.6', false)])).toBe('')
  })
})
