// @vitest-environment node
// How a Claude thread's level reaches Claude Code (ADR-0148): Ultracode is the `ultracode` session setting beside a real
// effort, at launch and in place, and never an effort of its own.
import { describe, expect, it } from 'vitest'
import { flagSettingsArguments, nativeEffort, settingsSteps } from '../../../src/main/agents/claude'

const settings = (reasoningEffort: string | undefined, modelId = 'opus') => ({ modelId, reasoningEffort, runtimeMode: 'approval-required' as const, fastMode: false })
const requests = (steps: ReturnType<typeof settingsSteps>) => steps?.map(step => step.request)

describe('nativeEffort', () => {
  it('sends Ultracode as the level it runs at, with ultracode on', () => {
    expect(nativeEffort('ultracode', 'high')).toEqual({ effortLevel: 'high', ultracode: true })
    expect(nativeEffort('ultracode', 'xhigh')).toEqual({ effortLevel: 'xhigh', ultracode: true })
  })

  it('sends every other level as itself, with ultracode off', () => {
    expect(nativeEffort('max', 'high')).toEqual({ effortLevel: 'max', ultracode: false })
    expect(nativeEffort(undefined, 'high')).toEqual({ effortLevel: undefined, ultracode: false })
  })
})

describe('flagSettingsArguments', () => {
  it('names fast mode and Ultracode on every launch, off as well as on, so the user\'s own Claude Code settings never turn either on', () => {
    expect(flagSettingsArguments(false, false)).toEqual(['--settings', '{"fastMode":false,"ultracode":false}'])
    expect(flagSettingsArguments(true, true)).toEqual(['--settings', '{"fastMode":true,"ultracode":true}'])
  })
})

describe('settingsSteps', () => {
  it('turns Ultracode on with the level it runs at, in one request', () => {
    const steps = settingsSteps(settings('medium'), settings('ultracode'), 'high')
    expect(requests(steps)).toEqual([{ subtype: 'apply_flag_settings', settings: { effortLevel: 'high', ultracode: true } }])
    expect(steps?.[0]?.ultracodeEffort).toBe('high')
  })

  it('turns it off with the new level, in one request', () => {
    const steps = settingsSteps(settings('ultracode'), settings('max'), 'high')
    expect(requests(steps)).toEqual([{ subtype: 'apply_flag_settings', settings: { effortLevel: 'max', ultracode: false } }])
    expect(steps?.[0]?.ultracodeEffort).toBeNull()
  })

  it('leaves it unnamed between two other levels, where the launch already holds it off', () => {
    const steps = settingsSteps(settings('medium'), settings('max'), 'high')
    expect(requests(steps)).toEqual([{ subtype: 'apply_flag_settings', settings: { effortLevel: 'max' } }])
    expect(steps?.[0]?.ultracodeEffort).toBeUndefined()
  })

  it('takes a model change to its new model\'s level, and a change back to the model default off Ultracode', () => {
    expect(requests(settingsSteps(settings('ultracode'), settings(undefined, 'sonnet'), 'high'))).toEqual([
      { subtype: 'set_model', model: 'sonnet' },
      { subtype: 'apply_flag_settings', settings: { effortLevel: null, ultracode: false } },
    ])
  })
})
