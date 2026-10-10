// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { publicProviderEntityId, type AgentModel } from '../../../src/shared/agents'
import { baseModelId, catalogEntry, chosenModelId, resolveModel } from '../../../src/shared/modelCatalog'

const opus: AgentModel = { id: publicProviderEntityId('claude', 'model', 'opus'), name: 'Opus 5.5', provider: 'Claude Code', providerId: 'claude', ready: true,
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'xhigh', supportsImages: true, runtimeModes: ['approval-required', 'auto'] }
const sonnet: AgentModel = { id: publicProviderEntityId('claude', 'model', 'sonnet'), name: 'Sonnet 4.6', provider: 'Claude Code', providerId: 'claude', ready: false }
const catalog = [opus, sonnet]
const variant = publicProviderEntityId('claude', 'model', 'opus[1m]')

describe('which catalog model an ID is on', () => {
  it('answers an ID the catalog lists with that entry as it is', () => {
    expect(resolveModel(catalog, opus.id)).toBe(opus)
    expect(catalogEntry(catalog, sonnet.id)).toBe(sonnet)
  })

  it('answers a 1M-context variant from its base model, keeping the ID it was asked about', () => {
    expect(variant).toBe('native:claude:model:opus%5B1m%5D')
    expect(resolveModel(catalog, variant)).toEqual({ ...opus, id: variant })
    expect(catalogEntry(catalog, variant)).toBe(opus)
    // The native form an adapter holds resolves the same way against a native catalog.
    const native = [{ id: 'opus', name: 'Opus 5.5', reasoningEfforts: ['high'] }]
    expect(resolveModel(native, 'opus[1m]')).toEqual({ id: 'opus[1m]', name: 'Opus 5.5', reasoningEfforts: ['high'] })
  })

  it('prefers an exact entry when a catalog still lists the variant itself', () => {
    const listed: AgentModel = { ...opus, id: variant, name: 'Opus 5.5 (1M context)' }
    expect(resolveModel([opus, listed], variant)).toBe(listed)
  })

  it('reads the suffix without regard to case, in either the native or the public form', () => {
    expect(resolveModel(catalog, publicProviderEntityId('claude', 'model', 'opus[1M]'))?.name).toBe('Opus 5.5')
    expect(resolveModel(catalog, 'native:claude:model:opus%5b1m%5d')?.name).toBe('Opus 5.5')
    expect(resolveModel([{ id: 'opus' }], 'opus[1M]')).toEqual({ id: 'opus[1M]' })
  })

  it('leaves a variant of a model the catalog does not have unknown, as any unknown ID is', () => {
    expect(resolveModel(catalog, publicProviderEntityId('claude', 'model', 'claude-fable-5-1[1m]'))).toBeUndefined()
    expect(resolveModel(catalog, publicProviderEntityId('claude', 'model', 'haiku'))).toBeUndefined()
    expect(resolveModel(catalog, '')).toBeUndefined()
    expect(resolveModel(catalog, undefined)).toBeUndefined()
  })

  it('takes only the `[1m]` suffix Claude Code documents as a variant, and only for Claude', () => {
    for (const native of ['opus[beta]', 'opus[1]', 'opus[m]', 'opus[1m', 'opus[1m]x', 'opus[1g]', 'opus[200k]', 'opus[2m]', '[1m]', 'opus [1m] ', 'opus[1m][1m]']) {
      expect(resolveModel(catalog, publicProviderEntityId('claude', 'model', native)), native).toBeUndefined()
    }
    expect(baseModelId('native:claude:model:opus%5B1m%5D')).toBe('native:claude:model:opus')
    expect(baseModelId('opus[1m]')).toBe('opus')
    expect(baseModelId('native:claude:model:%E0%A4%A')).toBeUndefined()
    // Another provider's public ID, or anything else in the public shape, is never read as a variant.
    const codex = [{ id: publicProviderEntityId('codex', 'model', 'gpt') }]
    expect(resolveModel(codex, publicProviderEntityId('codex', 'model', 'gpt[1m]'))).toBeUndefined()
    expect(baseModelId('native:claude:project:opus%5B1m%5D')).toBeUndefined()
    expect(baseModelId('native:other:model:opus%5B1m%5D')).toBeUndefined()
  })

  it('keeps an ID its owner holds when that ID\'s entry is pressed, and moves for any other entry', () => {
    expect(chosenModelId(catalog, opus.id, variant)).toBe(variant)
    expect(chosenModelId(catalog, sonnet.id, variant)).toBe(sonnet.id)
    expect(chosenModelId(catalog, opus.id, sonnet.id)).toBe(opus.id)
    expect(chosenModelId(catalog, opus.id, undefined)).toBe(opus.id)
    // The model pressed before, then the one in force: back on Opus from Sonnet is the thread's own `opus[1m]`.
    expect(chosenModelId(catalog, opus.id, sonnet.id, variant)).toBe(variant)
    expect(chosenModelId(catalog, sonnet.id, sonnet.id, variant)).toBe(sonnet.id)
  })
})
