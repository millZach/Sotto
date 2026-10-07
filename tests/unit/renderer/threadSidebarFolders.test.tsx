import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { describeThreads, organizeWorkspace } from '../../../src/renderer/src/agents/threadFacts'
import { ThreadSidebar } from '../../../src/renderer/src/agents/ThreadSidebar'
import { threadsStateFixture } from './liveAgentState'

afterEach(cleanup)

function mount() {
  const state = threadsStateFixture()
  const organization = organizeWorkspace(state, describeThreads(state, E2E_THREADS_NOW), '')
  return render(<ThreadSidebar state={state} organization={organization} command={vi.fn(async () => state)} query="" onQuery={vi.fn()} onOpen={vi.fn()} onNewThread={vi.fn()}
    currentThreadId="visual-gate" openThreadIds={['visual-gate']} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />)
}
/** A section's folder toggles, named for the project and its count; the Settled shelf's own toggle is not a folder. */
const FOLDER = /^(?!Settled ).* \d+ threads?$/
const folders = (section: string, expanded: boolean): HTMLElement[] => within(screen.getByRole('region', { name: section })).queryAllByRole('button', { expanded, name: FOLDER })

it('starts every project folder closed, the open thread\'s and the settled ones too', () => {
  mount()
  expect(folders('Projects', true)).toEqual([])
  expect(folders('Projects', false).length).toBeGreaterThan(1)
  expect(screen.queryByRole('button', { name: 'Visual gate flake' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /^Settled/ }))
  expect(folders('Settled', true)).toEqual([])
  expect(folders('Settled', false).length).toBeGreaterThan(0)
})

it('keeps a folder the user opened open when the sidebar is mounted again in the same window', () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: /^workshop \d+ threads?$/ }))
  expect(screen.getByRole('button', { name: /^workshop \d+ threads?$/ })).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('button', { name: 'Visual gate flake' })).toBeVisible()
  cleanup()
  mount()
  expect(screen.getByRole('button', { name: /^workshop \d+ threads?$/ })).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(screen.getByRole('button', { name: /^workshop \d+ threads?$/ }))
  expect(screen.queryByRole('button', { name: 'Visual gate flake' })).not.toBeInTheDocument()
})

it('keeps a folder open for the window when session storage refuses the write', () => {
  const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
  mount()
  fireEvent.click(screen.getByRole('button', { name: /^workshop \d+ threads?$/ }))
  expect(screen.getByRole('button', { name: 'Visual gate flake' })).toBeVisible()
  refuse.mockRestore()
  // The next write that storage accepts is read back again.
  fireEvent.click(screen.getByRole('button', { name: /^workshop \d+ threads?$/ }))
  expect(screen.queryByRole('button', { name: 'Visual gate flake' })).not.toBeInTheDocument()
})
