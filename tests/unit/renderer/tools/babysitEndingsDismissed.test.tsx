import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BABYSIT_ENDINGS_DISMISSED_KEY, babysitEndingDigest, useBabysitEndingsDismissed, type BabysitEnding } from '../../../../src/renderer/src/tools/babysitEndingsDismissed'

/**
 * Dismissing why babysitting ended is kept in the window's storage whether or not Keep local history is on
 * (ADR-0061's #825 amendment), so what it keeps must name no repository, pull request or thread.
 */
const stored = (): unknown => JSON.parse(localStorage.getItem(BABYSIT_ENDINGS_DISMISSED_KEY) ?? 'null')
let run = 0
/** Each test its own thread, since the hook remembers what this window dismissed for as long as the window is open. */
const ending = (endedAt = '2026-10-08T21:07:00.000Z'): BabysitEnding => ({ threadId: `thread-${run}`, url: 'https://github.com/Octo-Org/Greeter/pull/74', endedAt })

async function mounted(endings: readonly BabysitEnding[]) {
  const view = renderHook(({ list }) => useBabysitEndingsDismissed(list), { initialProps: { list: endings } })
  // A line stays away until its digest is worked out, a moment after it first appears.
  await waitFor(() => expect(endings.every(item => !view.result.current.dismissed(item))).toBe(true))
  return view
}

beforeEach(() => { run += 1; localStorage.removeItem(BABYSIT_ENDINGS_DISMISSED_KEY) })
afterEach(() => { localStorage.removeItem(BABYSIT_ENDINGS_DISMISSED_KEY) })

describe('the endings this window dismissed', () => {
  it('keeps each as a digest that names no repository, pull request or thread', async () => {
    const view = await mounted([ending()])
    act(() => { view.result.current.dismiss(ending()) })
    expect(view.result.current.dismissed(ending())).toBe(true)
    const raw = localStorage.getItem(BABYSIT_ENDINGS_DISMISSED_KEY)!
    expect(stored()).toEqual([expect.stringMatching(/^[0-9a-f]{32}$/u)])
    for (const name of ['octo', 'greeter', '74', 'thread', 'github', '2026']) expect(raw.toLowerCase()).not.toContain(name)
  })

  it('still shows a later ending of the same pull request, and the same ending on another thread', async () => {
    const later = ending('2026-10-09T08:00:00.000Z'), elsewhere = { ...ending(), threadId: `other-${run}` }
    const view = await mounted([ending(), later, elsewhere])
    act(() => { view.result.current.dismiss(ending()) })
    expect(view.result.current.dismissed(ending())).toBe(true)
    expect(view.result.current.dismissed(later)).toBe(false)
    expect(view.result.current.dismissed(elsewhere)).toBe(false)
  })

  it('reads a dismissal from storage alone, as a window opened later does', async () => {
    // Kept by another window: this one never pressed Dismiss, so only the record can say it.
    const digest = await babysitEndingDigest(ending())
    const keep = (record: readonly string[]) => act(() => {
      localStorage.setItem(BABYSIT_ENDINGS_DISMISSED_KEY, JSON.stringify(record))
      window.dispatchEvent(new StorageEvent('storage', { key: BABYSIT_ENDINGS_DISMISSED_KEY }))
    })
    const view = renderHook(() => useBabysitEndingsDismissed([ending()]))
    keep(['0'.repeat(32)])
    await waitFor(() => expect(view.result.current.dismissed(ending())).toBe(false))
    keep(['0'.repeat(32), digest])
    expect(view.result.current.dismissed(ending())).toBe(true)
  })

  it('keeps the newest 200 and drops anything in the record that is not a digest', async () => {
    const older = Array.from({ length: 200 }, (_, index) => index.toString(16).padStart(32, '0'))
    localStorage.setItem(BABYSIT_ENDINGS_DISMISSED_KEY, JSON.stringify(['thread-1 octo-org/greeter#74 2026-10-08T21:07:00.000Z', ...older]))
    const view = await mounted([ending()])
    act(() => { view.result.current.dismiss(ending()) })
    const kept = stored() as string[]
    expect(kept).toHaveLength(200)
    expect(kept.slice(0, -1)).toEqual(older.slice(1))
    expect(kept.at(-1)).toMatch(/^[0-9a-f]{32}$/u)
    expect(localStorage.getItem(BABYSIT_ENDINGS_DISMISSED_KEY)).not.toContain('greeter')
  })
})
