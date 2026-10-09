import { setPromptText, promptText } from './helpers/promptEditor'
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommand, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { ThreadComposer } from '../../../src/renderer/src/agents/ThreadComposer'
import { ThreadDraftStore } from '../../../src/renderer/src/agents/threadDraftStore'
import { describeThreads } from '../../../src/renderer/src/agents/threadFacts'
import { threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

afterEach(cleanup)

function fixture() {
  const state = threadsStateFixture()
  state.assignments = []
  state.host.threads.forEach(thread => { thread.requests = [] })
  state.queue = []
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => state)
  const store = new ThreadDraftStore(command)
  const composer = (threadId = 'grok-previews') => <ThreadComposer
    row={describeThreads(state, E2E_THREADS_NOW).find(row => row.thread.id === threadId)!}
    state={state} command={command} store={store} onSend={vi.fn()} />
  return { state, command, store, composer }
}

function questionFixture() {
  const f = fixture()
  const thread = f.state.host.threads.find(thread => thread.id === 'visual-gate')!
  thread.requests = [{ id: 'direction', kind: 'question', text: 'Which direction?', options: [] }]
  f.state.queue = [{ id: 'direction', threadId: thread.id, kind: 'question', text: 'Which direction?', requestId: 'direction', createdAt: new Date(E2E_THREADS_NOW).toISOString(), deferred: false }]
  return { ...f, thread }
}

describe('thread composer recovery', () => {
  it('keeps focus and text when a permission arrives, blocks edits and sends, then resumes editing', () => {
    const f = fixture()
    const view = render(f.composer())
    const prompt = screen.getByRole('textbox', { name: 'Prompt' })
    setPromptText(prompt, 'Keep this draft')
    prompt.focus()
    const thread = f.state.host.threads.find(thread => thread.id === 'grok-previews')!
    thread.requests = [{ id: 'permission', kind: 'permission', text: 'Allow this command?', options: [] }]
    view.rerender(f.composer())
    expect(prompt).not.toBeDisabled()
    expect(prompt).toHaveAttribute('contenteditable', 'false')
    expect(prompt).toHaveAttribute('aria-disabled', 'true')
    expect(prompt).toHaveFocus()
    expect(promptText(prompt)).toBe('Keep this draft')
    setPromptText(prompt, 'Blocked edit')
    fireEvent.keyDown(prompt, { key: 'Enter' })
    expect(f.store.draft(thread.id).text).toBe('Keep this draft')
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled()
    expect(f.command.mock.calls.some(([request]) => request.type === 'manual-send' || request.type === 'answer')).toBe(false)
    thread.requests = []
    view.rerender(f.composer())
    expect(prompt).toHaveAttribute('contenteditable', 'true')
    expect(prompt).not.toHaveAttribute('aria-disabled')
    expect(prompt).toHaveFocus()
    setPromptText(prompt, 'Continue typing')
    expect(f.store.draft(thread.id).text).toBe('Continue typing')
    f.store.flushAll()
  })

  it.each(['before leaving', 'while away'] as const)('keeps an answer failure with its thread when it arrives %s', async timing => {
    const f = questionFixture()
    const { thread } = f
    let finish!: (result: AgentState | null) => void
    f.command.mockImplementation(async request => request.type === 'answer' ? new Promise(done => { finish = done }) : f.state)
    const view = render(f.composer(thread.id))
    const answer = screen.getByRole('textbox', { name: 'Your answer' })
    setPromptText(answer, 'Go left')
    fireEvent.keyDown(answer, { key: 'Enter' })
    const fail = async () => { await act(async () => { finish({ ...f.state, error: 'The answer was refused.' }) }) }
    if (timing === 'before leaving') await fail()
    // A pane can close completely, rather than merely receiving a different row.
    view.unmount()
    const other = render(f.composer())
    if (timing === 'while away') await fail()
    expect(screen.queryByText(/The answer was refused/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeDisabled()
    other.unmount()
    render(f.composer(thread.id))
    expect(screen.getByRole('alert')).toHaveTextContent('The answer was refused. It is back in the composer.')
    expect(promptText(screen.getByRole('textbox', { name: 'Your answer' }))).toBe('Go left')
    setPromptText(screen.getByRole('textbox', { name: 'Your answer' }), 'Go right')
    expect(screen.queryByText(/The answer was refused/)).not.toBeInTheDocument()
    f.store.flushAll()
  })

  it('keeps answer delivery on its own thread and preserves newer typing when a late answer fails', async () => {
    const f = questionFixture()
    const { thread } = f
    let finish!: (result: AgentState | null) => void
    f.command.mockImplementation(async request => request.type === 'answer' ? new Promise(done => { finish = done }) : f.state)
    const view = render(f.composer(thread.id))
    setPromptText(screen.getByRole('textbox', { name: 'Your answer' }), 'Go left')
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Your answer' }), { key: 'Enter' })
    view.rerender(f.composer())
    setPromptText(screen.getByRole('textbox', { name: 'Prompt' }), 'Another thread draft')
    expect(screen.getByRole('button', { name: 'Send prompt' })).toBeEnabled()
    view.rerender(f.composer(thread.id))
    expect(screen.getByText('Sending answer…')).toBeVisible()
    setPromptText(screen.getByRole('textbox', { name: 'Your answer' }), 'Go right')
    expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled()
    await act(async () => { finish(null) })
    expect(screen.getByRole('alert')).toHaveTextContent('Sotto could not confirm this answer. Your newer draft is in the composer.')
    expect(promptText(screen.getByRole('textbox', { name: 'Your answer' }))).toBe('Go right')
    f.store.flushAll()
  })
})
