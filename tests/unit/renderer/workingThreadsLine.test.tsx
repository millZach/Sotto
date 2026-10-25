import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentState, AgentThread } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { describeThreads, organizeWorkspace } from '../../../src/renderer/src/agents/threadFacts'
import { ThreadSidebar } from '../../../src/renderer/src/agents/ThreadSidebar'
import { threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

afterEach(cleanup)

const SENTENCE = /This computer may slow down or use its battery faster\./u

/**
 * The fixture's threads, every one idle, then `working` more on this computer with a turn running. Watcher's own thread
 * and a thread on another computer are working too, and neither counts.
 */
function stateWith(working: number): AgentState {
  const state = threadsStateFixture()
  const base = state.host.threads[0]!
  const idle = state.host.threads.map(thread => ({ ...thread, status: 'idle' as const, lastTurn: undefined }))
  const running = (id: string, patch: Partial<AgentThread> = {}): AgentThread => ({ ...base, id, title: `Synthetic ${id}`, status: 'running', lastTurn: undefined, ...patch })
  const local = Array.from({ length: working }, (_, index) => running(`working-${index}`))
  const watcher = running('watcher-own', { kind: 'watcher' })
  const remote = running('remote-work', { remoteHost: true, hostId: '22222222-2222-4222-8222-222222222222', hostLabel: 'Paired computer' })
  return { ...state, host: { ...state.host, threads: [...idle, ...local, watcher, remote] } }
}

function mount(state: AgentState) {
  const organization = organizeWorkspace(state, describeThreads(state, E2E_THREADS_NOW), '')
  return render(<ThreadSidebar state={state} organization={organization} command={vi.fn(async () => state)} query="" onQuery={vi.fn()} onOpen={vi.fn()} onNewThread={vi.fn()}
    currentThreadId={null} openThreadIds={[]} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />)
}

describe('the working threads line (#1183)', () => {
  it('shows under the search field while eleven threads are working, the count in the stronger weight, quietly', () => {
    mount(stateWith(11))
    const line = screen.getByText(SENTENCE, { exact: false }).closest('p')!
    expect(line).toHaveTextContent('11 threads are working. This computer may slow down or use its battery faster.')
    expect(line.querySelector('strong')).toHaveTextContent('11 threads are working.')
    // Not announced, not dismissed: no live region, no alert and no button.
    expect(line).not.toHaveAttribute('role')
    expect(line).not.toHaveAttribute('aria-live')
    expect(line.querySelector('button')).toBeNull()
    // It follows the search field, in the open sidebar only; the collapsed rail hides that part whole.
    const search = screen.getByRole('searchbox', { name: 'Search threads' })
    expect(search.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(line.closest('.thread-nav__expanded')).not.toBeNull()
  })

  it('shows nothing at ten', () => {
    mount(stateWith(10))
    expect(screen.queryByText(SENTENCE, { exact: false })).toBeNull()
  })

  it('counts the working threads live as they change', () => {
    const view = mount(stateWith(12))
    expect(screen.getByText('12 threads are working.')).toBeInTheDocument()
    const fewer = stateWith(10)
    view.rerender(<ThreadSidebar state={fewer} organization={organizeWorkspace(fewer, describeThreads(fewer, E2E_THREADS_NOW), '')} command={vi.fn(async () => fewer)} query=""
      onQuery={vi.fn()} onOpen={vi.fn()} onNewThread={vi.fn()} currentThreadId={null} openThreadIds={[]} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />)
    expect(screen.queryByText(SENTENCE, { exact: false })).toBeNull()
  })
})
