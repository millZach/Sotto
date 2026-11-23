import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentBackgroundWork } from '../../../src/shared/agentMonitoring'
import type { AgentMessage, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { clearSettledReplies, HELD_WORK_REPLY_SETTLE_MS, MessageList, QUIET_REPLY_SETTLE_MS, ThreadTranscript, type ActivityContext } from '../../../src/renderer/src/agents/ThreadTranscript'
import { ResponseStreamingProvider } from '../../../src/renderer/src/agents/responseStreaming'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { describeThreads } from '../../../src/renderer/src/agents/threadFacts'
import { placeActivities } from '../../../src/renderer/src/agents/threadActivityView'
import { threadsStateFixture } from '../../fixtures/agentState'

const context: ActivityContext = { liveTurn: 'turn-1', running: true, connected: true, provider: 'claude', onDisclosure: () => undefined }
const at = '2026-09-15T10:19:00.000Z'
const user: AgentMessage = { id: 'user-1', role: 'user', text: 'Look around the repo.', createdAt: at }
const reply = (id: string, text: string): AgentMessage => ({ id, role: 'assistant', text, createdAt: at })
const command = (afterMessageId: string): AgentActivity =>
  ({ id: 'claude-tool-1', turnId: 'turn-1', sequence: 1, kind: 'command', status: 'running', title: 'Bash', command: 'git status', afterMessageId })

function mount(messages: AgentMessage[], { running = true, sending = false, notWriting = false, streamText = true, activities = [] as AgentActivity[] } = {}) {
  render(<MessageList messages={messages} provider="claude" running={running} sending={sending} notWriting={notWriting} placement={placeActivities(messages, messages, activities)} context={context} streamText={streamText} />)
  return document.querySelectorAll('.thread-message')
}

afterEach(() => {
  cleanup()
  clearSettledReplies()
  vi.useRealTimers()
})

describe('assistant messages without text', () => {
  it('draws no header for a provider call that holds only tool use so far', () => {
    const articles = mount([user, reply('a-1', 'I will look.'), reply('a-2', ''), reply('a-3', '')])
    expect(articles).toHaveLength(2)
  })
})

describe('replies shown when finished', () => {
  it('holds back the reply being written and draws nothing for it, since the working line says so (November 9, 2026)', () => {
    mount([user, reply('a-1', 'Half a sent')], { streamText: false })
    expect(screen.queryByText('Half a sent')).not.toBeInTheDocument()
    expect(document.querySelector('[data-message-id="a-1"]')).toBeNull()
  })

  it('shows the reply once a tool call follows it, and leaves the running tool call to the working line', () => {
    mount([user, reply('a-1', 'I will look.')], { streamText: false, activities: [command('a-1')] })
    expect(screen.getByText('I will look.')).toBeInTheDocument()
    // The running turn's steps fold under the working line, which the transcript draws after the messages.
    expect(screen.queryByText('git status')).not.toBeInTheDocument()
  })

  it('shows the reply once a later provider call starts, even before it has text', () => {
    mount([user, reply('a-1', 'I will look.'), reply('a-2', 'Found i')], { streamText: false })
    expect(screen.getByText('I will look.')).toBeInTheDocument()
    expect(screen.queryByText('Found i')).not.toBeInTheDocument()
  })

  it('keeps the previous reply whole while the next prompt is sending', () => {
    // The thread runs from the press, but the new prompt is drawn below the list until the history carries it.
    mount([user, reply('a-1', 'Yes, you are on it.')], { sending: true, streamText: false })
    expect(screen.getByText('Yes, you are on it.')).toBeInTheDocument()
  })

  it('shows the whole reply when the turn ends', () => {
    mount([user, reply('a-1', 'All done.')], { running: false, streamText: false })
    expect(screen.getByText('All done.')).toBeInTheDocument()
  })
})

describe('a reply the provider is not writing now', () => {
  it('draws its reply without the writing caret while a request waits, and with it again once answered', () => {
    mount([user, reply('a-1', 'I want to run the benchmark.')])
    expect(document.querySelector('[data-message-id="a-1"] .rich-message[data-streaming]')).not.toBeNull()
    cleanup()
    mount([user, reply('a-1', 'I want to run the benchmark.')], { notWriting: true })
    expect(screen.getByText('I want to run the benchmark.')).toBeInTheDocument()
    expect(document.querySelector('[data-message-id="a-1"] .rich-message[data-streaming]')).toBeNull()
    expect(document.querySelector('[data-message-id="a-1"] [aria-busy]')).toBeNull()
  })

  it('shows the reply so far, not held back, while a request waits', () => {
    mount([user, reply('a-1', 'I want to run the benchmark.')], { notWriting: true, streamText: false })
    expect(screen.getByText('I want to run the benchmark.')).toBeInTheDocument()
  })
})

describe('finished replies while a turn stays open (#2840)', () => {
  function mountTranscript(initial: {
    messages: AgentMessage[]
    activities?: AgentActivity[]
    backgroundWork?: AgentBackgroundWork[]
    providerId?: 'grok' | 'claude' | 'antigravity'
  }) {
    const command = vi.fn(async () => null)
    const store = new ThreadDraftStore(command)
    const build = (patch: { messages: AgentMessage[]; activities?: AgentActivity[]; backgroundWork?: AgentBackgroundWork[]; status?: 'running' | 'idle'; providerId?: 'grok' | 'claude' | 'antigravity' }) => {
      const state: AgentState = threadsStateFixture()
      const target = state.host.threads.find(item => item.id === 'grok-previews')!
      if (patch.providerId !== undefined) target.providerId = patch.providerId
      target.status = patch.status ?? 'running'
      target.requests = []
      target.messages = patch.messages
      target.activities = patch.activities ?? []
      if (patch.backgroundWork) target.backgroundWork = patch.backgroundWork
      else delete target.backgroundWork
      const row = describeThreads(state, E2E_THREADS_NOW).find(item => item.thread.id === target.id)!
      return <ResponseStreamingProvider value="complete">
        <ThreadTranscript row={row} state={state} command={command} store={store} followSignal={0} />
      </ResponseStreamingProvider>
    }
    const view = render(build(initial))
    return {
      update: (next: { messages: AgentMessage[]; activities?: AgentActivity[]; backgroundWork?: AgentBackgroundWork[]; status?: 'running' | 'idle'; providerId?: 'grok' | 'claude' | 'antigravity' }) => {
        view.rerender(build(next))
      },
      unmount: () => view.unmount(),
      remount: (next: { messages: AgentMessage[]; activities?: AgentActivity[]; backgroundWork?: AgentBackgroundWork[]; status?: 'running' | 'idle'; providerId?: 'grok' | 'claude' | 'antigravity' }) => {
        view.unmount()
        return render(build(next))
      },
    }
  }

  it('holds streaming tokens while arriving, then reveals a finished reply while backgroundWork keeps the turn running', () => {
    vi.useFakeTimers()
    const bg: AgentBackgroundWork[] = [{ id: 'bg-render', label: 'python render.py', type: 'command', startedAt: at }]
    const activities: AgentActivity[] = [
      { id: 'turn-u1', turnId: 'u-1', afterMessageId: 'u-1', sequence: 0, kind: 'turn', status: 'running', title: 'Turn', startedAt: at },
      { id: 'cmd-1', turnId: 'u-1', afterMessageId: 'u-1', sequence: 1, kind: 'command', status: 'completed', title: 'Running python render.py', command: 'python render.py', startedAt: at },
    ]
    const baseMessages: AgentMessage[] = [
      { id: 'u-1', role: 'user', text: 'Start the render.', createdAt: at },
      { id: 'a-1', role: 'assistant', text: 'Started in background.', createdAt: at },
      { id: 'u-2', role: 'user', text: 'How is the render going?', createdAt: at },
    ]
    const view = mountTranscript({
      messages: [...baseMessages, reply('a-2', 'The render ')],
      activities,
      backgroundWork: bg,
    })

    // Partial chunk is held back under responseStreaming: 'complete'.
    expect(screen.queryByText(/The render/u)).not.toBeInTheDocument()
    expect(screen.getByTestId('thread-activity-live')).toHaveTextContent('Writing a reply')

    // Another chunk arrives before the settle window expires and resets the timer.
    act(() => { vi.advanceTimersByTime(HELD_WORK_REPLY_SETTLE_MS - 500) })
    view.update({
      messages: [...baseMessages, reply('a-2', 'The render is at 62%.')],
      activities,
      backgroundWork: bg,
    })
    expect(screen.queryByText(/The render/u)).not.toBeInTheDocument()

    // Still held back just before HELD_WORK_REPLY_SETTLE_MS after the last chunk.
    act(() => { vi.advanceTimersByTime(HELD_WORK_REPLY_SETTLE_MS - 100) })
    expect(screen.queryByText(/The render/u)).not.toBeInTheDocument()

    // Once quiet for HELD_WORK_REPLY_SETTLE_MS while background work holds the turn open, the finished reply appears.
    act(() => { vi.advanceTimersByTime(100) })
    expect(screen.getByText('The render is at 62%.')).toBeInTheDocument()
    const article = document.querySelector('[data-message-id="a-2"]')!
    expect(article.querySelector('.rich-message[data-streaming]')).toBeNull()
    expect(article.querySelector('.thread-message__copy')).not.toBeNull()
    // WorkingWord holds its previous step label for HOLD_MS (1500ms) before rotating back to idle working words.
    act(() => { vi.advanceTimersByTime(1_500) })
    expect(screen.getByTestId('thread-activity-live')).not.toHaveTextContent('Writing a reply')

    // A follow-up steer on the same still-running thread holds its new reply while streaming, then reveals it too.
    const nextMessages: AgentMessage[] = [...baseMessages, reply('a-2', 'The render is at 62%.'), { id: 'u-3', role: 'user', text: 'Any ETA?', createdAt: at }]
    view.update({ messages: [...nextMessages, reply('a-3', 'About 18 minutes.')], activities, backgroundWork: bg })
    expect(screen.getByText('The render is at 62%.')).toBeInTheDocument()
    expect(screen.queryByText('About 18 minutes.')).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(HELD_WORK_REPLY_SETTLE_MS) })
    expect(screen.getByText('About 18 minutes.')).toBeInTheDocument()
  })

  it('reveals a finished reply when a running command step earlier in the turn holds the turn open', () => {
    vi.useFakeTimers()
    const activities: AgentActivity[] = [
      { id: 'turn-u1', turnId: 'u-1', afterMessageId: 'u-1', sequence: 0, kind: 'turn', status: 'running', title: 'Turn', startedAt: at },
      { id: 'cmd-1', turnId: 'u-1', afterMessageId: 'u-1', sequence: 1, kind: 'command', status: 'running', title: 'Bash', command: 'python render.py', startedAt: at },
    ]
    mountTranscript({
      messages: [
        { id: 'u-1', role: 'user', text: 'Start render.', createdAt: at },
        { id: 'u-2', role: 'user', text: 'How is it going?', createdAt: at },
        reply('a-2', 'Halfway through.'),
      ],
      activities,
    })

    expect(screen.queryByText('Halfway through.')).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(HELD_WORK_REPLY_SETTLE_MS) })
    expect(screen.getByText('Halfway through.')).toBeInTheDocument()
  })

  it('keeps a normal streaming turn held past the background-work window, then reveals after the quiet backstop', () => {
    vi.useFakeTimers()
    const activities: AgentActivity[] = [
      { id: 'turn-u1', turnId: 'u-1', afterMessageId: 'u-1', sequence: 0, kind: 'turn', status: 'running', title: 'Turn', startedAt: at },
    ]
    const view = mountTranscript({
      messages: [{ id: 'u-1', role: 'user', text: 'Write an essay.', createdAt: at }, reply('a-1', 'Lighthouses began')],
      activities,
    })

    // Must remain held back well past HELD_WORK_REPLY_SETTLE_MS during a normal turn.
    act(() => { vi.advanceTimersByTime(HELD_WORK_REPLY_SETTLE_MS * 3) })
    expect(screen.queryByText(/Lighthouses began/u)).not.toBeInTheDocument()

    // Streaming another chunk resets the quiet backstop timer.
    view.update({
      messages: [{ id: 'u-1', role: 'user', text: 'Write an essay.', createdAt: at }, reply('a-1', 'Lighthouses began as fires.')],
      activities,
    })
    act(() => { vi.advanceTimersByTime(QUIET_REPLY_SETTLE_MS - 1_000) })
    expect(screen.queryByText(/Lighthouses began/u)).not.toBeInTheDocument()

    // If the turn stays open silently for QUIET_REPLY_SETTLE_MS, the reply reveals rather than staying hidden forever.
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(screen.getByText('Lighthouses began as fires.')).toBeInTheDocument()
  })

  it('returns an already-settled reply to writing when more text arrives for the same ID, without hiding shown text (L2)', () => {
    vi.useFakeTimers()
    const bg: AgentBackgroundWork[] = [{ id: 'bg-render', label: 'python render.py', type: 'command', startedAt: at }]
    const activities: AgentActivity[] = [
      { id: 'turn-u1', turnId: 'u-1', afterMessageId: 'u-1', sequence: 0, kind: 'turn', status: 'running', title: 'Turn', startedAt: at },
    ]
    const baseMessages: AgentMessage[] = [{ id: 'u-1', role: 'user', text: 'Start render.', createdAt: at }]
    const view = mountTranscript({
      messages: [...baseMessages, reply('a-1', 'Started in background.')],
      activities,
      backgroundWork: bg,
      providerId: 'antigravity',
    })

    act(() => { vi.advanceTimersByTime(HELD_WORK_REPLY_SETTLE_MS) })
    act(() => { vi.advanceTimersByTime(1_500) })
    expect(screen.getByText('Started in background.')).toBeInTheDocument()
    const settledArticle = document.querySelector('[data-message-id="a-1"]')!
    expect(settledArticle.querySelector('.rich-message[data-streaming]')).toBeNull()
    expect(settledArticle.querySelector('.thread-message__copy')).not.toBeNull()
    expect(screen.getByTestId('thread-activity-live')).not.toHaveTextContent('Writing a reply')

    // More text arrives for the same message ID: stays visible, returns to streaming with caret & no Copy, and restarts timer.
    view.update({
      messages: [...baseMessages, reply('a-1', 'Started in background. More arriving')],
      activities,
      backgroundWork: bg,
      providerId: 'antigravity',
    })
    expect(screen.getByText('Started in background. More arriving')).toBeInTheDocument()
    const growingArticle = document.querySelector('[data-message-id="a-1"]')!
    expect(growingArticle.querySelector('.rich-message[data-streaming]')).not.toBeNull()
    expect(growingArticle.querySelector('.thread-message__copy')).toBeNull()
    act(() => { vi.advanceTimersByTime(1_500) })
    expect(screen.getByTestId('thread-activity-live')).toHaveTextContent('Writing a reply')

    // Once quiet again for HELD_WORK_REPLY_SETTLE_MS, it settles back cleanly.
    act(() => { vi.advanceTimersByTime(HELD_WORK_REPLY_SETTLE_MS) })
    const resettled = document.querySelector('[data-message-id="a-1"]')!
    expect(resettled.querySelector('.rich-message[data-streaming]')).toBeNull()
    expect(resettled.querySelector('.thread-message__copy')).not.toBeNull()
  })

  it('ignores detached runs and prior-turn background work on non-Antigravity turns so ordinary turns keep the 15s window (L3)', () => {
    vi.useFakeTimers()
    const earlier = '2026-09-15T10:10:00.000Z'
    const detached: AgentBackgroundWork[] = [
      { id: 'bg-detached', label: 'claude dev server', type: 'detached-run', startedAt: at, run: { client: 'Claude Code', command: 'npm run dev' } },
      { id: 'bg-prior', label: 'earlier command', type: 'command', startedAt: earlier },
    ]
    const activities: AgentActivity[] = [
      { id: 'turn-u1', turnId: 'u-1', afterMessageId: 'u-1', sequence: 0, kind: 'turn', status: 'running', title: 'Turn', startedAt: at },
    ]
    mountTranscript({
      messages: [{ id: 'u-1', role: 'user', text: 'Write an essay.', createdAt: at }, reply('a-1', 'Lighthouses began')],
      activities,
      backgroundWork: detached,
      providerId: 'claude',
    })

    // Detached run + prior-turn background work on Claude must NOT shorten the settle window to 2s.
    act(() => { vi.advanceTimersByTime(HELD_WORK_REPLY_SETTLE_MS * 3) })
    expect(screen.queryByText(/Lighthouses began/u)).not.toBeInTheDocument()

    // Quiet backstop still reveals at QUIET_REPLY_SETTLE_MS.
    act(() => { vi.advanceTimersByTime(QUIET_REPLY_SETTLE_MS - HELD_WORK_REPLY_SETTLE_MS * 3) })
    expect(screen.getByText('Lighthouses began')).toBeInTheDocument()
  })

  it('keeps an already-revealed reply visible immediately after remounting the transcript (N1)', () => {
    vi.useFakeTimers()
    const activities: AgentActivity[] = [
      { id: 'turn-u1', turnId: 'u-1', afterMessageId: 'u-1', sequence: 0, kind: 'turn', status: 'running', title: 'Turn', startedAt: at },
    ]
    const props: { messages: AgentMessage[]; activities: AgentActivity[] } = {
      messages: [{ id: 'u-1', role: 'user', text: 'Write an essay.', createdAt: at }, reply('a-1', 'Already revealed.')],
      activities,
    }
    const view = mountTranscript(props)
    act(() => { vi.advanceTimersByTime(QUIET_REPLY_SETTLE_MS) })
    expect(screen.getByText('Already revealed.')).toBeInTheDocument()

    // Switching away and back remounts ThreadTranscript; the revealed reply must stay visible at t=0.
    view.remount(props)
    expect(screen.getByText('Already revealed.')).toBeInTheDocument()
  })
})
