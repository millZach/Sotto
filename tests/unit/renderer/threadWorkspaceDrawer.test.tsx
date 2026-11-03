import React, { type ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadWorkspace } from '../../../src/renderer/src/agents/ThreadWorkspace'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: () => ({ command: vi.fn(async () => null), state: null }) }))
vi.mock('../../../src/renderer/src/tools/toolsPanelStore', () => ({ useToolsPanelChrome: () => ({ pinnedThreadId: null }) }))
vi.mock('../../../src/renderer/src/tools/ToolsPanel', () => ({ ToolsPanel: () => null }))
vi.mock('../../../src/renderer/src/agents/ThreadWorkingCopy', () => ({ ThreadWorkingCopy: () => null, ThreadWorkingCopyNotice: () => null, describeWorkingCopy: () => ({}) }))
vi.mock('../../../src/renderer/src/tools/PaneTerminalDrawer', () => ({ PaneTerminalDrawer: ({ threadId, machine }: { threadId: string; machine?: string }) => <div data-drawer={threadId} data-machine={machine} />, hideDrawerFromInside: vi.fn() }))
vi.mock('../../../src/renderer/src/state/owlFeature', () => ({ useOwlFeature: () => owl.hosted }))

const owl = vi.hoisted(() => ({ hosted: false }))
type Row = { thread: { id: string; remoteHost?: boolean; hostId?: string }; project: undefined }
const rows: Row[] = [{ thread: { id: 'local' }, project: undefined }, { thread: { id: 'remote', remoteHost: true, hostId: 'forge-id' }, project: undefined }]
const paneState = { connections: [{ hostId: 'forge-id', name: 'forge', kind: 'remote', connected: true }] }
vi.mock('../../../src/renderer/src/agents/ThreadsView', () => ({
  // Every pane asks whether it has a Terminal drawer, and renders its drawer slot, as ThreadsView does.
  ThreadsView: ({ paneTools, paneTerminal, paneDrawer }: { paneTools: boolean; paneTerminal: (props: { row: Row }) => boolean; paneDrawer: (props: { row: Row; state: typeof paneState }) => ReactNode }) => <>
    {rows.map(row => <section key={row.thread.id} aria-label={row.thread.id} data-tools={paneTools || undefined} data-terminal={paneTerminal({ row }) || undefined}>{paneDrawer({ row, state: paneState })}</section>)}
  </>,
}))
afterEach(() => { cleanup(); owl.hosted = false })

describe('the thread workspace’s terminal drawers', () => {
  it('gives a thread on a paired host a drawer too on Owl, saying which machine its shells run on (ADR-0183)', () => {
    owl.hosted = true
    render(<ThreadWorkspace />)
    const remote = screen.getByRole('region', { name: 'remote' })
    expect(remote).toHaveAttribute('data-terminal')
    expect(remote.querySelector('[data-drawer="remote"]')).toHaveAttribute('data-machine', 'forge')
    expect(screen.getByRole('region', { name: 'local' }).querySelector('[data-drawer="local"]')).not.toHaveAttribute('data-machine')
  })
  it('offers a drawer on a local thread only where the feature is off: a thread on a paired host keeps its terminal on that machine', () => {
    render(<ThreadWorkspace />)
    expect(screen.getByRole('region', { name: 'local' })).toHaveAttribute('data-terminal')
    expect(screen.getByRole('region', { name: 'local' }).querySelector('[data-drawer="local"]')).not.toBeNull()
    expect(screen.getByRole('region', { name: 'remote' })).not.toHaveAttribute('data-terminal')
    expect(screen.getByRole('region', { name: 'remote' }).querySelector('[data-drawer]')).toBeNull()
    // Tools is the workspace's too: every pane's header carries it (ADR-0182).
    expect(screen.getByRole('region', { name: 'local' })).toHaveAttribute('data-tools')
  })
})
