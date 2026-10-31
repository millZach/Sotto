import { describe, expect, it } from 'vitest'
import { publicProviderEntityId, type AgentModel } from '../../../src/shared/agents'
import { markLegacyModels, modelInForce, modelLine, retiredModelSuccessor } from '../../../src/shared/modelLineup'

const claude = (value: string, name: string, extra: Partial<AgentModel> = {}): AgentModel =>
  ({ id: publicProviderEntityId('claude', 'model', value), provider: 'Claude Code', providerId: 'claude', name, ready: true, ...extra })
const codex = (value: string, name: string, extra: Partial<AgentModel> = {}): AgentModel =>
  ({ id: publicProviderEntityId('codex', 'model', value), provider: 'Codex', providerId: 'codex', name, ready: true, ...extra })

// What Zach's laptop's catalog held on October 31, 2026, Claude Code's and Codex's part: the live catalog and what it kept.
const LAPTOP: AgentModel[] = [
  claude('default', 'Default (recommended)', { recommended: true }), claude('opus', 'Opus 5.5'), claude('sonnet', 'Sonnet 5.5'),
  claude('haiku', 'Haiku 5.5'), claude('fable', 'Fable 5.1'), claude('claude-fable-5', 'Fable 5'), claude('claude-opus-5', 'Opus 5'),
  claude('claude-sonnet-5', 'Sonnet 5'), claude('claude-opus-4-8', 'Opus 4.8'), claude('claude-sonnet-4-6', 'Sonnet 4.6'),
  claude('claude-haiku-4-5-20251001', 'Haiku 4.5'),
  claude('opus[1m]', 'Opus 5.5 with 1M context', { ready: false }), claude('claude-fable-5-1', 'Fable 5.1', { ready: false }),
  claude('claude-fable-5-1[1m]', 'Fable 5.1', { ready: false }),
  codex('gpt-6.1-sol', 'GPT-6.1-Sol'), codex('gpt-6.1-terra', 'GPT-6.1 Terra'), codex('gpt-6-astra', 'GPT-6-Astra'), codex('gpt-6-sol', 'GPT-6-Sol'),
  codex('gpt-6-luna', 'GPT-6-Luna'), codex('gpt-5.6-sol', 'GPT-5.6-Sol'), codex('gpt-5.6-terra', 'GPT-5.6-Terra'), codex('gpt-5.6-luna', 'GPT-5.6-Luna'),
  codex('gpt-5.5', 'GPT-5.5', { ready: false }), codex('gpt-5.3-codex-spark', 'GPT-5.3-Codex-Spark', { ready: false }),
]
const live = LAPTOP.filter(model => model.ready)
const named = (models: readonly AgentModel[]): string[] => models.map(model => model.name)

describe('model lines', () => {
  it('reads a line from a name without its version or long-context note', () => {
    expect(modelLine('Opus 5.5')).toBe('opus')
    expect(modelLine('Opus 5.5 with 1M context')).toBe('opus')
    expect(modelLine('GPT-6.1-Sol')).toBe('gpt sol')
    expect(modelLine('GPT-6.1 Terra')).toBe('gpt terra')
    expect(modelLine('GPT-5.3-Codex-Spark')).toBe('gpt codex spark')
  })
})

