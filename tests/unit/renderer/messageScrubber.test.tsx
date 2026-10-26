import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentMessage, AgentThread } from '../../../src/shared/agents'
import type { AgentThreadPrompt, AgentThreadPromptsRequest } from '../../../src/shared/threadPrompts'
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
// A store answers its prompts a page at a time; a small page lets a test read several.
vi.mock('../../../src/shared/threadPrompts', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/shared/threadPrompts')>(), THREAD_PROMPTS_MOST: 20 }))

/**
 * The message scrubber (ADR-0109; Owl only): a tick for each message the user sent at the transcript's left edge, a
 * card on hover, and a press that lands on the message even when the window has not drawn it yet. jsdom lays nothing
 * out, so the transcript's size and margin are given here: a 600-pixel view, a 120-pixel margin, and content as tall as
 * the test says.
 */
const VIEW = 600
const MARGIN = 120
let contentHeight = 5_000
let margin = MARGIN

const at = (minutes: number): string => new Date(E2E_THREADS_NOW - minutes * 60_000).toISOString()
function conversation(turns: number): AgentMessage[] {
  return Array.from({ length: turns }, (_, turn) => [
    { id: `u${turn}`, role: 'user' as const, text: `Question ${turn}: what about part ${turn}?`, createdAt: at(2 * (turns - turn)) },
    { id: `r${turn}`, role: 'assistant' as const, text: `Answer ${turn}: part ${turn} is done.`, createdAt: at(2 * (turns - turn) - 1) },
  ]).flat()
}

function mount(messages: AgentMessage[], options: { readonly owl?: boolean; readonly thread?: Partial<AgentThread> } = {}) {
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'threads', platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    update: { owlFeatures: { 'message-scrubber': options.owl !== false } },
    actions: { navigate: vi.fn(), minimizeApp: vi.fn(), toggleMaximizeApp: vi.fn(), hideApp: vi.fn(), updateSettings: vi.fn() } } as unknown as AppContextValue)
  const state = threadsStateFixture()
  const thread: AgentThread = { id: 'long', projectId: state.host.threads[0]!.projectId, title: 'Host pill flicker', modelId: state.host.threads[0]!.modelId, providerId: state.host.threads[0]!.providerId,
    status: 'idle', requests: [], messages, activities: [], updatedAt: at(0), ...options.thread }
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
  margin = MARGIN
  const scroller = (element: Element): boolean => element.classList.contains('thread-workspace__transcript')
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return scroller(this) ? VIEW : 0 })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return scroller(this) ? 1_000 : 0 })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return scroller(this) ? contentHeight : 0 })
  const real = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = real(element, pseudo)
    if (!scroller(element)) return style
    return new Proxy(style, { get: (target, key) => key === 'paddingLeft' || key === 'paddingRight' ? `${margin}px` : (value => typeof value === 'function' ? value.bind(target) : value)(Reflect.get(target, key)) })
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

  it('moves the lane with the column when a split narrows the pane and only the transcript’s margin shrinks', () => {
    // jsdom has no ResizeObserver, so this one reports what a browser does: a box it watches that changed size. Opening a
    // split beside a wide pane shrinks the transcript's centring padding and leaves its content box the column's width.
    const watched: { readonly callback: ResizeObserverCallback; readonly element: Element; readonly box: ResizeObserverBoxOptions }[] = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(element: Element, options?: ResizeObserverOptions): void { watched.push({ callback: this.callback, element, box: options?.box ?? 'content-box' }) }
      unobserve(): void {}
      disconnect(): void {}
    })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(step => { step(0); return 0 })
    try {
      mount(conversation(5))
      expect(scrubber()!.style.getPropertyValue('--scrubber-left')).toBe(`${MARGIN - 44}px`)
      margin = 60
      act(() => { for (const { callback, element, box } of watched) if (element === transcript() && box !== 'content-box') callback([], {} as ResizeObserver) })
      expect(scrubber()!.style.getPropertyValue('--scrubber-left')).toBe('16px')
    } finally { vi.unstubAllGlobals() }
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
    // The card describes its tick, so a screen reader hears the reply too.
    expect(card()).toHaveAttribute('role', 'tooltip')
    expect(ticks()[2]).toHaveAccessibleDescription(/Answer 2: part 2 is done\./u)
    expect(Number(ticks()[2]!.style.getPropertyValue('--rise'))).toBe(1)
    const neighbour = Number(ticks()[1]!.style.getPropertyValue('--rise'))
    const further = Number(ticks()[0]!.style.getPropertyValue('--rise'))
    expect(neighbour).toBeLessThan(1)
    expect(further).toBeLessThan(neighbour)
  })

  it('closes a card the pointer opened on Escape, wherever focus is', () => {
    mount(conversation(5))
    fireEvent.pointerMove(scrubber()!, { clientY: tickPlaces(5, VIEW).places[1], pointerType: 'mouse' })
    expect(card()).not.toBeNull()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(card()).toBeNull()
  })

  it('goes to the tick whose card shows when packed ticks overlap, and a press with no pointer goes there too', () => {
    contentHeight = 50_000
    mount(conversation(TRANSCRIPT_PAGE / 2 + 100))
    const places = tickPlaces(ticks().length, VIEW).places
    const shown = 120
    fireEvent.pointerMove(scrubber()!, { clientY: places[shown], pointerType: 'mouse' })
    expect(ticks()[shown]).toHaveAttribute('data-hot')
    // The pointer is over the next button too, whose hit area overlaps; the whole press still goes where the card said.
    // The press does not move focus there, which would swap the card for that button's message.
    const under = ticks()[shown + 1]!
    fireEvent.pointerDown(under, { pointerType: 'mouse' })
    expect(fireEvent.mouseDown(under)).toBe(false)
    expect(ticks()[shown]).toHaveAttribute('data-hot')
    fireEvent.mouseUp(under)
    fireEvent.click(under, { detail: 1 })
    expect(article(`u${shown}`)).toHaveAttribute('data-sought')
    // Assistive technology's press has no pointer, and lands with focus.
    fireEvent.click(ticks()[shown - 5]!, { detail: 0 })
    expect(article(`u${shown - 5}`)).toHaveFocus()
  })

  it('keeps a card on its message when messages are added above, and closes a tapped card on a tap elsewhere', () => {
    const live = mount(conversation(6))
    const places = tickPlaces(6, VIEW).places
    fireEvent.pointerMove(scrubber()!, { clientY: places[3], pointerType: 'mouse' })
    expect(card()).toHaveTextContent('Question 3:')
    // Two earlier turns arrive above, as Show earlier messages loads them: the card stays on Question 3.
    const thread = live.state.host.threads.find(item => item.id === 'long')!
    const earlier: AgentMessage[] = [
      { id: 'e0', role: 'user', text: 'An earlier question?', createdAt: at(40) }, { id: 'e1', role: 'assistant', text: 'An earlier answer.', createdAt: at(39) },
      { id: 'e2', role: 'user', text: 'Another earlier question?', createdAt: at(38) }, { id: 'e3', role: 'assistant', text: 'Another answer.', createdAt: at(37) },
    ]
    act(() => { live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(item => item === thread ? { ...thread, messages: [...earlier, ...thread.messages] } : item) } }) })
    expect(card()).toHaveTextContent('Question 3:')
    expect(card()).toHaveTextContent('Message 6 of 8')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    // A tap shows a card with no pointer to leave it; a tap anywhere else closes it.
    fireEvent.pointerDown(ticks()[1]!, { pointerType: 'touch' })
    fireEvent.click(ticks()[1]!, { detail: 1 })
    expect(card()).toHaveTextContent('Message 2 of 8')
    fireEvent.pointerDown(transcript(), { pointerType: 'touch' })
    expect(card()).toBeNull()
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

