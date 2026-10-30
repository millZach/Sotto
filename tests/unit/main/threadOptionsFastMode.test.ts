// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentModel } from '../../../src/shared/agents'
import { fastModeRuns, speedAfterChange, speedRuns, validateThreadOptions } from '../../../src/main/agents/threadOptions'

// Fast mode (ADR-0143): the user's choice per thread, refused only when it is turned on for a model without it.
const opus: AgentModel = { id: 'opus', name: 'Opus 5.5', provider: 'Claude Code', providerId: 'claude', ready: true, fastMode: {} }
const sonnet: AgentModel = { id: 'sonnet', name: 'Sonnet 5.5', provider: 'Claude Code', providerId: 'claude', ready: true }
const codex: AgentModel = { id: 'codex', name: 'Codex', provider: 'Codex', providerId: 'codex', ready: true,
  speeds: [{ id: 'fast', name: 'Fast' }, { id: 'ultrafast', name: 'Ultrafast' }] }
const host: AgentHostSnapshot = { ...structuredClone(EMPTY_AGENT_HOST), connected: true, models: [opus, sonnet, codex] }

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

  it('gives the speed field precedence, including a null that clears a legacy fast choice', () => {
    expect(speedAfterChange({ fastMode: true })).toBe('fast')
    expect(speedAfterChange({ fastMode: false }, 'ultrafast')).toBeNull()
    expect(speedAfterChange({ speed: 'ultrafast', fastMode: true })).toBe('ultrafast')
    expect(speedAfterChange({ speed: null, fastMode: true }, 'ultrafast')).toBeNull()
    expect(speedAfterChange({}, 'ultrafast')).toBe('ultrafast')
  })

  it('runs the exact advertised speed and keeps an unavailable choice without substituting fast', () => {
    expect(speedRuns(host, 'codex', 'ultrafast')).toBe('ultrafast')
    expect(speedRuns(host, 'codex', 'fast')).toBe('fast')
    expect(speedRuns(host, 'codex', null)).toBeNull()
    expect(speedRuns(host, 'opus', 'ultrafast')).toBeNull()
    expect(speedRuns(host, 'sonnet', 'ultrafast')).toBeNull()
    expect(fastModeRuns(host, 'codex', true)).toBe(true)
  })

  it('validates ultrafast separately and permits clearing speed on any model', () => {
    expect(() => validateThreadOptions(host, { speed: 'ultrafast' }, 'codex')).not.toThrow()
    expect(() => validateThreadOptions(host, { speed: 'ultrafast' }, 'opus')).toThrow('This model does not offer ultrafast speed.')
    expect(() => validateThreadOptions(host, { speed: null, fastMode: true }, 'sonnet')).not.toThrow()
    expect(() => validateThreadOptions(host, { modelId: 'sonnet', speed: 'ultrafast' })).toThrow('This model does not offer ultrafast speed.')
    expect(() => validateThreadOptions(host, { modelId: 'sonnet', speed: 'ultrafast' }, undefined, true)).not.toThrow()
  })
})
