import React, { Profiler } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentMessage } from '../../src/shared/agents'
import type { AgentThreadPrompt } from '../../src/shared/threadPrompts'
import { MessageScrubber } from '../../src/renderer/src/agents/MessageScrubber'
import { joinedMarks, scrubberMarks, storedMarks } from '../../src/renderer/src/agents/messageScrubberMarks'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { expectWithinBudget } from '../fixtures/perfBudget'

afterEach(cleanup)

/**
 * What a streamed word costs the message scrubber on a very long thread (ADR-0109): 5,000 ticks from the thread's store
 * above a window of ten turns, with the newest reply growing a word at a time, as it does while the thread works. Each
 * word builds the window's ticks again and joins them to the store's, and the scrubber draws again. It always checks no
 * tick is written to for a word, since only the newest card's reply changed; the stopwatch is `SOTTO_PERF_ASSERT`'s.
 */
const STORED = 5_000
const WORDS = 40
const at = (index: number): string => new Date(Date.UTC(2026, 9, 24, 9, 0, index)).toISOString()
const prompts: AgentThreadPrompt[] = Array.from({ length: STORED }, (_, index) => ({ id: `s${index}`, createdAt: at(index), text: `Stored question ${index}: what about part ${index}?`,
  reply: { id: `sr${index}`, text: `Stored answer ${index}: part ${index} is done.` } }))
const settled: AgentMessage[] = Array.from({ length: 10 }, (_, turn) => [
  { id: `u${turn}`, role: 'user' as const, text: `Question ${turn}?`, createdAt: at(STORED + turn * 2) },
  { id: `r${turn}`, role: 'assistant' as const, text: `Answer ${turn}.`, createdAt: at(STORED + turn * 2 + 1) },
]).flat()
/** The window as the agent state hands it over after a word: every message the word left alone is the one drawn before. */
const window = (words: number): AgentMessage[] => [...settled.slice(0, -1), { ...settled.at(-1)!, text: Array.from({ length: words }, (_, word) => `word${word}`).join(' ') }]

describe('the message scrubber on a very long thread', () => {
  it('draws a streamed word without writing to any tick, within its budget', () => {
    const scroller = document.createElement('div')
    Object.defineProperty(scroller, 'clientHeight', { value: 800 })
    Object.defineProperty(scroller, 'scrollHeight', { value: 80_000 })
    scroller.style.paddingLeft = '120px'
    document.body.append(scroller)
    const stored = storedMarks(prompts)
    const durations: number[] = []
    const draw = (words: number) => <Profiler id="scrubber" onRender={(_, phase, duration) => { if (phase === 'update') durations.push(duration) }}>
      <MessageScrubber marks={joinedMarks(stored, scrubberMarks(window(words)))} scroller={{ current: scroller }} content={{ current: null }} moreAbove who="Claude" running requests={[]} onJump={() => undefined} />
    </Profiler>
    const view = render(draw(1))
    const nav = document.querySelector('.message-scrubber')!
    expect(nav.querySelectorAll('button')).toHaveLength(STORED + 10)
    const writes: MutationRecord[] = []
    const observer = new MutationObserver(records => writes.push(...records))
    observer.observe(nav, { subtree: true, attributes: true, childList: true })
    for (let words = 2; words <= WORDS; words += 1) act(() => { view.rerender(draw(words)) })
    writes.push(...observer.takeRecords())
    observer.disconnect()
    scroller.remove()
    expect(writes).toEqual([])
    if (PERF_BENCH) console.log(`A streamed word with ${STORED} stored ticks: median ${round(median(durations))} ms over ${durations.length} draws`)
    expectWithinBudget(median(durations), 10, `Drawing a streamed word with ${STORED} ticks`)
  })
})
