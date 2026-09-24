import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { reviewCommentStore, type ReviewLine } from '../../../src/renderer/src/agents/reviewComments'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const THREAD = 'grok-previews'
const add = (newLine: number, text: string): ReviewLine => ({ kind: 'add', text, oldLine: null, newLine })
const remove = (oldLine: number, text: string): ReviewLine => ({ kind: 'remove', text, oldLine, newLine: null })

function mount(running = false) {
  const state: AgentState = threadsStateFixture()
  state.assignments = []
  state.activeThreadId = THREAD
  if (running) state.host = { ...state.host, threads: state.host.threads.map(thread => thread.id === THREAD ? { ...thread, status: 'running' as const } : thread) }
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView onOpenAgents={vi.fn()} now={E2E_THREADS_NOW} />)
  return { live, prompt: () => screen.getByRole('textbox', { name: 'Prompt', exact: true }) as HTMLTextAreaElement }
}

const requests = <T extends AgentCommand['type']>(live: ReturnType<typeof liveAgentState>, type: T): Extract<AgentCommand, { type: T }>[] =>
  live.command.mock.calls.map(([request]) => request).filter((request): request is Extract<AgentCommand, { type: T }> => request.type === type)

const chips = () => screen.queryByRole('list', { name: 'Review comments' })

function clearComments(): void {
  for (const threadId of [THREAD, 'other-thread']) reviewCommentStore.sent(threadId, reviewCommentStore.list(threadId).map(comment => comment.id))
}

beforeEach(() => { vi.mocked(useAgents).mockReset(); clearComments() })
afterEach(() => { cleanup(); clearComments() })

describe('review comments on the composer', () => {
  it('shows each comment as a chip named for its lines, and removes one from its chip', () => {
    mount()
    expect(chips()).toBeNull()
    act(() => {
      reviewCommentStore.add(THREAD, { path: 'src/main/voice.ts', lines: [add(12, 'a'), add(15, 'b')], text: 'Say why it returns early.' })
      reviewCommentStore.add(THREAD, { path: 'src/main/keychain.ts', lines: [remove(4, 'c')], text: 'Remove it there too.' })
      reviewCommentStore.add('other-thread', { path: 'src/other.ts', lines: [add(1, 'x')], text: 'Not this thread' })
    })
    const list = chips()!
    expect(within(list).getAllByRole('listitem').map(item => item.querySelector('.review-chip__label')!.textContent)).toEqual(['voice.ts L12 to L15', 'keychain.ts L4 (before)'])
    expect(within(list).getAllByRole('listitem')[0]).toHaveAttribute('title', 'Say why it returns early.')
    const first = within(list).getByRole('button', { name: 'Remove comment on voice.ts L12 to L15' })
    first.focus()
    fireEvent.click(first)
    expect(reviewCommentStore.list(THREAD).map(comment => comment.text)).toEqual(['Remove it there too.'])
    // Focus stays in the row of chips, on the next one.
    expect(within(chips()!).getByRole('button', { name: 'Remove comment on keychain.ts L4 (before)' })).toHaveFocus()
  })

  it('sends the comments in the prompt’s own text after the message, then takes the chips off', () => {
    const { live, prompt } = mount()
    act(() => { reviewCommentStore.add(THREAD, { path: 'src/main/voice.ts', lines: [remove(12, 'old'), add(12, 'new')], text: 'Say why.' }) })
    fireEvent.change(prompt(), { target: { value: 'Tighten this before we merge.' } })
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    const text = 'Tighten this before we merge.\n\nComment on `src/main/voice.ts L12`:\n\nSay why.\n\n```diff\n-old\n+new\n```'
    expect(requests(live, 'manual-send')).toEqual([{ type: 'manual-send', threadId: THREAD, draftId: expect.any(String), text }])
    // The revision saved before the send is the same text, so main can match the delivery to its draft.
    const sent = requests(live, 'manual-send')[0]!
    expect(requests(live, 'save-thread-draft').find(save => save.draftId === sent.draftId)?.text).toBe(text)
    expect(reviewCommentStore.list(THREAD)).toEqual([])
    expect(chips()).toBeNull()
    expect(prompt()).toHaveValue('')
    act(() => undefined)
  })

  it('carries the comments in a queued follow-up the same way', () => {
    const { live, prompt } = mount(true)
    act(() => { reviewCommentStore.add(THREAD, { path: 'a.ts', lines: [add(1, 'x')], text: 'Why?' }) })
    fireEvent.change(prompt(), { target: { value: 'After this turn' } })
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(requests(live, 'queue-followup').map(item => item.text)).toEqual(['After this turn\n\nComment on `a.ts L1`:\n\nWhy?\n\n```diff\n+x\n```'])
    expect(reviewCommentStore.list(THREAD)).toEqual([])
    act(() => undefined)
  })

  it('can send comments with no message of their own', () => {
    const { live, prompt } = mount()
    const send = () => screen.getByRole('button', { name: 'Send prompt' })
    expect(send()).toBeDisabled()
    act(() => { reviewCommentStore.add(THREAD, { path: 'a.ts', lines: [add(1, 'x')], text: 'Why?' }) })
    expect(send()).toBeEnabled()
    fireEvent.click(send())
    expect(requests(live, 'manual-send').map(item => item.text)).toEqual(['Comment on `a.ts L1`:\n\nWhy?\n\n```diff\n+x\n```'])
    expect(prompt()).toHaveValue('')
    act(() => undefined)
  })

  it('brings a refused prompt back with its comments written out, so nothing is lost', async () => {
    const { live, prompt } = mount()
    act(() => { reviewCommentStore.add(THREAD, { path: 'a.ts', lines: [add(1, 'x')], text: 'Why?' }) })
    fireEvent.change(prompt(), { target: { value: 'Look here' } })
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(chips()).toBeNull()
    await act(async () => { live.deliver(THREAD, 'failed') })
    expect(prompt()).toHaveValue('Look here\n\nComment on `a.ts L1`:\n\nWhy?\n\n```diff\n+x\n```')
  })
})
