// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { providerIdSchema } from '../../../src/shared/providerIds'
import { PROVIDER_PROFILES, providerProfile, providerRecommendsCompaction, watcherProviderIds } from '../../../src/shared/providerProfile'
import { providerTakesSottoTools, providerWritesShortText } from '../../../src/shared/agents'
import { watcherProviderSchema } from '../../../src/shared/watcher'
import { roleCanUse, watcherProvidersInWords } from '../../../src/shared/workerRoles'

describe('provider profiles', () => {
  it('hold one profile for every provider and nothing else', () => {
    expect(Object.keys(PROVIDER_PROFILES).sort()).toEqual([...providerIdSchema.options].sort())
  })

  it('answer nothing for a thread that names no provider or a provider this build does not know', () => {
    expect(providerProfile(undefined)).toBeUndefined()
    expect(providerProfile('test-seventh')).toBeUndefined()
    // An inherited property name is not a provider.
    expect(providerProfile('toString')).toBeUndefined()
    expect(providerRecommendsCompaction(undefined)).toBe(false)
    expect(providerRecommendsCompaction('test-seventh')).toBe(false)
  })

  // The answers each provider gave before the profile held them, so moving them changed none.
  it.each([
    ['codex', { shortText: true, tools: true, watcher: true, sigils: ['$'] }],
    ['claude', { shortText: true, tools: true, watcher: true, sigils: ['$', '/'] }],
    ['grok', { shortText: true, tools: true, watcher: true, sigils: ['$', '/'] }],
    ['devin', { shortText: false, tools: true, watcher: false, sigils: ['$'] }],
    ['muse', { shortText: false, tools: true, watcher: true, sigils: ['$'] }],
    ['opencode', { shortText: true, tools: true, watcher: false, sigils: ['$'] }],
  ] as const)('gives %s the answers it had before', (id, expected) => {
    expect(providerWritesShortText(id)).toBe(expected.shortText)
    expect(providerTakesSottoTools(id)).toBe(expected.tools)
    expect(roleCanUse('orchestrating', { providerId: id })).toBe(expected.watcher)
    expect(providerProfile(id)?.skillSigils).toEqual(expected.sigils)
  })

  it("names Watcher's providers as Watcher's schema does, in the same order", () => {
    expect(watcherProviderIds()).toEqual(watcherProviderSchema.options)
    expect(watcherProvidersInWords(new Set())).toBe('Codex, Claude Code, Grok Build or Muse')
    expect(watcherProvidersInWords(new Set(['muse']))).toBe('Codex, Claude Code or Grok Build')
  })

  // Claude Code was the only provider offered the recommendation before ADR-0095; Codex and Muse are new.
  it('recommends compaction for Claude Code, Codex and Muse, which compact and say how full their context is', () => {
    expect(providerIdSchema.options.filter(providerRecommendsCompaction)).toEqual(['codex', 'claude', 'muse'])
    for (const id of providerIdSchema.options) {
      const profile = PROVIDER_PROFILES[id]
      expect(providerRecommendsCompaction(id)).toBe(profile.compacts && profile.reportsContext)
    }
  })
})