describe('with earlier messages only in the thread’s store', () => {
  const TURNS = 60
  const WINDOW = 10
  const all = conversation(TURNS)
  /** What the store answers for the prompts before a message: the user's, each with its turn's reply. */
  const promptsBefore = (id: string): AgentThreadPrompt[] => {
    const end = all.findIndex(message => message.id === id)
    return all.slice(0, end).flatMap((message, index, list) => message.role === 'user'
      ? [{ id: message.id, createdAt: message.createdAt, text: message.text, reply: { id: list[index + 1]!.id, text: list[index + 1]!.text } }] : [])
  }
  /** The newest twenty, as a store answers a page. */
  /** A page of the newest twenty, and the message the next is read before, as the store answers. */
  const pageOf = (list: AgentThreadPrompt[]) => ({ prompts: list.slice(-20), ...(list.length > 20 ? { next: list.at(-20)!.id } : {}) })
  const page = async (request: AgentThreadPromptsRequest) => pageOf(promptsBefore(request.beforeMessageId))
  const read = vi.fn(page)
  beforeEach(() => { read.mockReset(); read.mockImplementation(page); Object.assign(window, { sotto: { agents: { threadPrompts: read } } }) })
  afterEach(() => { Reflect.deleteProperty(window, 'sotto') })
  const windowFrom = (turn: number) => all.slice(turn * 2)
  const republish = (live: ReturnType<typeof mount>, patch: Partial<AgentThread>): void => {
    act(() => { live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(item => item.id === 'long' ? { ...item, ...patch } : item) } }) })
  }

  it('marks every prompt, the store’s above the window’s, and reads the store again only when the window starts beyond the read', async () => {
    const live = mount(windowFrom(TURNS - WINDOW), { thread: { earlierAvailable: true } })
    await vi.waitFor(() => expect(ticks()).toHaveLength(TURNS))
    // Fifty prompts above the window, read a page of twenty at a time back to the first.
    expect(read.mock.calls.map(([request]) => request.beforeMessageId)).toEqual([`u${TURNS - WINDOW}`, 'u30', 'u10'])
    fireEvent.pointerMove(scrubber()!, { clientY: tickPlaces(TURNS, VIEW).places[0], pointerType: 'mouse' })
    expect(card()).toHaveTextContent(`Message 1 of ${TURNS}`)
    expect(card()).toHaveTextContent('Question 0: what about part 0?')
    expect(card()).toHaveTextContent('Answer 0: part 0 is done.')
    expect(ticks()[0]).toHaveAccessibleName(/: Question 0: what about part 0\?$/u)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    // Show earlier messages loads twenty turns the store was read for: the ticks stay, and nothing is read.
    republish(live, { messages: windowFrom(TURNS - WINDOW - 20) })
    expect(ticks()).toHaveLength(TURNS)
    expect(ticks()[0]).toHaveAccessibleName(/Question 0:/u)
    // The pane comes back to the thread: its messages load again, and the ticks it had stand meanwhile.
    republish(live, { messages: [], historyStatus: 'loading' })
    expect(ticks()).toHaveLength(TURNS)
    republish(live, { messages: windowFrom(TURNS - WINDOW), historyStatus: undefined })
    expect(ticks()).toHaveLength(TURNS)
    expect(read).toHaveBeenCalledTimes(3)
    // A new turn slides the window down a turn: the turn it lets go keeps its tick, and nothing is read.
    const next: AgentMessage[] = [{ id: 'u60', role: 'user', text: 'Question 60: and the iPhone?', createdAt: at(0) }, { id: 'r60', role: 'assistant', text: 'Answer 60.', createdAt: at(0) }]
    republish(live, { messages: [...windowFrom(TURNS - WINDOW + 1), ...next] })
    expect(ticks()).toHaveLength(TURNS + 1)
    expect(ticks()[TURNS - WINDOW]).toHaveAccessibleName(/Question 50:/u)
    expect(ticks()[TURNS]).toHaveAccessibleName(/Question 60:/u)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('reads the store again for a window that starts on a message it never held', async () => {
    const live = mount(windowFrom(TURNS - WINDOW), { thread: { earlierAvailable: true } })
    await vi.waitFor(() => expect(ticks()).toHaveLength(TURNS))
    // Another thread's window replaces this one's, as a rewind to newer messages would: its first message is new here.
    republish(live, { messages: all.slice((TURNS - 5) * 2).map(message => ({ ...message, id: `new-${message.id}` })) })
    await vi.waitFor(() => expect(read).toHaveBeenCalledWith({ threadId: 'long', beforeMessageId: `new-u${TURNS - 5}` }))
  })

  it('reads the store again when the thread’s history has lost messages, as a reset that keeps its epoch does', async () => {
    const live = mount(windowFrom(TURNS - WINDOW), { thread: { earlierAvailable: true, summary: { messageCount: TURNS * 2, activityCount: 0 } as AgentThread['summary'] } })
    await vi.waitFor(() => expect(ticks()).toHaveLength(TURNS))
    const calls = read.mock.calls.length
    read.mockImplementation(async (request: AgentThreadPromptsRequest) => pageOf(promptsBefore(request.beforeMessageId).filter(prompt => prompt.id !== 'u49')))
    republish(live, { summary: { messageCount: TURNS * 2 - 2, activityCount: 0 } as AgentThread['summary'] })
    await vi.waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(calls))
    await vi.waitFor(() => expect(ticks()).toHaveLength(TURNS - 1))
  })

  it('loads the window back to a prompt only the store holds, then lands on it with focus', async () => {
    const live = mount(windowFrom(TURNS - WINDOW), { thread: { earlierAvailable: true } })
    await vi.waitFor(() => expect(ticks()).toHaveLength(TURNS))
    act(() => ticks()[0]!.focus())
    fireEvent.keyDown(ticks()[0]!, { key: 'Enter' })
    expect(live.command).toHaveBeenCalledWith({ type: 'load-earlier-messages', threadId: 'long', throughMessageId: 'u0' })
    expect(article('u0')).toBeNull()
    // The window arrives widened back to the prompt.
    republish(live, { messages: all, earlierAvailable: undefined })
    expect(article('u0')).toHaveAttribute('data-sought')
    expect(article('u0')).toHaveFocus()
    expect(ticks()).toHaveLength(TURNS)
  })

  it('leaves the reader where they are when they scroll while a pressed prompt loads', async () => {
    const live = mount(windowFrom(TURNS - WINDOW), { thread: { earlierAvailable: true } })
    await vi.waitFor(() => expect(ticks()).toHaveLength(TURNS))
    fireEvent.click(ticks()[3]!, { detail: 0 })
    expect(live.command).toHaveBeenCalledWith({ type: 'load-earlier-messages', threadId: 'long', throughMessageId: 'u3' })
    fireEvent.wheel(transcript(), { deltaY: -200 })
    republish(live, { messages: all, earlierAvailable: undefined })
    expect(article('u3')).toBeNull()
  })

  it('leaves the reader where they are when they wheel over the scrubber while a pressed prompt loads', async () => {
    const live = mount(windowFrom(TURNS - WINDOW), { thread: { earlierAvailable: true } })
    await vi.waitFor(() => expect(ticks()).toHaveLength(TURNS))
    fireEvent.click(ticks()[3]!, { detail: 0 })
    fireEvent.wheel(scrubber()!, { deltaY: -200 })
    republish(live, { messages: all, earlierAvailable: undefined })
    expect(article('u3')).toBeNull()
  })

  it('marks what the window holds where the host cannot say, and asks again a little later', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      read.mockResolvedValueOnce(null as unknown as { prompts: AgentThreadPrompt[] })
      mount(windowFrom(TURNS - WINDOW), { thread: { earlierAvailable: true } })
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
      expect(ticks()).toHaveLength(WINDOW)
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
      await vi.waitFor(() => expect(ticks()).toHaveLength(TURNS))
    } finally { vi.useRealTimers() }
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
