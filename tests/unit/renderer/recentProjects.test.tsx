import { fireEvent, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderThreads, stateFixture } from '../../fixtures/renderer/threadsViewHarness'
import { draftThreads } from '../../../src/renderer/src/agents/draftThreads'
import type { AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))

/** Recent projects on a new thread (ADR-0121; Owl only): the greeting's project opens a menu of the other recent projects. */
function mount(owl: boolean) {
  vi.mocked(useOptionalApp).mockReturnValue({ update: { owlFeatures: { 'recent-projects': owl } } } as unknown as AppContextValue)
  const state = stateFixture()
  const thread = state.host.threads.find(item => item.id === state.activeThreadId)!
  Object.assign(thread, { messages: [], activities: [], requests: [], historyStatus: 'ready', status: 'idle', earlierAvailable: false, compaction: undefined })
  const project = state.host.projects.find(item => item.id === thread.projectId)!
  state.host.projects.push({ id: 'garden', title: 'Garden', path: '/work/garden' }, { id: 'unused', title: 'Unused', path: '/work/unused' })
  state.host.threads.push({ ...structuredClone(thread), id: 'garden-thread', projectId: 'garden', title: 'Prune the hedges', titleSource: 'user', updatedAt: '2026-10-20T12:00:00.000Z' })
  const { command } = renderThreads(state)
  return { command, project, greeting: document.querySelector<HTMLElement>('.thread-greeting')! }
}

describe('recent projects on a new thread', () => {
  it('starts the new thread in another recent project from the greeting\'s project menu', async () => {
    const { command, project, greeting } = mount(true)
    fireEvent.click(within(greeting).getByRole('button', { name: `Change project, now ${project.title}` }))
    const menu = within(greeting).getByRole('menu')
    // Only projects with work in them are offered, never the one the thread is already in.
    const offered = within(menu).getAllByRole('menuitem').map(item => item.textContent)
    expect(offered[0]).toBe('Garden')
    expect(offered.at(-1)).toBe('Choose another folder…')
    expect(offered).not.toContain('Unused')
    expect(offered).not.toContain(project.title)
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Garden' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'create-thread', projectId: 'garden' })))
    draftThreads.reset()
  })

  it('closes the menu on Escape and puts focus back on the project', () => {
    const { project, greeting } = mount(true)
    const button = within(greeting).getByRole('button', { name: `Change project, now ${project.title}` })
    fireEvent.click(button)
    const menu = within(greeting).getByRole('menu')
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(within(greeting).queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('shows the project as plain words on stable', () => {
    const { project, greeting } = mount(false)
    expect(within(greeting).queryByRole('button', { name: /Change project/u })).toBeNull()
    expect(greeting).toHaveTextContent(project.title)
  })
})
