import React from 'react'
import { act, cleanup, render, renderHook, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { E2E_THREADS_NOW as NOW } from '../../../src/shared/e2e'
import type { ThreadWordMatch } from '../../../src/shared/threadWords'
import { describeThreads, groupByStatus, organizeWorkspace } from '../../../src/renderer/src/agents/threadFacts'
import { FOLDER_TOGGLES_KEY, ThreadSidebar } from '../../../src/renderer/src/agents/ThreadSidebar'
import { THREAD_WORDS_WAIT_MS, useThreadWords } from '../../../src/renderer/src/agents/useThreadWords'
import { useOptionalApp, type AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { threadsStateFixture } from '../../fixtures/agentState'

/**
 * Search threads also finds a thread by what was said in it (Zach's picks of November 19, 2026): such a row lists after
 * the rows found by their own words, in the same group, and quotes the match under its name.
 */
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))
beforeEach(() => {
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'threads', platform: 'win32', settings: DEFAULT_SETTINGS, actions: { navigate: vi.fn() },
    update: { currentVersion: '0.1.43', phase: { phase: 'up-to-date' }, checkedAt: null, owlFeatures: {} } } as unknown as AppContextValue)
  sessionStorage.removeItem(FOLDER_TOGGLES_KEY)
})
afterEach(() => { cleanup(); vi.useRealTimers(); sessionStorage.removeItem(FOLDER_TOGGLES_KEY); delete (window as { sotto?: unknown }).sotto })

const said = (threadId: string, quote: string, more = 0, role: ThreadWordMatch['role'] = 'assistant'): ThreadWordMatch => ({ threadId, messageId: 'm', role, quote, more })
const words = (...matches: ThreadWordMatch[]): ReadonlyMap<string, ThreadWordMatch> => new Map(matches.map(match => [match.threadId, match]))

describe('a search that also reads what was said', () => {
  it('lists a thread found only by its words after the title matches of its group, and counts it as a match', () => {
    const state = threadsStateFixture()
    const found = words(said('weekly-note', 'The footer of the weekly note links the roadmap.'))
    const organization = organizeWorkspace(state, describeThreads(state, NOW), 'footer', null, false, NOW, false, undefined, found)
    expect(organization.wordOnly).toEqual(new Set(['weekly-note']))
    expect(organization.matching).toBe(2)
    const { working } = groupByStatus(organization.open, undefined, organization.wordOnly)
    expect(working.map(row => row.thread.id)).toEqual(['footer-links', 'weekly-note'])
    // A thread found by its title as well as its words is a title match, and nothing is word-only without a search.
    expect(organizeWorkspace(state, describeThreads(state, NOW), 'footer', null, false, NOW, false, undefined, words(said('footer-links', 'footer'))).wordOnly).toBeUndefined()
    expect(organizeWorkspace(state, describeThreads(state, NOW), '', null, false, NOW, false, undefined, found).wordOnly).toBeUndefined()
  })

  it('quotes the match under the row it found by its words, says whose words and how many more, and leaves a title match as it was', () => {
    const state = threadsStateFixture()
    const found = words(said('weekly-note', '…so the Footer of the weekly note links the roadmap.', 2), said('notes-cleanup', 'Move the footer notes.', 0, 'user'))
    const organization = organizeWorkspace(state, describeThreads(state, NOW), 'footer', null, false, NOW, false, undefined, found)
    render(<ThreadSidebar state={state} organization={organization} threadWords={{ query: 'footer', matches: found }}
      command={vi.fn(async () => state)} query="footer" onQuery={vi.fn()} onOpen={vi.fn()} onNewThread={vi.fn()} shortcutsLive
      currentThreadId={null} openThreadIds={[]} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />)
    const row = within(document.body).getByRole('button', { name: 'Weekly note' })
    const quote = row.querySelector('.thread-nav__quote')!
    expect(quote.textContent).toBe('Grok: …so the Footer of the weekly note links the roadmap.2 more in this thread')
    expect(quote.querySelector('mark')!.textContent).toBe('Footer')
    // The quote is the first thing the row's description says.
    expect(row.getAttribute('aria-describedby')!.split(' ')[0]).toBe(quote.id)
    expect(row.closest('li')!.dataset.quoted).toBe('true')
    const own = within(document.body).getByRole('button', { name: 'Notes cleanup' }).querySelector('.thread-nav__quote')!
    expect(own.textContent).toBe('You: Move the footer notes.')
    expect(within(document.body).getByRole('button', { name: 'Footer links' }).querySelector('.thread-nav__quote')).toBeNull()
  })
})

describe('asking every computer what was said', () => {
  function bridge(answer: (query: string) => readonly ThreadWordMatch[]) {
    const threadWords = vi.fn(async ({ query }: { query: string }) => ({ found: [...answer(query)] }))
    ;(window as { sotto?: unknown }).sotto = { agents: { threadWords } }
    return threadWords
  }

  it('asks once typing pauses, keeps the matches a longer search still shows, and asks nothing with no search', async () => {
    vi.useFakeTimers()
    const ask = bridge(query => query === 'purge' ? [said('a', 'the purge timer'), said('b', 'purge the cache')] : [said('a', 'the purge timer')])
    const { result, rerender } = renderHook(({ query }) => useThreadWords(query), { initialProps: { query: '' } })
    expect(result.current).toBeUndefined()
    rerender({ query: 'pur' })
    rerender({ query: ' purge ' })
    await act(async () => { await vi.advanceTimersByTimeAsync(THREAD_WORDS_WAIT_MS - 1) })
    expect(ask).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(ask).toHaveBeenCalledExactlyOnceWith({ query: 'purge' })
    expect([...result.current!.matches.keys()]).toEqual(['a', 'b'])
    // While the longer search is on its way, only the quote that still holds it stays.
    rerender({ query: 'purge ti' })
    expect(result.current!.query).toBe('purge ti')
    expect([...result.current!.matches.keys()]).toEqual(['a'])
    // A different search drops the last answer at once.
    rerender({ query: 'owl' })
    expect(result.current).toBeUndefined()
    rerender({ query: '' })
    await act(async () => { await vi.advanceTimersByTimeAsync(THREAD_WORDS_WAIT_MS * 2) })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(result.current).toBeUndefined()
  })
})
