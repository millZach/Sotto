import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WatcherHold } from '../../../src/shared/watcherHold'
import type { WatcherRoomResult, WatcherRoomState } from '../../../src/shared/watcherRoom'
import type { WatcherRoom } from '../../../src/renderer/src/watcher/watcherRoom'
import { WatcherHoldBand, holdBandWords } from '../../../src/renderer/src/watcher/WatcherHoldBand'

/**
 * The band in Watcher's room while its own provider is limited or failing (#2234, Zach's pick A): one band, the one
 * notice, with What's held for a limit and Try now and Details for a failure. The provider's error shows only there.
 */
afterEach(cleanup)

// On this computer's own clock, so the times read the same in every zone the suite runs in.
const NOW = new Date(2026, 10, 5, 14, 41).valueOf()
const MONDAY = new Date(2026, 10, 9, 15, 0).valueOf()
const iso = (at: number): string => new Date(at).toISOString()

const limited: WatcherHold = { kind: 'limited', provider: 'claude', since: iso(NOW - 60 * 60_000), resetsAt: iso(MONDAY), tries: 0, held: 37, pullRequests: 6 }
const failing: WatcherHold = { kind: 'failing', provider: 'claude', since: iso(new Date(2026, 10, 5, 13, 22).valueOf()), nextTryAt: iso(NOW + 3 * 60_000),
  lastTryAt: iso(new Date(2026, 10, 5, 14, 38).valueOf()), tries: 16, held: 12, pullRequests: 2,
  detail: 'request to api.anthropic.com failed, reason: write EPROTO 28940000:error:0A00010B:SSL routines:ssl3_get_record:wrong version number' }

function room(hold: WatcherHold | undefined, tryNow: WatcherRoom['tryNow'] = null): WatcherRoom {
  return { status: 'ready', state: { hold } as WatcherRoomState, error: null, currentThreadId: 'watcher', watchedThreadIds: new Set(), open: null,
    setPermission: null, watchThread: null, unwatchThread: null, handover: null, startNew: null, tryNow,
    settle: (result: WatcherRoomResult) => result.status === 'refused' ? result.message : null, stopAll: null, readMachines: null }
}

describe('Watcher’s hold band', () => {
  it('says when the limit resets and how much news Sotto holds, and opens What’s held', async () => {
    render(<WatcherHoldBand room={room(limited)} now={NOW} />)
    const band = screen.getByRole('group', { name: 'Watcher’s Claude Code limit resets Monday at 3:00 pm.' })
    expect(band.textContent).toContain('Sotto is holding 37 news until then.')
    // A limit with a reset waits for it: nothing to try, and no error to show.
    expect(screen.queryByRole('button', { name: 'Try now' })).toBeNull()
    expect(screen.queryByText('Details')).toBeNull()
    const what = screen.getByRole('button', { name: 'What’s held' })
    expect(what.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(what)
    expect(what.getAttribute('aria-expanded')).toBe('true')
    expect(band.textContent).toContain('6 from pull requests, 31 from threads. Watcher gets it in one message at the reset. A message you send goes first.')
  })

  it('says a failing provider plainly, offers Try now and keeps the error under Details', async () => {
    const tried = vi.fn(async (): Promise<WatcherRoomResult> => ({ status: 'ok', state: { hold: failing } as WatcherRoomState }))
    render(<WatcherHoldBand room={room(failing, tried)} now={NOW} />)
    const band = screen.getByRole('group', { name: 'Claude Code isn’t answering.' })
    expect(band.textContent).toContain('Sotto holds news and tries again every few minutes. Holding 12 so far.')
    expect(band.textContent).toContain('Last try 2:38 pm')
    expect(band.textContent).toContain('Failing since 1:22 pm · 17 tries')
    // The error is there only for whoever opens Details.
    expect(screen.getByText(/write EPROTO/u).closest('details')?.open).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: 'Try now' }))
    expect(tried).toHaveBeenCalledTimes(1)
  })

  it('says what Try now could not do, and nothing at all while nothing holds Watcher', async () => {
    const refused = async (): Promise<WatcherRoomResult> => ({ status: 'refused', code: 'NOT_CURRENT_WATCHER', message: 'Open Watcher first. Nothing was sent.', retryable: true })
    const { rerender, container } = render(<WatcherHoldBand room={room(failing, refused)} now={NOW} />)
    await userEvent.click(screen.getByRole('button', { name: 'Try now' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Open Watcher first. Nothing was sent.'))
    rerender(<WatcherHoldBand room={room(undefined)} now={NOW} />)
    expect(container.textContent).toBe('')
  })

  it('words a limit that named no reset, and one whose reset has come', () => {
    expect(holdBandWords({ ...failing, kind: 'limited', provider: 'devin', held: 0 }, NOW)).toEqual({
      lead: 'Watcher’s Devin limit is used up, and Devin didn’t say when it resets.', rest: 'Sotto holds news and tries again every few minutes.', tryable: true })
    expect(holdBandWords({ ...limited, held: 0 }, NOW).rest).toBe('Sotto holds news until then.')
    expect(holdBandWords(limited, MONDAY + 1)).toEqual({ lead: 'Watcher’s Claude Code limit has reset.', rest: 'Watcher gets what Sotto held in one message now.', tryable: false })
  })
})
