import { setPromptText, promptText } from './helpers/promptEditor'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { replyQuoteStore } from '../../../src/renderer/src/agents/replyQuotes'
import { reviewCommentStore } from '../../../src/renderer/src/agents/reviewComments'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

const owl = vi.hoisted(() => ({ quote: true }))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>()
  return { ...actual, useOwlFeature: (id: string) => id === 'reply-quote' ? owl.quote : actual.useOwlFeature(id as never) }
})

const THREAD = 'grok-previews'
const REPLY = 'grok-previews-2'

function mount(running = false) {
  const state: AgentState = threadsStateFixture()
  state.activeThreadId = THREAD
  if (running) state.host = { ...state.host, threads: state.host.threads.map(thread => thread.id === THREAD ? { ...thread, status: 'running' as const } : thread) }
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView now={E2E_THREADS_NOW} />)
  return { live, prompt: () => screen.getByRole('textbox', { name: 'Prompt' }) as HTMLElement }
}

const requests = <T extends AgentCommand['type']>(live: ReturnType<typeof liveAgentState>, type: T): Extract<AgentCommand, { type: T }>[] =>
  live.command.mock.calls.map(([request]) => request).filter((request): request is Extract<AgentCommand, { type: T }> => request.type === type)

const chips = () => screen.queryByRole('list', { name: 'Quotes from replies' })

function clear(): void {
  for (const threadId of [THREAD, 'other-thread']) {
    replyQuoteStore.sent(threadId, replyQuoteStore.list(threadId).map(quote => quote.id))
    reviewCommentStore.sent(threadId, reviewCommentStore.list(threadId).map(comment => comment.id))
  }
  document.getSelection()?.removeAllRanges()
}

/** Selects words in the reply's own text, as a drag would, and lets the transcript read the selection. */
function selectInReply(from: number, to: number): void {
  const reply = document.querySelector(`.thread-message[data-message-id="${REPLY}"] .rich-message p`)!
  const text = reply.firstChild!
  act(() => {
    document.getSelection()!.setBaseAndExtent(text, from, text, to)
    fireEvent.keyUp(document.body, { key: 'Shift' })
  })
}

beforeEach(() => { owl.quote = true; vi.mocked(useAgents).mockReset(); clear() })
afterEach(() => { cleanup(); clear() })

