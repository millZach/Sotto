import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentMessage, AgentThread } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import type { AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { TRANSCRIPT_PAGE } from '../../../src/renderer/src/agents/ThreadTranscript'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { MessageScrubber } from '../../../src/renderer/src/agents/MessageScrubber'
import { scrubberMarks, tickPlaces } from '../../../src/renderer/src/agents/messageScrubberMarks'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

/**
 * The message scrubber (ADR-0109; Owl only): a tick for each message the user sent at the transcript's left edge, a
 * card on hover, and a press that lands on the message even when the window has not drawn it yet. jsdom lays nothing
 * out, so the transcript's size and margin are given here: a 600-pixel view, a 120-pixel margin, and content as tall as
 * the test says.
 */
const VIEW = 600
const MARGIN = 120
let contentHeight = 5_000

const at = (minutes: number): string => new Date(E2E_THREADS_NOW - minutes * 60_000).toISOString()
function conversation(turns: number): AgentMessage[] {
  return Array.from({ length: turns }, (_, turn) => [
    { id: `u${turn}`, role: 'user' as const, text: `Question ${turn}: what about part ${turn}?`, createdAt: at(2 * (turns - turn)) },
    { id: `r${turn}`, role: 'assistant' as const, text: `Answer ${turn}: part ${turn} is done.`, createdAt: at(2 * (turns - turn) - 1) },
  ]).flat()
}

function mount(messages: AgentMessage[], options: { readonly owl?: boolean } = {}) {
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'threads', platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    update: { owlFeatures: { 'message-scrubber': options.owl !== false } },
    actions: { navigate: vi.fn(), minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() } } as unknown as AppContextValue)
  const state = threadsStateFixture()
  const thread: AgentThread = { id: 'long', projectId: state.host.threads[0]!.projectId, title: 'Host pill flicker', modelId: state.host.threads[0]!.modelId, providerId: state.host.threads[0]!.providerId,
    status: 'idle', requests: [], messages, activities: [], updatedAt: at(0) }
  state.host.threads = [thread, ...state.host.threads]
  state.activeThreadId = thread.id
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView now={E2E_THREADS_NOW} />)
  return live
}

const scrubber = () => screen.queryByRole('navigation', { name: 'Messages you sent' })
const ticks = () => within(scrubber()!).getAllByRole('button')
const transcript = () => screen.getByRole('log', { name: 'Thread transcript' })
const article = (id: string) => document.querySelector<HTMLElement>(`.thread-message[data-message-id="${id}"]`)
const card = () => document.querySelector<HTMLElement>('.message-scrubber__card')

beforeEach(() => {
  contentHeight = 5_000
  const scroller = (element: Element): boolean => element.classList.contains('thread-workspace__transcript')
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return scroller(this) ? VIEW : 0 })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return scroller(this) ? 1_000 : 0 })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return scroller(this) ? contentHeight : 0 })
  const real = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = real(element, pseudo)
    if (!scroller(element)) return style
    return new Proxy(style, { get: (target, key) => key === 'paddingLeft' || key === 'paddingRight' ? `${MARGIN}px` : (value => typeof value === 'function' ? value.bind(target) : value)(Reflect.get(target, key)) })
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(useAgents).mockReset(); vi.mocked(useOptionalApp).mockReset() })

