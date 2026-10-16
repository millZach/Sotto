// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// Two providers Sotto does not have, added in memory: every schema that caps a list of providers must take all seven
// without an edit of its own, because each cap is the provider list's length (#1101).
const { SEVEN, USAGE_SIX } = vi.hoisted(() => ({
  SEVEN: ['codex', 'claude', 'grok', 'devin', 'muse', 'opencode', 'test-seventh'] as const,
  USAGE_SIX: ['codex', 'claude', 'grok', 'devin', 'opencode', 'test-seventh'] as const,
}))
vi.mock('../../../src/shared/providerIds', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/shared/providerIds')>(), providerIdSchema: z.enum(SEVEN),
}))
vi.mock('../../../src/shared/usageDashboard', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/shared/usageDashboard')>(), usageProviderIdSchema: z.enum(USAGE_SIX),
}))

import { agentClientHostSchema, agentCommandSchema, agentConfigurationSchema, agentStateSchema, everyProvider, providerIdSchema,
  providerTakesSottoTools, providerWritesShortText, PROVIDER_COUNT, type ProviderId } from '../../../src/shared/agents'
import { agentSkillCatalogSchema } from '../../../src/shared/agentSkills'
import { hostClientUpdateRequestSchema } from '../../../src/shared/hostProviders'
import { hostRequestSchema } from '../../../src/shared/hostProtocol'
import { USAGE_PROVIDERS } from '../../../src/renderer/src/features/usage/usagePresentation'

const SIX = SEVEN.slice(0, 6)
const update = (id: string) => ({ id, installed: '1.0.0', behind: false, channel: 'npm', canInstall: true, checkedAt: '2026-10-16T00:00:00.000Z' })
const providerLists: ReadonlyArray<readonly [string, (ids: readonly string[]) => boolean]> = [
  ['enabled providers', ids => agentConfigurationSchema.shape.enabledProviders.safeParse(ids).success],
  ['turned-off providers', ids => agentConfigurationSchema.shape.disconnectedProviders.safeParse(ids).success],
  ['installed providers', ids => agentStateSchema.shape.installedProviders.safeParse(ids).success],
  ['client updates', ids => agentStateSchema.shape.clientUpdates.safeParse(ids.map(update)).success],
  ["a host's client updates", ids => agentClientHostSchema.shape.clientUpdates.safeParse(ids.map(update)).success],
  ["this computer's enabled providers on its host entry", ids => agentClientHostSchema.shape.enabledProviders.safeParse(ids).success],
  ['queued client updates', ids => agentCommandSchema.safeParse({ type: 'queue-client-updates', providers: ids }).success],
  ['cancelled client updates', ids => agentCommandSchema.safeParse({ type: 'cancel-client-updates', providers: ids }).success],
  ["a host's client update request", ids => hostClientUpdateRequestSchema.safeParse({ id: '6f9619ff-8b86-4011-b42d-00cf4fc964ff', action: 'update', providers: ids }).success],
]

describe('provider lists', () => {
  it('offer every usage provider on the Usage page', () => {
    expect(USAGE_PROVIDERS).toEqual(USAGE_SIX)
  })

  it('derive their cap from the provider list', () => {
    expect(providerIdSchema.options).toEqual(SEVEN)
    expect(PROVIDER_COUNT).toBe(7)
  })

  it.each(providerLists)('%s take six and seven providers', (_name, parses) => {
    expect(parses(SIX)).toBe(true)
    expect(parses(SEVEN)).toBe(true)
  })

  it.each(providerLists)('%s still refuse more entries than there are providers', (_name, parses) => {
    expect(parses([...SEVEN, 'codex'])).toBe(false)
  })

  it('lets a host refresh usage for every usage provider, however many there are', () => {
    const refresh = (providerIds: readonly string[]) => hostRequestSchema.safeParse({ v: 1, id: 'request', session: 'session', op: 'usage-refresh', providerIds }).success
    expect(refresh(USAGE_SIX)).toBe(true)
    expect(refresh([...USAGE_SIX, 'codex'])).toBe(false)
  })

  it("reads a skill catalog from any provider's thread", () => {
    expect(agentSkillCatalogSchema.safeParse({ threadId: 'thread', providerId: 'test-seventh', cwd: '/work', status: 'ready', skills: [], errors: [] }).success).toBe(true)
  })

  it('gives a new provider no short text and no Sotto tools until it says it takes them', () => {
    const fresh = 'test-seventh' as ProviderId
    expect(providerWritesShortText(fresh)).toBe(false)
    expect(providerTakesSottoTools(fresh)).toBe(false)
  })

  it('keeps what the five providers and an unlabelled thread do', () => {
    expect(['codex', 'claude', 'grok', 'devin', 'muse', undefined].map(id => providerWritesShortText(id as ProviderId | undefined)))
      .toEqual([true, true, true, false, false, true])
    expect(['codex', 'claude', 'grok', 'devin', 'muse', undefined].map(id => providerTakesSottoTools(id as ProviderId | undefined)))
      .toEqual([true, true, true, false, true, true])
  })

  it('names the provider a list that must name every provider leaves out', () => {
    expect(everyProvider(['muse', 'devin', 'grok', 'claude', 'codex'])).toEqual(['muse', 'devin', 'grok', 'claude', 'codex'])
    // @ts-expect-error Muse is missing, and the type checker says so.
    everyProvider(['codex', 'claude', 'grok', 'devin'])
  })

  it('refuses a list of every provider that names one twice', () => {
    expect(() => everyProvider(['codex', 'codex', 'claude', 'grok', 'devin', 'muse'])).toThrow('codex is listed twice in a list of every provider.')
  })
})
