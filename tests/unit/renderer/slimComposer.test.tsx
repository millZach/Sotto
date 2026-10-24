import { setPromptText } from './helpers/promptEditor'
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadPane } from '../../../src/renderer/src/agents/ThreadPane'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { describeThreads } from '../../../src/renderer/src/agents/threadFacts'
import { composerSlim, READING_BACK_PX, readsBack, typesIntoComposer, type SlimFacts } from '../../../src/renderer/src/agents/slimComposer'
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
