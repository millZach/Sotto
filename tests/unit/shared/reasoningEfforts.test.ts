// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { effortKey, orderReasoningEfforts } from '../../../src/shared/reasoningEfforts'

describe('orderReasoningEfforts', () => {
  it("turns Grok's highest-first lists round", () => {
    expect(orderReasoningEfforts(['xhigh', 'high', 'medium', 'low'])).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(orderReasoningEfforts(['high', 'medium', 'low'])).toEqual(['low', 'medium', 'high'])
  })

  it('leaves lists that already run lowest first as they are', () => {
    expect(orderReasoningEfforts(['low', 'medium', 'high', 'xhigh', 'max'])).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(orderReasoningEfforts(['none', 'low', 'medium', 'high', 'xhigh'])).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(orderReasoningEfforts(['minimal', 'low', 'medium', 'high'])).toEqual(['minimal', 'low', 'medium', 'high'])
  })

  it('keeps a level it does not know beside its neighbours', () => {
    expect(orderReasoningEfforts(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(orderReasoningEfforts(['ultra', 'xhigh', 'high', 'low'])).toEqual(['low', 'high', 'xhigh', 'ultra'])
  })

  it('recognises spelling variants and returns the ids verbatim', () => {
    expect(effortKey('x-high')).toBe('xhigh')
    expect(effortKey('X_High')).toBe('xhigh')
    expect(effortKey('Extra high')).toBe('extrahigh')
    expect(orderReasoningEfforts(['X_High', 'High', 'low'])).toEqual(['low', 'High', 'X_High'])
    expect(orderReasoningEfforts(['extra-high', 'medium'])).toEqual(['medium', 'extra-high'])
  })

  it('drops a repeated id', () => {
    expect(orderReasoningEfforts(['high', 'low', 'high'])).toEqual(['low', 'high'])
    expect(orderReasoningEfforts(['low', 'low', 'high'])).toEqual(['low', 'high'])
  })

  it('leaves lists with no direction alone', () => {
    expect(orderReasoningEfforts([])).toEqual([])
    expect(orderReasoningEfforts(['high'])).toEqual(['high'])
    expect(orderReasoningEfforts(['turbo', 'deep'])).toEqual(['turbo', 'deep'])
    expect(orderReasoningEfforts(['turbo', 'high', 'deep'])).toEqual(['turbo', 'high', 'deep'])
  })

  it('does not change the list it was given', () => {
    const reported = ['xhigh', 'high', 'low']
    orderReasoningEfforts(reported)
    expect(reported).toEqual(['xhigh', 'high', 'low'])
  })
})
