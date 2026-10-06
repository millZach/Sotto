// @vitest-environment node
import { stripRetiredEndpoint } from '../../../src/main/agents/providerRetirement'
import { describe, expect, it } from 'vitest'
import { agentCommandSchema, agentConfigurationSchema, defaultAgentConfiguration } from '../../../src/shared/agents'

describe('Sotto has no account', () => {
  it('drops the retired endpoint when loading saved configuration', () => {
    const configuration = agentConfigurationSchema.parse(stripRetiredEndpoint({ ...defaultAgentConfiguration(), membershipEndpoint: 'https://untrusted.example' }))
    expect(configuration).not.toHaveProperty('membershipEndpoint')
  })

  it('rejects retired account commands and credential slots at the command boundary', () => {
    for (const action of ['refresh', 'signin', 'checkout', 'portal']) {
      expect(agentCommandSchema.safeParse({ type: 'membership', action }).success).toBe(false)
    }
    expect(agentCommandSchema.safeParse({ type: 'credential', slot: 'membership', value: 'secret' }).success).toBe(false)
    expect(agentCommandSchema.safeParse({ type: 'configure', patch: { membershipEndpoint: 'https://untrusted.example' } }).success).toBe(false)
  })
})
