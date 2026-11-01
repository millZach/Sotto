import React from 'react'
import { act, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { AgentState } from '../../../../src/shared/agents'
import { useAgents } from '../../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../../src/renderer/src/agents/ThreadsView'
import { SplitLayoutStore, openBeside } from '../../../../src/renderer/src/agents/splitLayout'
import { NOW, connection, stateFixture } from '../../../fixtures/renderer/threadsViewHarness'
import { withThread } from '../../../fixtures/agentState'

vi.mock('../../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

// Every pane the page draws, by its thread, counted where ThreadsView hands it to ThreadPane.
const drawn = vi.hoisted(() => [] as string[])
vi.mock('../../../../src/renderer/src/agents/ThreadPane', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../src/renderer/src/agents/ThreadPane')>()
  return { ...actual, ThreadPane: (props: Parameters<typeof actual.ThreadPane>[0]) => { drawn.push(props.row.thread.id); return actual.ThreadPane(props) } }
})

// Every draw of a branch toolbar, counted where it works out whether its working copy is locked.
const toolbarDraws = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../../src/renderer/src/agents/branchToolbar.logic', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../src/renderer/src/agents/branchToolbar.logic')>()
  return { ...actual, workspaceLocked: (...args: Parameters<typeof actual.workspaceLocked>) => { toolbarDraws.count++; return actual.workspaceLocked(...args) } }
})

it('draws neither pane when a thread not on screen streams, and only its own pane when a shown thread does (#993)', () => {
  let state = stateFixture()
  state.activeThreadId = 'visual-gate'
  const command = vi.fn(async () => state)
  const layoutStore = new SplitLayoutStore()
  layoutStore.set(openBeside(layoutStore.get(), 'visual-gate', 'grok-previews'))
  const publish = (next: AgentState): void => {
    state = next
    vi.mocked(useAgents).mockReturnValue(connection(next, command))
    act(() => { view.rerender(<ThreadsView now={NOW} layoutStore={layoutStore} paneAreaWidth={1200} paneAreaHeight={800} />) })
  }
  vi.mocked(useAgents).mockReturnValue(connection(state, command))
  const view = render(<ThreadsView now={NOW} layoutStore={layoutStore} paneAreaWidth={1200} paneAreaHeight={800} />)
  expect(screen.getAllByRole('region').filter(region => region.classList.contains('thread-pane'))).toHaveLength(2)

  // footer-links is in another project and on no pane: a streamed word there draws no pane.
  drawn.length = 0
  for (let word = 0; word < 5; word++) publish(withThread(state, 'footer-links', thread => ({ ...thread, messages: [...thread.messages], updatedAt: `2026-10-31T12:00:0${word}.000Z` })))
  expect(drawn).toEqual([])

  // A word on a shown thread draws that thread's pane alone, and not its branch toolbar, which reads none of its words.
  toolbarDraws.count = 0
  publish(withThread(state, 'grok-previews', thread => ({ ...thread, messages: [...thread.messages] })))
  expect(drawn).toEqual(['grok-previews'])
  expect(toolbarDraws.count).toBe(0)

  // Anything a pane reads beyond another thread's streaming draws them both.
  drawn.length = 0
  publish(withThread(state, 'footer-links', thread => ({ ...thread, title: 'Footer links, renamed' })))
  expect([...drawn].sort()).toEqual(['grok-previews', 'visual-gate'])
})
