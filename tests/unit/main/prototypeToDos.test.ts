import { describe, expect, it, vi } from 'vitest'
import { PrototypeToDos } from '../../../src/main/agents/prototypeToDos'
import type { PrototypeReady, QuestionPage } from '../../../src/shared/agents'
import { TO_DOS_MADE_MAX, toDoListSchema } from '../../../src/shared/toDos'

const page = (token: string): QuestionPage => ({ token: token.padEnd(32, 'x'), kind: 'file', name: 'greeting.html', start: 'greeting.html' })
const mark = (source: string, token = 'a'): PrototypeReady => ({ source, pages: [page(token)] })

function fixture(initial: readonly [string, PrototypeReady][]) {
  const marks = new Map(initial), opened = vi.fn<(token: string) => void>(), changed = vi.fn<() => void>()
  const made = new PrototypeToDos(() => marks, opened, changed, () => Date.parse('2026-11-04T00:00:00.000Z'))
  made.markChanged()
  return { marks, opened, changed, made }
}

describe('a prototype waiting for review as a to-do', () => {
  it('reads as Sotto\'s, naming its thread and waiting on nothing, in the shape the list takes', () => {
    const { made } = fixture([['thread-1', mark('reply:one')]])
    const items = made.view()
    expect(items).toEqual([{ id: expect.stringMatching(/^prototype-/u), title: 'Review the prototype', threadId: 'thread-1', by: 'prototype', waits: false, seen: false, addedAt: '2026-11-04T00:00:00.000Z' }])
    expect(toDoListSchema.safeParse(items).success).toBe(true)
  })
  it('keeps its identity until something changes, so a client is told only of a real change', () => {
    const { made, marks } = fixture([['thread-1', mark('reply:one')]])
    const items = made.view()
    expect(made.view()).toBe(items)
    marks.set('thread-2', mark('reply:two'))
    made.markChanged()
    const later = made.view()
    expect(later).not.toBe(items)
    expect(later[0]!.id).toBe(items[0]!.id)
    expect(later).toHaveLength(2)
  })
  it('tells the list once after an update, however many marks it changed', async () => {
    const { made, changed } = fixture([])
    made.markChanged(); made.markChanged(); made.markChanged()
    expect(changed).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(changed).toHaveBeenCalledTimes(1)
  })
  it('stays seen for its source, and a newer reply\'s page is new again', () => {
    const { made, marks } = fixture([['thread-1', mark('reply:one')]])
    expect(made.allSeen()).toBe(true)
    expect(made.view()[0]!.seen).toBe(true)
    expect(made.allSeen()).toBe(false)
    marks.set('thread-1', mark('reply:two'))
    made.markChanged()
    expect(made.view()[0]!.seen).toBe(false)
  })
  it('stays seen after a restart, with its ID read back before or after its mark', () => {
    const { made } = fixture([['thread-1', mark('reply:one')]])
    made.allSeen()
    const ids = made.seenIds()
    const { made: again } = fixture([['thread-1', mark('reply:one')]])
    expect(again.view()[0]!.seen).toBe(false)
    again.restoreSeen(ids)
    expect(again.view()[0]!.seen).toBe(true)
  })
  it('counts as reviewed when checked off, as opening a page is', () => {
    const { made, opened } = fixture([['thread-1', mark('reply:one', 'tok')]])
    expect(made.checked(made.view()[0]!.id)).toBe(true)
    expect(opened).toHaveBeenCalledExactlyOnceWith(page('tok').token)
    expect(made.checked('prototype-nothing')).toBe(false)
  })
  it('lists no more than the list can carry', () => {
    const { made } = fixture(Array.from({ length: TO_DOS_MADE_MAX + 5 }, (_, index) => [`thread-${index}`, mark(`reply:${index}`)] as [string, PrototypeReady]))
    expect(made.view()).toHaveLength(TO_DOS_MADE_MAX)
  })
})
