// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { nearestReasoningEffort, nearestRuntimeMode, resolveNewThreadPermission } from '../../../src/shared/newThreadDefaults'
import type { AgentModel } from '../../../src/shared/agents'

const grok: AgentModel = { id: 'native:grok:model:grok-4.7', provider: 'Grok', providerId: 'grok', name: 'Grok 4.7', ready: true,
  reasoningEfforts: ['low', 'high'], runtimeModes: ['approval-required', 'auto', 'full-access'] }
const claude: AgentModel = { id: 'native:claude:model:sonnet', provider: 'Claude', providerId: 'claude', name: 'Claude Sonnet', ready: true,
  reasoningEfforts: ['low', 'medium', 'high', 'max'], runtimeModes: ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] }
const devin: AgentModel = { id: 'native:devin:model:swe', provider: 'Devin', providerId: 'devin', name: 'SWE-1.6', ready: true,
  providerModes: [{ id: 'ask-first', name: 'Ask first' }, { id: 'bypass', name: 'Bypass Permissions', asks: 'Sotto asks about nothing.' }] }

describe('nearest runtime mode (issue #347)', () => {
  it('keeps the desired mode when the provider offers it', () => {
    expect(nearestRuntimeMode('full-access', claude.runtimeModes!)).toBe('full-access')
  })
  it('steps down to the nearest safer offered mode: Grok has no Allow edits', () => {
    expect(nearestRuntimeMode('auto-accept-edits', grok.runtimeModes!)).toBe('approval-required')
  })
  it('falls back to the least risky offered mode when nothing safer is offered', () => {
    expect(nearestRuntimeMode('approval-required', ['auto', 'full-access'])).toBe('auto')
  })
  it('has nothing to offer when the model reports no runtime modes at all', () => {
    expect(nearestRuntimeMode('auto', [])).toBeUndefined()
  })
})

describe('resolved new-thread permission', () => {
  it('is unset when no default is chosen and the model uses Sotto’s four modes', () => {
    expect(resolveNewThreadPermission(claude, undefined)).toEqual({ nearestFit: false })
  })
  it('is exactly the chosen default when the model offers it', () => {
    expect(resolveNewThreadPermission(claude, 'full-access')).toEqual({ runtimeMode: 'full-access', nearestFit: false })
  })
  it('is the nearest fit, marked, when the model does not offer the chosen default', () => {
    expect(resolveNewThreadPermission(grok, 'auto-accept-edits')).toEqual({ runtimeMode: 'approval-required', nearestFit: true })
  })
  it('is the model’s first profile for a provider with its own permission modes, whatever the default is', () => {
    expect(resolveNewThreadPermission(devin, undefined)).toEqual({ providerMode: 'ask-first', nearestFit: false })
    expect(resolveNewThreadPermission(devin, 'full-access')).toEqual({ providerMode: 'ask-first', nearestFit: false })
  })
  it('is unset for a model with no runtime modes and no provider modes', () => {
    const bare: AgentModel = { id: 'x', provider: 'X', name: 'X', ready: true }
    expect(resolveNewThreadPermission(bare, 'full-access')).toEqual({ nearestFit: false })
  })
})

describe('nearest reasoning effort', () => {
  it('maps the desired effort’s position in the reference list onto the offered list', () => {
    // 'high' sits third of four on Claude's list (ratio 2/3); Grok's own list has two levels, so that lands on 'high'.
    expect(nearestReasoningEffort('high', claude.reasoningEfforts!, grok.reasoningEfforts!)).toBe('high')
    // 'medium' sits second of four (ratio 1/3), closer to Grok's first level than its second.
    expect(nearestReasoningEffort('medium', claude.reasoningEfforts!, grok.reasoningEfforts!)).toBe('low')
  })
  it('is undefined when the model offers no reasoning efforts at all', () => {
    expect(nearestReasoningEffort('high', claude.reasoningEfforts!, [])).toBeUndefined()
  })
  it('falls back to the provider default, never the top, when the desired level has no reference position', () => {
    expect(nearestReasoningEffort('extreme', [], grok.reasoningEfforts!)).toBeUndefined()
  })
  it('maps a low reference level onto the offered list’s own low end, such as a minimal Claude level Grok lacks', () => {
    expect(nearestReasoningEffort('minimal', ['minimal', ...claude.reasoningEfforts!], grok.reasoningEfforts!)).toBe('low')
  })
  it('maps the top reference level onto the offered list’s own highest, even with fewer levels to choose from', () => {
    expect(nearestReasoningEffort('max', claude.reasoningEfforts!, grok.reasoningEfforts!)).toBe('high')
  })
  it('falls back to the provider default for a one-level reference, which has no low-to-high position to map', () => {
    expect(nearestReasoningEffort('default', ['default'], grok.reasoningEfforts!)).toBeUndefined()
  })
})
