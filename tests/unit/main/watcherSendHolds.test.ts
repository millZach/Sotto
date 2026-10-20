import { describe, expect, it } from 'vitest'
import { NO_TURN_TO_STEER, queueHold, RUNNING_TURN_HOLD } from '../../../src/main/agents/watcherSendHolds'

describe('what a refused Watcher send says it waits on (#1203)', () => {
  it('names a different hold for each reason, and never background work as one', () => {
    const said = [RUNNING_TURN_HOLD, NO_TURN_TO_STEER, queueHold('pending-work', false), queueHold('pending-work', true),
      queueHold('paused-followups', false), queueHold('failed-followups', false), queueHold('uncertain-send', false)]
    expect(new Set(said).size).toBe(said.length)
    for (const text of said) expect(text).toMatch(/Nothing was sent\.$/u)
    expect(said.filter(text => /background/u.test(text))).toEqual([NO_TURN_TO_STEER])
    expect(NO_TURN_TO_STEER).toContain('does not hold a send')
  })
})
