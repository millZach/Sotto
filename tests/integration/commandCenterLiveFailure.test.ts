// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { commandCenterLiveFailure } from '../fixtures/commandCenterLiveProbe'

it('aborts once when disconnect synchronously reports another failure', () => {
  const abort = vi.fn(() => failure.fail('disconnect-observer'))
  const failure = commandCenterLiveFailure(abort)
  expect(() => failure.fail('first-failure')).not.toThrow()
  failure.fail('later-failure')
  expect(failure.reason).toBe('first-failure')
  expect(abort).toHaveBeenCalledTimes(1)
})

it('keeps the first failure available for evidence even when abort throws', () => {
  const failure = commandCenterLiveFailure(() => { throw new Error('synthetic disconnect failure') })
  expect(() => failure.fail('first-failure')).not.toThrow()
  expect(failure.reason).toBe('first-failure')
})
