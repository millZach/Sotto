import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { describeThreads, organizeWorkspace } from '../../../src/renderer/src/agents/threadFacts'
import { ThreadSidebar } from '../../../src/renderer/src/agents/ThreadSidebar'
import { threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

const owl = vi.hoisted(() => ({ peek: true }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>()
  return { ...actual, useOwlFeature: (id: string) => id === 'folder-peek' ? owl.peek : actual.useOwlFeature(id as never) }
})

beforeEach(() => { owl.peek = true; sessionStorage.clear(); vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

function mount() {
  const state = threadsStateFixture()
  const organization = organizeWorkspace(state, describeThreads(state, E2E_THREADS_NOW), '')
  const onOpen = vi.fn()
  render(<ThreadSidebar state={state} organization={organization} command={vi.fn(async () => state)} query="" onQuery={vi.fn()} onOpen={onOpen} onNewThread={vi.fn()}
    currentThreadId="visual-gate" openThreadIds={['visual-gate']} onOpenBeside={vi.fn()} onDragThread={vi.fn()} />)
  const toggle = screen.getByRole('button', { name: /^workshop \d+ threads?$/ })
  return { onOpen, toggle, folder: toggle.closest('.thread-folder') as HTMLElement }
}
const advance = (ms: number): void => { act(() => { vi.advanceTimersByTime(ms) }) }
const preview = () => screen.queryByRole('group', { name: 'Preview of threads in workshop' })

it('previews a closed folder after the pointer rests, and puts it away after it leaves', () => {
  const { toggle, folder } = mount()
  fireEvent.pointerOver(folder, { pointerType: 'mouse' })
  advance(349)
  expect(preview()).not.toBeInTheDocument()
  advance(1)
  expect(preview()).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Visual gate flake' })).toBeVisible()
  // A preview is not an opening: the folder's own state never moved.
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  fireEvent.pointerOut(folder, { pointerType: 'mouse', relatedTarget: document.body })
  advance(299)
  expect(preview()).toBeInTheDocument()
  advance(1)
  expect(preview()).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Visual gate flake' })).not.toBeInTheDocument()
})

it('opens a thread from the preview and leaves its folder closed', () => {
  const { onOpen, toggle, folder } = mount()
  fireEvent.pointerOver(folder, { pointerType: 'mouse' })
  advance(350)
  fireEvent.click(screen.getByRole('button', { name: 'Visual gate flake' }))
  expect(onOpen).toHaveBeenCalledWith('visual-gate')
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(preview()).not.toBeInTheDocument()
})

it('steps from the toggle into the preview, and Escape stays shut until focus leaves', () => {
  const { toggle } = mount()
  act(() => toggle.focus())
  advance(350)
  expect(preview()).toBeInTheDocument()
  fireEvent.keyDown(toggle, { key: 'ArrowDown' })
  expect(document.activeElement).toHaveClass('thread-nav__item')
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
  expect(preview()).not.toBeInTheDocument()
  expect(toggle).toHaveFocus()
  advance(1_000)
  expect(preview()).not.toBeInTheDocument()
})

it('leaves caret keys in a preview row rename field to the field', () => {
  const { folder } = mount()
  fireEvent.pointerOver(folder, { pointerType: 'mouse' })
  advance(350)
  fireEvent.click(screen.getByRole('button', { name: 'Rename Visual gate flake' }))
  const field = screen.getByRole('textbox')
  expect(field).toHaveFocus()
  expect(fireEvent.keyDown(field, { key: 'Home' })).toBe(true)
  expect(fireEvent.keyDown(field, { key: 'ArrowDown' })).toBe(true)
  expect(field).toHaveFocus()
  expect(field).toBeInTheDocument()
})

it('shows no preview from a touch pointer or with the Owl feature off', () => {
  const first = mount()
  fireEvent.pointerOver(first.folder, { pointerType: 'touch' })
  advance(1_000)
  expect(preview()).not.toBeInTheDocument()
  cleanup()
  owl.peek = false
  const second = mount()
  fireEvent.pointerOver(second.folder, { pointerType: 'mouse' })
  act(() => second.toggle.focus())
  advance(1_000)
  expect(preview()).not.toBeInTheDocument()
})

it('keeps the folder open for real from the preview foot', () => {
  const { toggle, folder } = mount()
  fireEvent.pointerOver(folder, { pointerType: 'mouse' })
  advance(350)
  fireEvent.click(screen.getByRole('button', { name: 'Keep open' }))
  expect(preview()).not.toBeInTheDocument()
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByRole('button', { name: 'Visual gate flake' })).toBeVisible()
  expect(toggle).toHaveFocus()
})
