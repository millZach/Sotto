import React, { type ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadWorkspace } from '../../../src/renderer/src/agents/ThreadWorkspace'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: () => ({ command: vi.fn(async () => null), state: null }) }))
vi.mock('../../../src/renderer/src/tools/toolsPanelStore', () => ({ useToolsPanelChrome: () => ({ pinnedThreadId: null }) }))
vi.mock('../../../src/renderer/src/tools/ToolsPanel', () => ({ ToolsPanel: () => null }))
vi.mock('../../../src/renderer/src/agents/ThreadWorkingCopy', () => ({ ThreadWorkingCopy: () => null, ThreadWorkingCopyNotice: () => null, describeWorkingCopy: () => ({}) }))
vi.mock('../../../src/renderer/src/tools/PaneTerminalDrawer', () => ({ PaneTerminalDrawer: ({ threadId }: { threadId: string }) => <div data-drawer={threadId} />, hideDrawerFromInside: vi.fn() }))

type Row = { thread: { id: string; remoteHost?: boolean }; project: undefined }
const rows: Row[] = [{ thread: { id: 'local' }, project: undefined }, { thread: { id: 'remote', remoteHost: true }, project: undefined }]
vi.mock('../../../src/renderer/src/agents/ThreadsView', () => ({
  // Every pane asks whether its ··· menu lists a Terminal drawer, and renders its drawer slot, as ThreadsView does.
  ThreadsView: ({ paneTools, paneTerminal, paneDrawer }: { paneTools: boolean; paneTerminal: (props: { row: Row }) => boolean; paneDrawer: (props: { row: Row }) => ReactNode }) => <>
    {rows.map(row => <section key={row.thread.id} aria-label={row.thread.id} data-tools={paneTools || undefined} data-terminal={paneTerminal({ row }) || undefined}>{paneDrawer({ row })}</section>)}
  </>,
}))
afterEach(cleanup)

describe('the thread workspace’s terminal drawers', () => {
  it('offers a drawer on a local thread only: a thread on a paired host keeps its terminal on that machine', () => {
    render(<ThreadWorkspace />)
    expect(screen.getByRole('region', { name: 'local' })).toHaveAttribute('data-terminal')
    expect(screen.getByRole('region', { name: 'local' }).querySelector('[data-drawer="local"]')).not.toBeNull()
    expect(screen.getByRole('region', { name: 'remote' })).not.toHaveAttribute('data-terminal')
    expect(screen.getByRole('region', { name: 'remote' }).querySelector('[data-drawer]')).toBeNull()
    // Tools is the workspace's too: the focused pane's ··· menu lists it (ADR-0163).
    expect(screen.getByRole('region', { name: 'local' })).toHaveAttribute('data-tools')
  })
})