describe('legacy models', () => {
  it('marks every model with a newer model of its line, and never the recommended one', () => {
    const marked = markLegacyModels(live.filter(model => model.providerId === 'claude'))
    expect(named(marked.filter(model => !model.legacy))).toEqual(['Default (recommended)', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5', 'Fable 5.1'])
    expect(named(marked.filter(model => model.legacy))).toEqual(['Fable 5', 'Opus 5', 'Sonnet 5', 'Opus 4.8', 'Sonnet 4.6', 'Haiku 4.5'])
    const codexMarked = markLegacyModels(live.filter(model => model.providerId === 'codex'))
    expect(named(codexMarked.filter(model => !model.legacy))).toEqual(['GPT-6.1-Sol', 'GPT-6.1 Terra', 'GPT-6-Astra', 'GPT-6-Luna'])
  })

  it('keeps a catalog that is already marked as it is, and takes a mark off a model that is newest again', () => {
    const marked = markLegacyModels([claude('opus', 'Opus 5.5'), claude('claude-opus-5', 'Opus 5')])
    expect(markLegacyModels(marked)[0]).toBe(marked[0])
    expect(markLegacyModels([claude('claude-opus-5', 'Opus 5', { legacy: true })])[0]!.legacy).toBeUndefined()
  })
})

describe('retired models', () => {
  it('moves a retired model to the newest ready model of its line', () => {
    expect(retiredModelSuccessor(LAPTOP, publicProviderEntityId('claude', 'model', 'claude-fable-5-1'), 'Fable 5.1')?.name).toBe('Fable 5.1')
    expect(retiredModelSuccessor(LAPTOP, publicProviderEntityId('claude', 'model', 'claude-fable-5-1'), 'Fable 5.1')?.id).toBe(publicProviderEntityId('claude', 'model', 'fable'))
    expect(retiredModelSuccessor(LAPTOP, publicProviderEntityId('claude', 'model', 'claude-fable-5-1[1m]'), 'Fable 5.1')?.id).toBe(publicProviderEntityId('claude', 'model', 'fable'))
  })

  it('moves a long-context variant to its base model when the base is ready', () => {
    expect(retiredModelSuccessor(LAPTOP, publicProviderEntityId('claude', 'model', 'opus[1m]'), 'Opus 5.5 with 1M context')?.name).toBe('Opus 5.5')
  })

  it('reads the line from the ID once the catalog has dropped the model, and falls back to the first ready model', () => {
    expect(retiredModelSuccessor(live, publicProviderEntityId('claude', 'model', 'claude-sonnet-4-5'))?.name).toBe('Sonnet 5.5')
    expect(retiredModelSuccessor(live, publicProviderEntityId('codex', 'model', 'gpt-5.3-codex-spark'))?.name).toBe('GPT-6.1-Sol')
    expect(retiredModelSuccessor(LAPTOP, publicProviderEntityId('claude', 'model', 'claude-mystery-9'))?.name).toBe('Default (recommended)')
  })

  it('leaves a provider that is not connected, and every other provider, alone', () => {
    const away = LAPTOP.map(model => ({ ...model, ready: false }))
    expect(retiredModelSuccessor(away, publicProviderEntityId('claude', 'model', 'claude-fable-5-1'), 'Fable 5.1')).toBeUndefined()
    expect(retiredModelSuccessor(LAPTOP, publicProviderEntityId('grok', 'model', 'grok-3'), 'Grok 3')).toBeUndefined()
  })

  it('keeps a saved choice that is ready, and runs a retired one on its successor', () => {
    const opus = publicProviderEntityId('claude', 'model', 'opus')
    expect(modelInForce(LAPTOP, opus)).toBe(opus)
    expect(modelInForce(LAPTOP, publicProviderEntityId('claude', 'model', 'opus[1m]'))).toBe(opus)
    expect(modelInForce(LAPTOP, publicProviderEntityId('codex', 'model', 'gpt-5.5'))).toBe(publicProviderEntityId('codex', 'model', 'gpt-6.1-sol'))
    expect(modelInForce(LAPTOP, '')).toBe('')
    // A choice the catalog never held may be a model the user named: it moves only within its own line.
    const named = publicProviderEntityId('claude', 'model', 'coordinator-model')
    expect(modelInForce(live, named)).toBe(named)
    // Once a retired model has left the catalog, a choice in the provider's own shape still moves, to its default if need be.
    expect(modelInForce(live, publicProviderEntityId('codex', 'model', 'gpt-5.5'))).toBe(publicProviderEntityId('codex', 'model', 'gpt-6.1-sol'))
    expect(modelInForce(live, publicProviderEntityId('claude', 'model', 'claude-fable-5-1'))).toBe(publicProviderEntityId('claude', 'model', 'fable'))
    expect(modelInForce(live, publicProviderEntityId('claude', 'model', 'claude-sonnet-4-5'))).toBe(publicProviderEntityId('claude', 'model', 'sonnet'))
  })
})
