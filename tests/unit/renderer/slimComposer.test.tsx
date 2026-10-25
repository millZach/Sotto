import { setPromptText } from './helpers/promptEditor'
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadPane } from '../../../src/renderer/src/agents/ThreadPane'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { describeThreads } from '../../../src/renderer/src/agents/threadFacts'
import { composerSlim, READING_BACK_PX, readsBack, SLIM_MOTION_ID, SLIM_MOVING_ATTRIBUTE, typesIntoComposer, type SlimFacts } from '../../../src/renderer/src/agents/slimComposer'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

const owl = vi.hoisted(() => ({ shrink: true }))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>()
  return { ...actual, useOwlFeature: (id: string) => id === 'composer-shrink' ? owl.shrink : actual.useOwlFeature(id as never) }
})
beforeEach(() => { owl.shrink = true })
afterEach(cleanup)

describe('when the composer is slim (ADR-0125)', () => {
  const reading: SlimFacts = { enabled: true, readingBack: true, focused: false, draft: false, questionWaits: false }

  it('slims only while the user reads back with the composer empty, unfocused and floating', () => {
    expect(composerSlim(reading)).toBe(true)
    expect(composerSlim({ ...reading, readingBack: false })).toBe(false)
    expect(composerSlim({ ...reading, focused: true })).toBe(false)
    // A draft keeps it full (the user's pick).
    expect(composerSlim({ ...reading, draft: true })).toBe(false)
    // A waiting question stacks the composer instead of floating it.
    expect(composerSlim({ ...reading, questionWaits: true })).toBe(false)
  })

  it('never slims with the Owl feature off', () => {
    for (const readingBack of [true, false]) for (const focused of [true, false]) for (const draft of [true, false]) {
      expect(composerSlim({ enabled: false, readingBack, focused, draft, questionWaits: false })).toBe(false)
    }
  })

  it('counts as reading back only past the line above the end', () => {
    const at = (fromEnd: number) => readsBack({ scrollHeight: 2_000, clientHeight: 600, scrollTop: 1_400 - fromEnd })
    expect(at(0)).toBe(false)
    expect(at(READING_BACK_PX)).toBe(false)
    expect(at(READING_BACK_PX + 1)).toBe(true)
  })

  it('takes a printable key typed on the transcript’s words as the start of a message, and nothing else', () => {
    const log = document.createElement('div')
    log.innerHTML = '<p>Words</p><button type="button">Copy</button><a href="#x">Link</a><input aria-label="Field" /><div role="menuitem">Item</div>'
    document.body.append(log)
    const words = log.querySelector('p')!
    const key = (key: string, target: Element, more: Partial<KeyboardEvent> = {}) => typesIntoComposer({ key, target, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, defaultPrevented: false, ...more })
    expect(key('h', log)).toBe(true)
    expect(key('H', words)).toBe(true)
    expect(key('é', words)).toBe(true)
    expect(key('?', words)).toBe(true)
    // Space scrolls, and keys that name themselves are not typing.
    for (const name of [' ', 'Enter', 'ArrowDown', 'Tab', 'Escape', 'Dead']) expect(key(name, words)).toBe(false)
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'isComposing', 'defaultPrevented'] as const) expect(key('h', words, { [modifier]: true })).toBe(false)
    for (const control of ['button', 'a', 'input', '[role="menuitem"]']) expect(key('h', log.querySelector(control)!)).toBe(false)
    log.remove()
  })
})