describe('reply quotes on the composer', () => {
  it('shows each quote as a chip of its first words, and removes one from its chip', () => {
    mount()
    expect(chips()).toBeNull()
    act(() => {
      replyQuoteStore.add(THREAD, { messageId: REPLY, text: 'The preview plays a two-second sample through the selected voice' })
      replyQuoteStore.add(THREAD, { messageId: REPLY, text: 'the key never touches settings.json' })
      replyQuoteStore.add('other-thread', { messageId: 'x', text: 'Not this thread' })
    })
    const items = within(chips()!).getAllByRole('listitem')
    expect(items.map(item => item.querySelector('.review-chip__label')!.textContent)).toEqual(['“The preview plays a two-second sample…”', '“the key never touches settings.json”'])
    expect(items[0]).toHaveAttribute('title', 'The preview plays a two-second sample through the selected voice')
    const first = within(items[0]!).getByRole('button', { name: 'Remove quote' })
    first.focus()
    fireEvent.click(first)
    expect(replyQuoteStore.list(THREAD).map(quote => quote.text)).toEqual(['the key never touches settings.json'])
    expect(within(chips()!).getByRole('button', { name: 'Remove quote' })).toHaveFocus()
  })

  it('sends the quotes before the message and the review comments after it, then takes the chips off', () => {
    const { live, prompt } = mount()
    act(() => {
      replyQuoteStore.add(THREAD, { messageId: REPLY, text: 'the key never touches settings.json' })
      reviewCommentStore.add(THREAD, { path: 'a.ts', lines: [{ kind: 'add', text: 'x', oldLine: null, newLine: 1 }], text: 'Why?' })
    })
    setPromptText(prompt(), 'Where does it go instead?')
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    const text = 'From your earlier reply:\n> the key never touches settings.json\n\nWhere does it go instead?\n\nComment on `a.ts L1`:\n\nWhy?\n\n```diff\n+x\n```'
    expect(requests(live, 'manual-send')).toEqual([{ type: 'manual-send', threadId: THREAD, draftId: expect.any(String), text }])
    expect(replyQuoteStore.list(THREAD)).toEqual([])
    expect(reviewCommentStore.list(THREAD)).toEqual([])
    expect(chips()).toBeNull()
    expect(promptText(prompt())).toBe('')
    act(() => undefined)
  })

  it('carries the quotes in a queued follow-up the same way', () => {
    const { live, prompt } = mount(true)
    act(() => { replyQuoteStore.add(THREAD, { messageId: REPLY, text: 'two-second sample' }) })
    setPromptText(prompt(), 'Make it three')
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(requests(live, 'queue-followup').map(item => item.text)).toEqual(['From your earlier reply:\n> two-second sample\n\nMake it three'])
    expect(replyQuoteStore.list(THREAD)).toEqual([])
    act(() => undefined)
  })

  it('can send quotes with no message of their own', () => {
    const { live } = mount()
    const send = () => screen.getByRole('button', { name: 'Send prompt' })
    expect(send()).toBeDisabled()
    act(() => { replyQuoteStore.add(THREAD, { messageId: REPLY, text: 'two-second sample' }) })
    expect(send()).toBeEnabled()
    fireEvent.click(send())
    expect(requests(live, 'manual-send').map(item => item.text)).toEqual(['From your earlier reply:\n> two-second sample'])
    act(() => undefined)
  })

  it('brings a refused prompt back with its quotes written out, so nothing is lost', async () => {
    const { live, prompt } = mount()
    act(() => { replyQuoteStore.add(THREAD, { messageId: REPLY, text: 'two-second sample' }) })
    setPromptText(prompt(), 'Longer')
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(chips()).toBeNull()
    await act(async () => { live.deliver(THREAD, 'failed') })
    expect(promptText(prompt())).toBe('From your earlier reply:\n> two-second sample\n\nLonger')
  })

  it('shows and sends nothing of a quote where the feature is off', () => {
    owl.quote = false
    const { live, prompt } = mount()
    act(() => { replyQuoteStore.add(THREAD, { messageId: REPLY, text: 'two-second sample' }) })
    expect(chips()).toBeNull()
    selectInReply(0, 4)
    expect(screen.queryByRole('button', { name: 'Add to prompt' })).toBeNull()
    setPromptText(prompt(), 'Plain')
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(requests(live, 'manual-send').map(item => item.text)).toEqual(['Plain'])
    act(() => undefined)
  })
})

describe('Add to prompt over a selection in a reply', () => {
  it('appears over words selected in a reply, puts them on the composer and focuses it', () => {
    const { prompt } = mount()
    expect(screen.queryByRole('button', { name: 'Add to prompt' })).toBeNull()
    selectInReply(0, 11)
    const button = screen.getByRole('button', { name: 'Add to prompt' })
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+A')
    fireEvent.mouseDown(button)
    fireEvent.click(button)
    expect(replyQuoteStore.list(THREAD).map(quote => [quote.messageId, quote.text])).toEqual([[REPLY, 'Done. The p']])
    expect(screen.queryByRole('button', { name: 'Add to prompt' })).toBeNull()
    expect(document.getSelection()!.isCollapsed).toBe(true)
    expect(prompt()).toHaveFocus()
    expect(within(chips()!).getAllByRole('listitem')).toHaveLength(1)
  })

  it('answers Ctrl+Shift+A, and Escape puts it away', () => {
    mount()
    selectInReply(6, 17)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Add to prompt' })).toBeNull()
    expect(document.getSelection()!.isCollapsed).toBe(true)
    expect(replyQuoteStore.list(THREAD)).toEqual([])
    selectInReply(6, 17)
    fireEvent.keyDown(document.body, { key: 'A', ctrlKey: true, shiftKey: true })
    expect(replyQuoteStore.list(THREAD).map(quote => quote.text)).toEqual(['The preview'])
  })

  it('offers nothing for the user’s own words', () => {
    mount()
    const mine = document.querySelector('.thread-message[data-role="user"] .rich-message p')!.firstChild!
    act(() => {
      document.getSelection()!.setBaseAndExtent(mine, 0, mine, 8)
      fireEvent.keyUp(document.body, { key: 'Shift' })
    })
    expect(screen.queryByRole('button', { name: 'Add to prompt' })).toBeNull()
  })
})
