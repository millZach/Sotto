// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePublicProviderEntityId, providerIdSchema, publicProviderEntityId } from '../../../src/shared/agents'

afterEach(() => { vi.restoreAllMocks() })

describe('public provider entity IDs', () => {
  it('reads back the provider, kind and value an ID was made from', () => {
    expect(parsePublicProviderEntityId(publicProviderEntityId('claude', 'model', 'claude-opus/1m'))).toEqual({ provider: 'claude', kind: 'model', value: 'claude-opus/1m' })
    expect(parsePublicProviderEntityId(publicProviderEntityId('codex', 'project', 'D:\\work\\sotto'))).toEqual({ provider: 'codex', kind: 'project', value: 'D:\\work\\sotto' })
  })

  it('answers null for an unknown provider and for a value that will not decode', () => {
    expect(parsePublicProviderEntityId('native:openai:model:gpt')).toBeNull()
    expect(parsePublicProviderEntityId('native:claude:model:%E0%A4%A')).toBeNull()
  })

  // Every model and project ID passes through here on every publish while Muse is held (#991). Most are not public
  // provider IDs, and asking zod about one built a ZodError each time: about a tenth of main while a thread streamed.
  it('answers an ID that is not a public provider ID without asking the provider schema', () => {
    const safeParse = vi.spyOn(providerIdSchema, 'safeParse')
    for (const id of ['fake:model', 'gpt-5.5', 'project-1', 'native:claude:thread:x', '']) expect(parsePublicProviderEntityId(id)).toBeNull()
    expect(safeParse).not.toHaveBeenCalled()
  })
})
