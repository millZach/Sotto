// @vitest-environment node
// Ultracode as a level (ADR-0148): where Claude Code offers it, and the real effort it runs at on each model.
import { describe, expect, it } from 'vitest'
import { agentConfigurationSchema, defaultAgentConfiguration, type AgentModel } from '../../../src/shared/agents'
import { effortRank } from '../../../src/shared/reasoningEfforts'
import { DEFAULT_ULTRACODE_EFFORT, ultracodeRunsAt, withUltracode } from '../../../src/shared/ultracode'
import { fitEffort } from '../../../src/shared/workerRoles'

describe('withUltracode', () => {
  it('puts Ultracode after Max on a model with Extra high, the models Claude Code runs it on', () => {
    expect(withUltracode(['low', 'medium', 'high', 'xhigh', 'max'])).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(withUltracode(['low', 'medium', 'high', 'xhigh'])).toEqual(['low', 'medium', 'high', 'xhigh', 'ultracode'])
  })

  it('leaves a model without Extra high, or without levels, as it was', () => {
    expect(withUltracode(['low', 'medium', 'high', 'max'])).toEqual(['low', 'medium', 'high', 'max'])
    expect(withUltracode([])).toEqual([])
  })

  it('never adds it twice', () => {
    expect(withUltracode(['low', 'xhigh', 'max', 'ultracode'])).toEqual(['low', 'xhigh', 'max', 'ultracode'])
  })
})

describe('ultracodeRunsAt', () => {
  const all = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']

  it('runs at the chosen level where the model offers it', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) expect(ultracodeRunsAt(all, level)).toBe(level)
  })

  it('runs at the nearest level below the chosen one where the model lacks it', () => {
    expect(ultracodeRunsAt(['low', 'medium', 'high', 'xhigh', 'ultracode'], 'max')).toBe('xhigh')
    expect(ultracodeRunsAt(['low', 'high', 'xhigh', 'ultracode'], 'medium')).toBe('low')
  })

  it('runs at the lowest level the model offers when none is at or below the chosen one', () => {
    expect(ultracodeRunsAt(['high', 'xhigh', 'ultracode'], 'low')).toBe('high')
  })

  it('has nothing to run at on a model with no levels', () => {
    expect(ultracodeRunsAt([], 'xhigh')).toBeUndefined()
  })

  it('starts at Extra high, which is what Claude Code runs for --effort ultracode', () => {
    expect(DEFAULT_ULTRACODE_EFFORT).toBe('xhigh')
    expect(defaultAgentConfiguration().claudeUltracodeEffort).toBe('xhigh')
    // A configuration saved before the setting existed reads as the default.
    const saved: Partial<ReturnType<typeof defaultAgentConfiguration>> = defaultAgentConfiguration()
    delete saved.claudeUltracodeEffort
    expect(agentConfigurationSchema.parse(saved).claudeUltracodeEffort).toBe('xhigh')
    expect(agentConfigurationSchema.safeParse({ ...saved, claudeUltracodeEffort: 'ultracode' }).success).toBe(false)
  })
})

describe('Ultracode among other levels', () => {
  it('ranks above Max, so a default of Ultracode lands on another provider\'s highest level', () => {
    expect(effortRank('ultracode')).toBeGreaterThan(effortRank('max')!)
    const codex: AgentModel = { id: 'gpt', name: 'GPT-6.1 Sol', provider: 'Codex', providerId: 'codex', ready: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] }
    expect(fitEffort('ultracode', codex)).toBe('xhigh')
  })
})