describe('the slim composer in a thread pane', () => {
  function mount() {
    const state = threadsStateFixture()
    state.activeThreadId = 'grok-previews'
    const live = liveAgentState(state)
    vi.mocked(useAgents).mockImplementation(live.useLive)
    const row = describeThreads(state, E2E_THREADS_NOW).find(item => item.thread.id === state.activeThreadId)!
    const store = new ThreadDraftStore(live.command)
    render(<ThreadPane row={row} state={state} command={live.command} store={store} focused promptId="prompt" error={null} />)
    const log = screen.getByRole('log', { name: 'Thread transcript' })
    const compose = document.querySelector<HTMLElement>('.thread-workspace__compose')!
    /** Reads the transcript `fromEnd` pixels above its end, as a scroll does. */
    const readBack = (fromEnd: number): void => {
      Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 3_000 })
      Object.defineProperty(log, 'clientHeight', { configurable: true, value: 600 })
      act(() => { log.scrollTop = 2_400 - fromEnd; fireEvent.scroll(log) })
    }
    return { store, log, compose, readBack, textbox: () => screen.getByRole('textbox', { name: 'Prompt' }) }
  }

  it('slims while reading back, and comes back full at the end, on focus and with a draft', () => {
    const view = mount()
    expect(view.compose).not.toHaveAttribute('data-slim')
    view.readBack(400)
    expect(view.compose).toHaveAttribute('data-slim', 'true')
    view.readBack(60)
    expect(view.compose).not.toHaveAttribute('data-slim')

    view.readBack(400)
    act(() => { view.textbox().focus() })
    expect(view.compose).not.toHaveAttribute('data-slim')
    act(() => { view.log.focus() })
    expect(view.compose).toHaveAttribute('data-slim', 'true')

    setPromptText(view.textbox(), 'check the light theme too')
    act(() => { view.log.focus() })
    expect(view.compose).not.toHaveAttribute('data-slim')
    setPromptText(view.textbox(), '')
    act(() => { view.log.focus() })
    expect(view.compose).toHaveAttribute('data-slim', 'true')
    // The textbox keeps its name while slim.
    expect(view.textbox()).toBeInTheDocument()
  })

  it('learns what shows of the slim composer while the effort border’s own transition runs', () => {
    // The pane measures through a ResizeObserver; a still one is enough, since slimming measures by itself.
    vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} unobserve(): void {} })
    // The card's 2.4-second highest-effort border transition, still running: only the slim motion holds a measure back.
    const effort = { id: '', playState: 'running' } as unknown as Animation
    const getAnimations = vi.fn(() => [effort])
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', { configurable: true, value: getAnimations })
    try {
      const view = mount()
      const pane = view.compose.parentElement!
      pane.style.removeProperty('--thread-compose-shown')
      view.readBack(400)
      expect(view.compose).toHaveAttribute('data-slim', 'true')
      expect(pane.style.getPropertyValue('--thread-compose-shown')).not.toBe('')
    } finally {
      delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations
      vi.unstubAllGlobals()
    }
  })

  it('keeps the full room while the card moves, and moves the card only by what steps away under it', () => {
    // The card stands at the composer's foot. Slim it is one line, and the row under it (23 pixels) has stepped away.
    const box = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('thread-prompt')) return box(0, 0)
      return this.closest('[data-slim]') === null ? box(600, 135) : box(758 - 41, 41)
    })
    const motions: Array<{ frames: Keyframe[]; options: KeyframeAnimationOptions; finish: () => void; cancel: ReturnType<typeof vi.fn> }> = []
    const animate = vi.fn(function (frames: Keyframe[], options: KeyframeAnimationOptions) {
      const motion: (typeof motions)[number] = { frames, options, finish: () => undefined, cancel: vi.fn() }
      motions.push(motion)
      return { addEventListener: (_: string, done: () => void) => { motion.finish = done }, removeEventListener: () => undefined, cancel: motion.cancel } as unknown as Animation
    })
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate })
    try {
      const view = mount()
      view.readBack(400)
      expect(view.compose).toHaveAttribute('data-slim', 'true')
      expect(view.compose).toHaveAttribute(SLIM_MOVING_ATTRIBUTE)
      // Its height changes from full to slim; its foot comes down by the row that stepped away, and no further.
      expect(motions[0]!.options.id).toBe(SLIM_MOTION_ID)
      expect(motions[0]!.frames.map(frame => [frame.height, frame.transform])).toEqual([['135px', 'translateY(-23px)'], ['41px', 'none']])
      act(() => { motions[0]!.finish() })
      expect(view.compose).not.toHaveAttribute(SLIM_MOVING_ATTRIBUTE)

      view.readBack(0)
      expect(view.compose).not.toHaveAttribute('data-slim')
      expect(view.compose).toHaveAttribute(SLIM_MOVING_ATTRIBUTE)
      expect(motions[1]!.frames.map(frame => [frame.height, frame.transform])).toEqual([['41px', 'translateY(23px)'], ['135px', 'none']])
      // Read back again before it settles: the move is stopped where it is, and the next keeps the room.
      view.readBack(400)
      expect(motions[1]!.cancel).toHaveBeenCalled()
      expect(view.compose).toHaveAttribute(SLIM_MOVING_ATTRIBUTE)
      act(() => { motions[2]!.finish() })
      expect(view.compose).not.toHaveAttribute(SLIM_MOVING_ATTRIBUTE)
    } finally {
      delete (HTMLElement.prototype as { animate?: unknown }).animate
      vi.restoreAllMocks()
    }
  })

  it('changes at once with motion reduced, and never holds the room', () => {
    const animate = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate })
    document.documentElement.dataset.reducedMotion = 'on'
    try {
      const view = mount()
      view.readBack(400)
      expect(view.compose).toHaveAttribute('data-slim', 'true')
      expect(view.compose).not.toHaveAttribute(SLIM_MOVING_ATTRIBUTE)
      expect(animate).not.toHaveBeenCalled()
    } finally {
      delete document.documentElement.dataset.reducedMotion
      delete (HTMLElement.prototype as { animate?: unknown }).animate
    }
  })

  it('keeps the reader where they are reading while the composer slims and comes back full (#1452)', () => {
    // Lays each message out one row for each paragraph of the answer, so the answer can be read from its middle.
    const ROW = 100, VIEW = 600
    const rows = (message: Element): number => Math.max(1, (message.textContent ?? '').split('Answer paragraph').length - 1)
    const drawn = (log: Element): Element[] => [...log.querySelectorAll('.thread-message')]
    const height = (element: HTMLElement): number => drawn(element).reduce((sum, message) => sum + rows(message), 0) * ROW
    const tops = new WeakMap<Element, number>()
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return height(this) })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => VIEW)
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) { return tops.get(this) ?? 0 })
    vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) { tops.set(this, Math.max(0, Math.min(value, height(this) - VIEW))) })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const log = this.closest<HTMLElement>('.thread-workspace__transcript')
      const list = log === null ? [] : drawn(log)
      const index = list.indexOf(this)
      const top = index < 0 ? 0 : list.slice(0, index).reduce((sum, message) => sum + rows(message), 0) * ROW - log!.scrollTop
      const tall = index < 0 ? VIEW : rows(this) * ROW
      return { top, bottom: top + tall, left: 0, right: 600, width: 600, height: tall, x: 0, y: top, toJSON: () => ({}) } as DOMRect
    })
    try {
      const state = threadsStateFixture()
      state.activeThreadId = 'grok-previews'
      const at = new Date(E2E_THREADS_NOW - 60_000).toISOString()
      state.host.threads.find(item => item.id === 'grok-previews')!.messages = [
        { id: 'ask', role: 'user', text: 'Review the footer links.', createdAt: at },
        { id: 'answer', role: 'assistant', text: Array.from({ length: 20 }, (_, n) => `Answer paragraph ${n + 1}.`).join('\n\n'), createdAt: at },
      ]
      const live = liveAgentState(state)
      vi.mocked(useAgents).mockImplementation(live.useLive)
      const row = describeThreads(state, E2E_THREADS_NOW).find(item => item.thread.id === state.activeThreadId)!
      render(<ThreadPane row={row} state={state} command={live.command} store={new ThreadDraftStore(live.command)} focused promptId="prompt" error={null} />)
      const log = screen.getByRole('log', { name: 'Thread transcript' })
      const compose = document.querySelector<HTMLElement>('.thread-workspace__compose')!
      const answer = (): number => log.querySelector('[data-message-id="answer"]')!.getBoundingClientRect().top
      // Reading the answer's fourth paragraph, well above the end.
      act(() => { log.scrollTop = 4 * ROW; fireEvent.scroll(log) })
      expect(answer()).toBe(-3 * ROW)
      expect(compose).toHaveAttribute('data-slim', 'true')
      act(() => { screen.getByRole('textbox', { name: 'Prompt' }).focus() })
      expect(compose).not.toHaveAttribute('data-slim')
      expect(answer()).toBe(-3 * ROW)
      act(() => { log.focus() })
      expect(compose).toHaveAttribute('data-slim', 'true')
      expect(answer()).toBe(-3 * ROW)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('hands a key typed in the transcript to the composer', () => {
    const view = mount()
    view.readBack(400)
    act(() => { view.log.focus() })
    fireEvent.keyDown(view.log, { key: 'h' })
    expect(view.textbox()).toHaveFocus()
    expect(view.compose).not.toHaveAttribute('data-slim')
  })

  it('stays full and leaves keys to the transcript with the Owl feature off', () => {
    owl.shrink = false
    const view = mount()
    view.readBack(400)
    expect(view.compose).not.toHaveAttribute('data-slim')
    act(() => { view.log.focus() })
    fireEvent.keyDown(view.log, { key: 'h' })
    expect(view.log).toHaveFocus()
  })
})
