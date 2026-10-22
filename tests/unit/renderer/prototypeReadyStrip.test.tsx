import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentState, AgentThread, QuestionPage } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const THREAD = 'grok-previews'
const file: QuestionPage = { token: 'f'.repeat(32), kind: 'file', name: 'settings-prototype.html', start: 'settings-prototype.html' }
const served: QuestionPage = { token: 's'.repeat(32), kind: 'server', name: 'localhost:8075', start: '' }

/** The Threads page on a thread whose prototype waits for review (ADR-0108), as the host publishes it. */
function stateWith(patch: Partial<AgentThread>): AgentState {
  const state = threadsStateFixture()
  state.activeThreadId = THREAD
  state.host.threads = state.host.threads.map(thread => thread.id === THREAD ? { ...thread, ...patch } : thread)
  return state
}
const marked = (pages: QuestionPage[] = [file, served]): Partial<AgentThread> => ({ prototypeReady: { source: 'reply:grok-previews-2', pages } })

function mount(state: AgentState) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView now={E2E_THREADS_NOW} />)
  return live
}
const strip = (): HTMLElement | null => screen.queryByRole('region', { name: 'Prototype ready for review' })
const republish = (live: ReturnType<typeof mount>, patch: Partial<AgentThread>): void => {
  act(() => { live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(thread => {
    if (thread.id !== THREAD) return thread
    const { prototypeReady: _mark, ...rest } = thread
    void _mark
    return { ...rest, ...patch }
  }) } }) })
}

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(() => { cleanup(); delete window.sotto })

describe('the strip above the composer while a prototype waits for review', () => {
  it('offers an Open the prototype row for each page, ahead of the composer in the keyboard order', () => {
    mount(stateWith(marked()))
    const region = strip()!
    expect(region).toBeVisible()
    expect(region).toHaveTextContent('Prototype ready for review')
    const rows = within(region).getAllByRole('link')
    expect(rows.map(row => row.getAttribute('aria-label'))).toEqual(['Open the prototype, settings-prototype.html', 'Open the prototype, localhost:8075'])
    expect(rows.every(row => row.getAttribute('tabindex') === '0')).toBe(true)
    const prompt = screen.getAllByRole('textbox').find(box => box.closest('.thread-workspace__compose') !== null)!
    expect(rows[1]!.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('opens a page through main by the thread and its token, with no request', async () => {
    const openQuestionPage = vi.fn(async () => ({ ok: true as const }))
    window.sotto = { openQuestionPage } as unknown as NonNullable<typeof window.sotto>
    mount(stateWith(marked()))
    fireEvent.click(within(strip()!).getByRole('link', { name: 'Open the prototype, settings-prototype.html' }))
    expect(openQuestionPage).toHaveBeenLastCalledWith({ threadId: THREAD, token: file.token })
    fireEvent.keyDown(within(strip()!).getByRole('link', { name: 'Open the prototype, localhost:8075' }), { key: 'Enter' })
    expect(openQuestionPage).toHaveBeenLastCalledWith({ threadId: THREAD, token: served.token })
    await waitFor(() => expect(openQuestionPage).toHaveBeenCalledTimes(2))
  })

  it('says so in plain words when the page could not open', async () => {
    window.sotto = { openQuestionPage: vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const })) } as unknown as NonNullable<typeof window.sotto>
    mount(stateWith(marked([file])))
    fireEvent.click(within(strip()!).getByRole('link', { name: 'Open the prototype, settings-prototype.html' }))
    expect(await within(strip()!).findByText('Sotto could not open that page. Nothing else changed. Try again.')).toBeVisible()
  })

  it('gives way to a waiting question, whose card carries the pages, and goes when the host clears the mark', () => {
    const live = mount(stateWith({ ...marked(), requests: [{ id: 'q-1', kind: 'question', text: 'Which variant?', options: [], pages: [file] }] }))
    expect(strip()).toBeNull()
    expect(screen.getByRole('link', { name: 'Open the prototype, settings-prototype.html' }).closest('.agent-request')).not.toBeNull()
    republish(live, { ...marked(), requests: [] })
    expect(strip()).not.toBeNull()
    republish(live, {})
    expect(strip()).toBeNull()
  })

  it('shows nothing on a closed thread', () => {
    mount(stateWith({ ...marked(), archivedAt: new Date(E2E_THREADS_NOW).toISOString() }))
    expect(strip()).toBeNull()
  })
})
