import React, { type ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadWorkspace } from '../../../src/renderer/src/agents/ThreadWorkspace'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: () => ({ command: vi.fn(async () => null), state: null }) }))
vi.mock('../../../src/renderer/src/tools/toolsPanelStore', () => ({ useToolsPanelChrome: () => ({ pinnedThreadId: null }) }))
vi.mock('../../../src/renderer/src/tools/ToolsPanel', () => ({ ToolsPanel: () => null, ToolsPanelToggle: () => null }))
vi.mock('../../../src/renderer/src/agents/ThreadWorkingCopy', () => ({ ThreadWorkingCopy: () => null, ThreadWorkingCopyNotice: () => null, describeWorkingCopy: () => ({}) }))
vi.mock('../../../src/renderer/src/tools/PaneTerminalDrawer', () => ({ PaneTerminalDrawer: ({ threadId }: { threadId: string }) => <div data-drawer={threadId} />, hideDrawerFromInside: vi.fn() }))

type Slot = (props: { row: { thread: { id: string; remoteHost?: boolean }; project: undefined } }) => ReactNode
const rows = [{ thread: { id: 'local' }, project: undefined }, { thread: { id: 'remote', remoteHost: true }, project: undefined }]
vi.mock('../../../src/renderer/src/agents/ThreadsView', () => ({
  // Every pane renders its header actions and its drawer slot, as ThreadsView does.
  ThreadsView: ({ paneActions, paneDrawer }: { paneActions: Slot; paneDrawer: Slot }) => <>
    {rows.map(row => <section key={row.thread.id} aria-label={row.thread.id}>{paneActions({ row })}{paneDrawer({ row })}</section>)}
  </>,
}))
afterEach(cleanup)

describe('the thread workspace’s terminal drawers', () => {
  it('offers a drawer on a local thread only: a thread on a paired host keeps its terminal on that machine', () => {
    render(<ThreadWorkspace onOpenAgents={() => undefined} />)
    expect(screen.getByRole('region', { name: 'local' }).querySelector('[data-pane-terminal-toggle]')).not.toBeNull()
    expect(screen.getByRole('region', { name: 'local' }).querySelector('[data-drawer="local"]')).not.toBeNull()
    expect(screen.getByRole('region', { name: 'remote' }).querySelector('[data-pane-terminal-toggle]')).toBeNull()
    expect(screen.getByRole('region', { name: 'remote' }).querySelector('[data-drawer]')).toBeNull()
  })
})
