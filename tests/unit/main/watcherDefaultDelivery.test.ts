import { describe, expect, it } from 'vitest'
import { defaultDelivery } from '../../../src/main/agents/watcherSendHolds'
import { watcherToolSchemas } from '../../../src/shared/watcher'

const target = { hostId: '00000000-0000-4000-8000-000000000001', threadId: 'thread' }
const send = { requestId: '00000000-0000-4000-8000-000000000002', retryKey: '00000000-0000-4000-8000-000000000003', target, text: 'Synthetic prompt' }

describe('what a Watcher send that names no delivery does (ADR-0130)', () => {
  it('may leave delivery out, and still takes each named one', () => {
    expect(watcherToolSchemas.send_to_thread.input.parse(send)).not.toHaveProperty('delivery')
    for (const delivery of ['now', 'queue', 'steer'] as const) expect(watcherToolSchemas.send_to_thread.input.parse({ ...send, delivery })).toMatchObject({ delivery })
    expect(() => watcherToolSchemas.send_to_thread.input.parse({ ...send, delivery: 'later' })).toThrow()
  })

  it('steers a running turn, into the turn it reads as running unless the send names one', () => {
    const running = { status: 'running' as const, lastTurn: { id: 'turn-2', status: 'running' as const } }
    expect(defaultDelivery(running, true, undefined)).toEqual({ delivery: 'steer', expectedTurnId: 'turn-2' })
    expect(defaultDelivery(running, true, 'turn-1')).toEqual({ delivery: 'steer', expectedTurnId: 'turn-1' })
    // A turn Sotto has not confirmed, as one resumed after a card (#1490), is steered unfenced: whichever turn runs.
    expect(defaultDelivery({ status: 'running' }, true, undefined)).toEqual({ delivery: 'steer' })
    expect(defaultDelivery({ status: 'running', lastTurn: { id: 'turn-1', status: 'completed' } }, true, undefined)).toEqual({ delivery: 'steer' })
  })

  it('goes now when the thread’s turn is over, so it never fails as a steer would', () => {
    expect(defaultDelivery({ status: 'idle', lastTurn: { id: 'turn-1', status: 'completed' } }, true, undefined)).toEqual({ delivery: 'now' })
    expect(defaultDelivery({ status: 'error' }, true, undefined)).toEqual({ delivery: 'now' })
    expect(defaultDelivery({ status: 'idle' }, false, undefined)).toEqual({ delivery: 'now' })
  })

  it('queues only for a turn under way that cannot be steered', () => {
    expect(defaultDelivery({ status: 'running', lastTurn: { id: 'turn-1', status: 'running' } }, false, undefined)).toEqual({ delivery: 'queue' })
    // Native idle can come before the turn's completion: the turn is still under way, so a send now would start another.
    expect(defaultDelivery({ status: 'idle', lastTurn: { id: 'turn-1', status: 'running' } }, true, undefined)).toEqual({ delivery: 'queue' })
  })
})
