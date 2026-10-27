// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentModel } from '../../../src/shared/agents'
import { fastModeRuns, validateThreadOptions } from '../../../src/main/agents/threadOptions'

// Fast mode (ADR-0143): the user's choice per thread, refused only when it is turned on for a model without it.
const opus: AgentModel = { id: 'opus', name: 'Opus 5.5', provider: 'Claude Code', providerId: 'claude', ready: true, fastMode: {} }
const sonnet: AgentModel = { id: 'sonnet', name: 'Sonnet 5.5', provider: 'Claude Code', providerId: 'claude', ready: true }
const host: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), connected: true, models: [opus, sonnet] }

describe('fast mode thread options', () => {
  it('turns on only for a model that offers it', () => {
    expect(() => validateThreadOptions(host, { fastMode: true }, 'opus')).not.toThrow()
    expect(() => validateThreadOptions(host, { fastMode: true }, 'sonnet')).toThrow('This model does not offer fast mode.')
    expect(() => validateThreadOptions(host, { fastMode: false }, 'sonnet')).not.toThrow()
  })

  it('keeps the choice through a change to a model without it, and through a thread created with it', () => {
    expect(() => validateThreadOptions(host, { modelId: 'sonnet' }, 'opus')).not.toThrow()
    // A thread record or a create command carries its model and its choice together; the choice is kept, not refused.
    expect(() => validateThreadOptions(host, { modelId: 'sonnet', fastMode: true })).not.toThrow()
  })

  it('runs only where the user chose it and the model offers it, a long-context variant on its base model\'s word', () => {
    expect(fastModeRuns(host, 'opus', true)).toBe(true)
    expect(fastModeRuns(host, 'opus[1m]', true)).toBe(true)
    expect(fastModeRuns(host, 'opus', undefined)).toBe(false)
    expect(fastModeRuns(host, 'sonnet', true)).toBe(false)
    expect(fastModeRuns(host, 'unknown', true)).toBe(false)
  })
})