describe('the message scrubber', () => {
  it('puts one tick for each message sent in an even column centred on the transcript, beside the column’s edge', () => {
    mount(conversation(5))
    expect(ticks()).toHaveLength(5)
    expect(ticks().map(tick => tick.style.top)).toEqual(tickPlaces(5, VIEW).places.map(place => `${place}px`))
    // The lane is the margin beside the column, at its widest 44 pixels.
    expect(scrubber()!.style.getPropertyValue('--scrubber-left')).toBe(`${MARGIN - 44}px`)
    expect(scrubber()!.style.getPropertyValue('--scrubber-lane')).toBe('44px')
    expect(ticks()[0]).toHaveAccessibleName(/^Go to your message at .+: Question 0: what about part 0\?$/u)
  })

  it('shows only on a long conversation of three or more sent messages, and not on stable', () => {
    contentHeight = 2 * VIEW - 1
    mount(conversation(5))
    expect(scrubber()).toBeNull()
    cleanup()
    contentHeight = 2 * VIEW
    mount(conversation(5))
    expect(scrubber()).not.toBeNull()
    cleanup()
    mount(conversation(2))
    expect(scrubber()).toBeNull()
    cleanup()
    mount(conversation(5), { owl: false })
    expect(scrubber()).toBeNull()
  })

  it('previews a tick on hover with the message and the start of the reply, and swells the ticks around it', () => {
    mount(conversation(5))
    const places = tickPlaces(5, VIEW).places
    fireEvent.pointerMove(scrubber()!, { clientY: places[2], pointerType: 'mouse' })
    expect(ticks()[2]).toHaveAttribute('data-hot')
    expect(card()).toHaveTextContent('Message 3 of 5')
    expect(card()).toHaveTextContent('Question 2: what about part 2?')
    expect(card()).toHaveTextContent('Claude replied')
    expect(card()).toHaveTextContent('Answer 2: part 2 is done.')
    expect(card()).toHaveAttribute('aria-hidden', 'true')
    expect(Number(ticks()[2]!.style.getPropertyValue('--rise'))).toBe(1)
    const neighbour = Number(ticks()[1]!.style.getPropertyValue('--rise'))
    const further = Number(ticks()[0]!.style.getPropertyValue('--rise'))
    expect(neighbour).toBeLessThan(1)
    expect(further).toBeLessThan(neighbour)
  })

  it('lands on a message the window has not drawn yet, widening it first', () => {
    const turns = TRANSCRIPT_PAGE // twice the page of messages: the first half is not drawn
    mount(conversation(turns))
    expect(article('u0')).toBeNull()
    expect(screen.getByRole('button', { name: `Show earlier messages (${TRANSCRIPT_PAGE})` })).toBeInTheDocument()
    fireEvent.click(ticks()[0]!, { detail: 1 })
    expect(article('u0')).not.toBeNull()
    expect(article('u0')).toHaveAttribute('data-sought')
    expect(screen.queryByRole('button', { name: /^Show earlier messages/u })).toBeNull()
    expect(card()).toBeNull()
  })

  it('works from the keyboard: arrows move between ticks with their cards, Enter goes there with focus, Escape closes', async () => {
    mount(conversation(TRANSCRIPT_PAGE))
    const last = ticks().at(-1)!
    expect(ticks().filter(tick => tick.tabIndex === 0)).toHaveLength(1)
    act(() => last.focus())
    expect(card()).toHaveTextContent(`Message ${TRANSCRIPT_PAGE} of ${TRANSCRIPT_PAGE}`)
    expect(card()).toHaveTextContent('Enter goes there.')
    fireEvent.keyDown(last, { key: 'Home' })
    expect(ticks()[0]).toHaveFocus()
    expect(card()).toHaveTextContent(`Message 1 of ${TRANSCRIPT_PAGE}`)
    fireEvent.keyDown(ticks()[0]!, { key: 'ArrowDown' })
    expect(ticks()[1]).toHaveFocus()
    fireEvent.keyDown(ticks()[1]!, { key: 'Escape' })
    expect(card()).toBeNull()
    expect(ticks()[1]).toHaveFocus()
    fireEvent.keyDown(ticks()[1]!, { key: 'Escape' })
    expect(transcript()).toHaveFocus()
    act(() => ticks()[1]!.focus())
    fireEvent.keyDown(ticks()[1]!, { key: 'Enter' })
    expect(article('u1')).toHaveFocus()
    expect(article('u1')).toHaveAttribute('data-sought')
  })
})

describe('in Watcher’s conversation', () => {
  it('names Watcher as the one who replied', () => {
    const messages = conversation(4)
    const scroller = { current: document.createElement('div') }
    scroller.current.className = 'thread-workspace__transcript'
    document.body.append(scroller.current)
    render(<MessageScrubber marks={scrubberMarks(messages)} scroller={scroller} content={{ current: null }} moreAbove={false} who="Watcher" running={false} requests={[]} onJump={vi.fn()} />)
    fireEvent.pointerMove(scrubber()!, { clientY: tickPlaces(4, VIEW).places[0], pointerType: 'mouse' })
    expect(card()).toHaveTextContent('Watcher replied')
    scroller.current.remove()
  })
})
