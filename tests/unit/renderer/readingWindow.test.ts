import { describe, expect, it } from 'vitest'

import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentMessage, AgentThread } from '../../../src/shared/agents'
import { HELD_MESSAGES_MAX, readingWindow, type ReadingWindow } from '../../../src/renderer/src/agents/readingWindow'

/**
 * Main keeps a thread on screen as a window of its newest turns, so each message that begins a turn takes the oldest turn
 * off the top: in Watcher's conversation, every piece of news. A reader above the end keeps what the window let go.
 */
describe('the window a transcript draws while its reader is above the end', () => {
  const message = (index: number): AgentMessage => ({ id: `m${index}`, role: index % 2 === 0 ? 'user' : 'assistant', text: `Message ${index}`, createdAt: new Date(Date.UTC(2026, 10, 13, 9, index)).toISOString() })
  /** Main's window: the messages numbered from `first` up to, not including, `end`. */
  const windowOf = (first: number, end: number, more: Partial<AgentThread> = {}): AgentThread => ({ id: 'watcher', title: 'Watcher', projectId: 'workshop', status: 'idle', requests: [],
    messages: Array.from({ length: end - first }, (_, index) => message(first + index)), ...(first > 0 ? { earlierAvailable: true } : {}), ...more }) as AgentThread
  const ids = (window: ReadingWindow): string[] => window.thread.messages.map(item => item.id)
  const numbered = (first: number, end: number): string[] => Array.from({ length: end - first }, (_, index) => `m${first + index}`)

  it('draws main’s own thread while nothing was let go, and the same one for the same thread', () => {
    const source = windowOf(0, 20)
    const first = readingWindow(null, source, true)
    expect(first.thread).toBe(source)
    expect(first.held).toBe(0)
    expect(readingWindow(first, source, true)).toBe(first)
    expect(readingWindow(first, source, false)).toBe(first)
    // A chunk of the newest reply is a new thread with the same first message: nothing is held, so it is drawn as it is.
    const grown = windowOf(0, 21)
    expect(readingWindow(first, grown, true).thread).toBe(grown)
  })

  it('keeps the turn the window let go ahead of it, through each piece of news, for a reader above the end', () => {
    let window = readingWindow(null, windowOf(0, 20), true)
    window = readingWindow(window, windowOf(2, 21), true)
    expect(ids(window)).toEqual(numbered(0, 21))
    expect(window.held).toBe(2)
    window = readingWindow(window, windowOf(4, 22), true)
    expect(ids(window)).toEqual(numbered(0, 22))
    expect(window.held).toBe(4)
    // A chunk that moves nothing costs one look at where the window began, and holds the same messages.
    const chunk = windowOf(4, 22)
    const next = readingWindow(window, chunk, true)
    expect(ids(next)).toEqual(numbered(0, 22))
    expect(next.thread.messages.slice(0, 4)).toEqual(window.thread.messages.slice(0, 4))
    expect(readingWindow(next, chunk, true)).toBe(next)
  })

  it('lets them go once the reader is back at the end, and holds nothing for a reader who is there', () => {
    const slid = windowOf(2, 21)
    const held = readingWindow(readingWindow(null, windowOf(0, 20), true), slid, true)
    const back = readingWindow(held, slid, false)
    expect(back.thread).toBe(slid)
    expect(back.held).toBe(0)
    expect(readingWindow(readingWindow(null, windowOf(0, 20), false), slid, false).thread).toBe(slid)
  })

  it('says older messages are above what it holds only when they are', () => {
    // The whole history was on screen: holding its start leaves nothing earlier to show.
    const whole = readingWindow(readingWindow(null, windowOf(0, 20), true), windowOf(2, 21), true)
    expect(whole.thread.earlierAvailable).toBeUndefined()
    // The window already began above the store's older messages: they are still there.
    const partial = readingWindow(readingWindow(null, windowOf(6, 20), true), windowOf(8, 21), true)
    expect(ids(partial)).toEqual(numbered(6, 21))
    expect(partial.thread.earlierAvailable).toBe(true)
  })

  it('holds up to its limit, and lets all of it go for a reader who stayed while more than that left the window', () => {
    let window = readingWindow(null, windowOf(0, 20), true)
    for (let first = 2; first <= HELD_MESSAGES_MAX; first += 2) window = readingWindow(window, windowOf(first, first + 20), true)
    expect(window.held).toBe(HELD_MESSAGES_MAX)
    expect(ids(window)).toEqual(numbered(0, HELD_MESSAGES_MAX + 20))
    const past = windowOf(HELD_MESSAGES_MAX + 2, HELD_MESSAGES_MAX + 22)
    window = readingWindow(window, past, true)
    expect(window.thread).toBe(past)
    expect(window.held).toBe(0)
  })

  it('keeps the work of the turns it holds, so they stay folded as they were, and never a running turn’s', () => {
    const work = (turn: number, status: AgentActivity['status'] = 'completed'): AgentActivity[] => [
      { id: `turn-m${turn}`, turnId: `m${turn}`, afterMessageId: `m${turn}`, sequence: turn * 2, kind: 'turn', status, title: 'Turn' },
      { id: `tool-m${turn}`, turnId: `m${turn}`, afterMessageId: `m${turn}`, sequence: turn * 2 + 1, kind: 'tool', status, title: 'read_thread' },
    ]
    /** Main's window with the work of each of its turns, as the detail gives it. */
    const worked = (first: number, end: number, more: readonly AgentActivity[] = []): AgentThread =>
      windowOf(first, end, { activities: [...Array.from({ length: Math.ceil((end - first) / 2) }, (_, index) => work(first + index * 2)).flat(), ...more] })
    const turnsOf = (window: ReadingWindow): string[] => [...new Set((window.thread.activities ?? []).map(record => record.turnId))]
    let window = readingWindow(null, worked(0, 8), true)
    window = readingWindow(window, worked(2, 10), true)
    expect(turnsOf(window)).toEqual(['m0', 'm2', 'm4', 'm6', 'm8'])
    window = readingWindow(window, worked(4, 12), true)
    expect(turnsOf(window)).toEqual(['m0', 'm2', 'm4', 'm6', 'm8', 'm10'])
    expect(window.work.map(record => record.id)).toEqual(['turn-m0', 'tool-m0', 'turn-m2', 'tool-m2'])
    // A chunk of the newest reply brings the same records: the turns above are drawn from the list they were.
    const before = window.thread.activities
    const source = window.source
    window = readingWindow(window, { ...source, messages: [...source.messages] }, true)
    expect(window.thread.activities).toBe(before)
    // A news turn that ran and went without a reply is not a turn the window let go: its working line does not stay.
    const silent = work(99, 'running')
    window = readingWindow(window, worked(4, 12, silent), true)
    expect(turnsOf(window)).toContain('m99')
    window = readingWindow(window, worked(4, 12), true)
    expect(turnsOf(window)).toEqual(['m0', 'm2', 'm4', 'm6', 'm8', 'm10'])
    // Show earlier messages brings a held turn back into the window: main's records for it are the ones drawn, once.
    window = readingWindow(window, worked(2, 12), true)
    expect(ids(window)).toEqual(numbered(0, 12))
    expect((window.thread.activities ?? []).map(record => record.id).filter(id => id === 'turn-m2')).toHaveLength(1)
    expect(window.work.map(record => record.id)).toEqual(['turn-m0', 'tool-m0'])
    // Back at the end, the work goes with its messages.
    const end = worked(4, 12)
    expect(readingWindow(window, end, false).thread).toBe(end)
  })

  it('draws main’s window as it is when it no longer meets what was drawn', () => {
    const held = readingWindow(readingWindow(null, windowOf(10, 30), true), windowOf(12, 31), true)
    expect(held.held).toBe(2)
    // Show earlier messages widened the window past what was held.
    const widened = windowOf(0, 31)
    expect(readingWindow(held, widened, true).thread).toBe(widened)
    // Widened to exactly the oldest message held: the window has it all.
    const met = windowOf(10, 31)
    expect(readingWindow(held, met, true).thread).toBe(met)
    // Moved on past everything drawn: holding would leave a gap that reads as one conversation.
    const far = windowOf(40, 60)
    expect(readingWindow(held, far, true).thread).toBe(far)
    // Another thread, another history of the same thread, and a thread whose messages went.
    const other = { ...windowOf(14, 32), id: 'another' }
    expect(readingWindow(held, other, true).thread).toBe(other)
    const rewound = windowOf(14, 32, { historyEpoch: 'after-a-rewind' })
    expect(readingWindow(held, rewound, true).thread).toBe(rewound)
    const emptied = windowOf(0, 0)
    expect(readingWindow(held, emptied, true).thread).toBe(emptied)
  })
})
