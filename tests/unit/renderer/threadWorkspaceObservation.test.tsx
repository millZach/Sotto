import React, { StrictMode, useEffect, useRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommand } from '../../../src/shared/agents'
import { ThreadWorkspace } from '../../../src/renderer/src/agents/ThreadWorkspace'

const connection = vi.hoisted(() => ({ command: vi.fn<(command: AgentCommand) => Promise<null>>(async () => null), pin: 'pinned' as string | null }))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: () => ({ command: connection.command }) }))
vi.mock('../../../src/renderer/src/tools/toolsPanelStore', () => ({ useToolsPanelChrome: () => ({ pinnedThreadId: connection.pin }) }))
vi.mock('../../../src/renderer/src/tools/ToolsPanel', () => ({ ToolsPanel: () => null, ToolsPanelToggle: () => null }))
vi.mock('../../../src/renderer/src/agents/ThreadWorkingCopy', () => ({ ThreadWorkingCopy: () => null, ThreadWorkingCopyNotice: () => null }))
vi.mock('../../../src/renderer/src/agents/ThreadsView', () => ({
  // Match ThreadsView's observer lifecycle: changing the callback does not change visible panes,
  // and its page cleanup reports no panes through the most recently committed callback.
  ThreadsView: ({ onPaneThreadsChange }: { onPaneThreadsChange: (ids: readonly string[]) => void }) => {
    const observer = useRef(onPaneThreadsChange)
    const sent = useRef(false)
    useEffect(() => { observer.current = onPaneThreadsChange })
    useEffect(() => { if (!sent.current) { sent.current = true; observer.current(['visible']) } }, [])
    useEffect(() => () => observer.current([]), [])
    return null
  },
}))
beforeEach(() => { connection.command = vi.fn<(command: AgentCommand) => Promise<null>>(async () => null); connection.pin = 'pinned' })
afterEach(cleanup)

const observe = (threadIds: string[]): AgentCommand => ({ type: 'observe-threads', threadIds })

describe('thread workspace observation', () => {
  it('keeps the pinned thread when the command function changes without pane changes', () => {
    const { rerender, unmount } = render(<ThreadWorkspace onOpenAgents={() => undefined} />)
    expect(connection.command).toHaveBeenLastCalledWith(observe(['visible', 'pinned']))
    const previous = connection.command
    previous.mockClear()
    connection.command = vi.fn<(command: AgentCommand) => Promise<null>>(async () => null)
    rerender(<ThreadWorkspace onOpenAgents={() => undefined} />)
    expect(connection.command).toHaveBeenLastCalledWith(observe(['visible', 'pinned']))
    expect(connection.command.mock.calls).not.toContainEqual([observe([])])
    expect(previous).not.toHaveBeenCalled()
    unmount()
    expect(connection.command).toHaveBeenLastCalledWith(observe([]))
  })

  it('restores both visible and pinned observations after StrictMode setup and cleanup', () => {
    const { rerender, unmount } = render(<StrictMode><ThreadWorkspace onOpenAgents={() => undefined} /></StrictMode>)
    expect(connection.command).toHaveBeenLastCalledWith(observe(['visible', 'pinned']))
    connection.command = vi.fn<(command: AgentCommand) => Promise<null>>(async () => null)
    rerender(<StrictMode><ThreadWorkspace onOpenAgents={() => undefined} /></StrictMode>)
    expect(connection.command).toHaveBeenLastCalledWith(observe(['visible', 'pinned']))
    unmount()
    expect(connection.command).toHaveBeenLastCalledWith(observe([]))
  })

  it('updates the pin without changing visible panes or observing duplicate thread IDs', () => {
    const { rerender } = render(<ThreadWorkspace onOpenAgents={() => undefined} />)
    connection.pin = 'other'
    rerender(<ThreadWorkspace onOpenAgents={() => undefined} />)
    expect(connection.command).toHaveBeenLastCalledWith(observe(['visible', 'other']))
    connection.pin = 'visible'
    rerender(<ThreadWorkspace onOpenAgents={() => undefined} />)
    expect(connection.command).toHaveBeenLastCalledWith(observe(['visible']))
    connection.pin = null
    rerender(<ThreadWorkspace onOpenAgents={() => undefined} />)
    expect(connection.command).toHaveBeenLastCalledWith(observe(['visible']))
  })
})
