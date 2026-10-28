// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { share } from '../../../../src/renderer/src/agents/stateSharing'

describe('structural sharing of derived facts', () => {
  it('keeps a value holding NaN when it is NaN on both sides', () => {
    const previous = { id: 'row', activityAt: Number.NaN, workingSince: Number.NaN, tags: [Number.NaN] }
    expect(share(previous, structuredClone(previous))).toBe(previous)
    expect(share(new Map([['row', Number.NaN]]), new Map([['row', Number.NaN]]))).toEqual(new Map([['row', Number.NaN]]))
    const map = new Map([['row', Number.NaN]])
    expect(share(map, new Map(map))).toBe(map)
  })

  it('hands back a new value that borrows nothing, so sharing a shared value again changes nothing', () => {
    const previous = { thread: { id: 't', title: 'Old', messages: [{ id: 'm', text: 'Hello' }] }, when: '2:02 pm' }
    const next = { thread: { id: 't', title: 'New', messages: [{ id: 'm', text: 'Hello' }] }, when: '2:02 pm' }
    const shared = share(previous, next)
    expect(shared).toEqual(next)
    expect(shared.thread.messages).toBe(previous.thread.messages)
    expect(share(previous, shared)).toBe(shared)
    const fresh = { thread: { id: 'other', title: 'Other' }, when: '3:00 pm' }
    expect(share(previous, fresh)).toBe(fresh)
  })

  it('matches an item the old array held to itself wherever it moved', () => {
    // Rows with no `id` of their own, each with an equal project of its own: matched against a neighbour, a row would
    // borrow the neighbour's project and come back a new object.
    const rows = Array.from({ length: 5 }, (_, index) => ({ thread: { title: `Thread ${index}`, at: index }, project: { title: 'Workshop' } }))
    const changed = { thread: { title: 'Thread 3', at: 99 }, project: { title: 'Workshop' } }
    // One row changed and moved to the front; the rest shifted down one place.
    const resorted = [changed, rows[0]!, rows[1]!, rows[2]!, rows[4]!]
    const shared = share(rows, resorted)
    expect(shared).toEqual(resorted)
    expect(shared.slice(1).every((row, index) => row === resorted[index + 1])).toBe(true)
  })
})
