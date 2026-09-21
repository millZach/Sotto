import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalBridge, TerminalEvent, TerminalSession, TerminalSnapshot } from '../../../../src/shared/terminal'
import type { ToolsResult } from '../../../../src/shared/tools'
import { ToolsPanel } from '../../../../src/renderer/src/tools/ToolsPanel'
import type { TerminalViewFactory, TerminalViewHandlers } from '../../../../src/renderer/src/tools/terminalStore'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { threadsStateFixture } from '../liveAgentState'
import { TOKEN_A, fakeFilesBridge, text } from './fakeFilesBridge'

vi.mock('../../../../src/renderer/src/tools/terminalView', () => { throw new Error('Chunk unavailable') })

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const workspace = { threadId: 'visual-gate', projectId: 'workshop', workingDirectory: 'D:\\work\\workshop', workspaceId: TOKEN_A }
const ID_1 = '11111111-1111-4111-8111-111111111111'
const ID_2 = '22222222-2222-4222-8222-222222222222'
const session = (id: string, patch: Partial<TerminalSession> = {}): TerminalSession =>
  ({ id, workspace, title: 'PowerShell', shell: 'pwsh.exe', status: 'running', cols: 80, rows: 24, exitCode: null, createdAt: 1, ...patch })
const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })

/** Main's terminal service as the renderer sees it: sessions, snapshots, and one event stream. */
function fakeTerminal(initial: TerminalSession[], snapshots: Record<string, TerminalSnapshot> = {}) {
  let sessions = initial
  const listeners = new Set<(event: TerminalEvent) => void>()
  const pendingRead: { release: (() => void) | null } = { release: null }
  const hold = { read: false }
  const bridge: TerminalBridge = {
    list: vi.fn(async () => ok({ workspace, sessions })),
    create: vi.fn(async () => {
      const created = session(ID_2)
      sessions = [...sessions, created]
      return ok({ session: created, output: 'PS D:\\work\\workshop> ', sequence: 1 })
    }),
    read: vi.fn(async ({ sessionId }) => {
      if (hold.read) await new Promise<void>(resolve => { pendingRead.release = resolve })
      return ok(snapshots[sessionId] ?? { session: sessions.find(item => item.id === sessionId)!, output: '', sequence: 0 })
    }),
    write: vi.fn(async () => ok(undefined)),
    resize: vi.fn(async () => ok(undefined)),
    interrupt: vi.fn(async () => ok(undefined)),
    close: vi.fn(async ({ sessionId }) => { sessions = sessions.filter(item => item.id !== sessionId); return ok(undefined) }),
    reopen: vi.fn(async ({ sessionId }) => {
      const reopened = session(sessionId)
      sessions = sessions.map(item => item.id === sessionId ? reopened : item)
      return ok({ session: reopened, output: 'PS D:\\work\\workshop> ', sequence: 0 })
    }),
    onEvent: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  return { bridge, hold, pendingRead, emit: (event: TerminalEvent) => { for (const listener of [...listeners]) listener(event) } }
}

/** A stand-in for xterm that records what it was asked to draw. */
function fakeViews() {
  const views: { handlers: TerminalViewHandlers; written: string[]; input: boolean[]; mounts: number; unmounts: number; focused: number; disposed: boolean }[] = []
  const factory: TerminalViewFactory = handlers => {
    const record = { handlers, written: [] as string[], input: [] as boolean[], mounts: 0, unmounts: 0, focused: 0, disposed: false }
    views.push(record)
    return {
      mount: container => { record.mounts += 1; container.replaceChildren(Object.assign(document.createElement('pre'), { className: 'fake-xterm' })) },
      unmount: () => { record.unmounts += 1 },
      write: (data, done) => { record.written.push(data); done?.() },
      reset: () => { record.written.push('<reset>') },
      setInputEnabled: enabled => { record.input.push(enabled) },
      fit: () => ({ cols: 100, rows: 30 }),
      focus: () => { record.focused += 1 },
      dispose: () => { record.disposed = true },
    }
  }
  return { views, factory }
}

function setup(terminal: ReturnType<typeof fakeTerminal>) {
  const store = new ToolsPanelStore()
  store.setOpen(true)
  store.setSurface('terminal')
  const { views, factory } = fakeViews()
  const files = fakeFilesBridge({ 'visual-gate': { root: 'D:\\work\\workshop', token: TOKEN_A, tree: { 'a.txt': { kind: 'file', content: text('a') } } } })
  render(<ToolsPanel focusedThreadId="visual-gate" state={threadsStateFixture()} files={files} terminal={terminal.bridge} terminalView={factory} store={store} />)
  return { store, views }
}

const panel = () => screen.getByRole('complementary', { name: 'Tools' })
const output = (id: string, sequence: number, data: string): TerminalEvent => ({ type: 'output', threadId: 'visual-gate', workspaceId: TOKEN_A, sessionId: id, data, sequence })

describe('Terminal surface', () => {
  it('reports a failed terminal view without leaving a running session busy', async () => {
    const terminal = fakeTerminal([session(ID_1)])
    const store = new ToolsPanelStore()
    store.setOpen(true)
    store.setSurface('terminal')
    render(<ToolsPanel focusedThreadId="visual-gate" state={threadsStateFixture()} terminal={terminal.bridge} store={store} />)
    expect(await screen.findByText('The terminal view could not load. Your terminal and its output are still here.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload window' })).toBeEnabled()
    expect(screen.getByLabelText('PowerShell, terminal')).not.toHaveAttribute('aria-busy', 'true')
    expect(terminal.bridge.close).not.toHaveBeenCalled()
    expect(terminal.bridge.reopen).not.toHaveBeenCalled()
    expect(terminal.bridge.create).not.toHaveBeenCalled()
  })

  it('replays the snapshot with input off, then applies only newer output in order', async () => {
    const terminal = fakeTerminal([session(ID_1)], { [ID_1]: { session: session(ID_1), output: 'old output', sequence: 5 } })
    terminal.hold.read = true
    const { views } = setup(terminal)
    await within(panel()).findByRole('tab', { name: 'PowerShell' })
    await waitFor(() => expect(terminal.bridge.read).toHaveBeenCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A, sessionId: ID_1 }))
    // Subscribed before reading, so nothing printed during the read is lost.
    expect(vi.mocked(terminal.bridge.onEvent).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(terminal.bridge.read).mock.invocationCallOrder[0]!)
    expect(within(panel()).getByText('Restoring output…')).toBeInTheDocument()
    act(() => { terminal.emit(output(ID_1, 7, ' seven')); terminal.emit(output(ID_1, 5, ' duplicate')); terminal.emit(output(ID_1, 6, ' six')) })
    views[0]!.handlers.onInput('typed during replay')
    expect(terminal.bridge.write).not.toHaveBeenCalled()

    await act(async () => { terminal.pendingRead.release?.() })
    expect(views[0]!.written).toEqual(['<reset>', 'old output', ' six', ' seven'])
    expect(views[0]!.input.at(-1)).toBe(true)
    expect(within(panel()).queryByText('Restoring output…')).toBeNull()
    act(() => { terminal.emit(output(ID_1, 7, ' again')); terminal.emit(output(ID_1, 8, ' eight')) })
    expect(views[0]!.written.slice(-1)).toEqual([' eight'])

    views[0]!.handlers.onInput('dir\r')
    await waitFor(() => expect(terminal.bridge.write).toHaveBeenCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A, sessionId: ID_1, data: 'dir\r' }))
    views[0]!.handlers.onInterrupt()
    expect(terminal.bridge.interrupt).toHaveBeenCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A, sessionId: ID_1 })
    expect(terminal.bridge.resize).toHaveBeenCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A, sessionId: ID_1, cols: 100, rows: 30 })
  })

  it('starts a terminal from the empty state and keeps it running when the surface is hidden', async () => {
    const terminal = fakeTerminal([])
    const { store, views } = setup(terminal)
    await userEvent.click(await within(panel()).findByRole('button', { name: 'Start terminal' }))
    expect(terminal.bridge.create).toHaveBeenCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A })
    expect(await within(panel()).findByRole('tab', { name: 'PowerShell', selected: true })).toBeInTheDocument()
    expect(views[0]!.written).toEqual(['<reset>', 'PS D:\\work\\workshop> '])
    expect(views[0]!.focused).toBe(1)

    act(() => store.setSurface('files'))
    expect(views[0]!.unmounts).toBe(1)
    act(() => store.setOpen(false))
    act(() => { store.setOpen(true); store.setSurface('terminal') })
    await within(panel()).findByRole('tab', { name: 'PowerShell' })
    expect(terminal.bridge.close).not.toHaveBeenCalled()
    expect(views).toHaveLength(1)
    expect(views[0]!.mounts).toBe(2)
    // The retained screen is shown again without reading its output a second time.
    expect(terminal.bridge.read).not.toHaveBeenCalled()
  })

  it('offers Reopen for an ended session and asks before closing a running one', async () => {
    const terminal = fakeTerminal([session(ID_1, { status: 'interrupted' }), session(ID_2, { title: 'cmd' })])
    setup(terminal)
    const ended = await within(panel()).findByRole('tab', { name: 'PowerShell, Ended when Sotto closed' })
    await userEvent.click(ended)
    expect(within(panel()).getByText('Ended when Sotto closed.')).toBeInTheDocument()
    expect(within(panel()).queryByRole('button', { name: 'Send Ctrl+C' })).toBeNull()
    await userEvent.click(within(panel()).getByRole('button', { name: 'Reopen' }))
    expect(terminal.bridge.reopen).toHaveBeenCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A, sessionId: ID_1 })
    expect(await within(panel()).findByRole('tab', { name: 'PowerShell', selected: true })).toBeInTheDocument()

    const cmd = within(panel()).getByRole('tab', { name: 'cmd' })
    cmd.focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(within(panel()).getByRole('tab', { name: 'PowerShell' })).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(cmd).toHaveFocus()
    await userEvent.click(within(panel()).getByRole('button', { name: 'Close cmd' }))
    const confirm = within(panel()).getByRole('group', { name: 'Close cmd' })
    expect(within(confirm).getByRole('button', { name: 'End terminal' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(within(panel()).queryByRole('group', { name: 'Close cmd' })).toBeNull()
    expect(terminal.bridge.close).not.toHaveBeenCalled()
    expect(cmd).toHaveFocus()

    await userEvent.click(within(panel()).getByRole('button', { name: 'Close cmd' }))
    await userEvent.click(within(panel()).getByRole('button', { name: 'End terminal' }))
    await waitFor(() => expect(within(panel()).queryByRole('tab', { name: 'cmd' })).toBeNull())
    expect(terminal.bridge.close).toHaveBeenCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A, sessionId: ID_2 })
    expect(within(panel()).getByRole('tab', { name: 'PowerShell', selected: true })).toHaveFocus()
  })

  it('follows session and closed events from main', async () => {
    const terminal = fakeTerminal([session(ID_1), session(ID_2, { title: 'cmd' })])
    const { views } = setup(terminal)
    await within(panel()).findByRole('tab', { name: 'cmd', selected: true })
    await waitFor(() => expect(views[0]?.input.at(-1)).toBe(true))
    act(() => terminal.emit({ type: 'session', session: session(ID_2, { title: 'cmd', status: 'exited', exitCode: 1 }) }))
    expect(within(panel()).getByRole('tab', { name: 'cmd, Exited with code 1' })).toBeInTheDocument()
    expect(views[0]!.input.at(-1)).toBe(false)
    act(() => terminal.emit({ type: 'closed', threadId: 'visual-gate', workspaceId: TOKEN_A, sessionId: ID_2 }))
    expect(within(panel()).queryByRole('tab', { name: /cmd/u })).toBeNull()
    expect(views[0]!.disposed).toBe(true)
    expect(within(panel()).getByRole('tab', { name: 'PowerShell', selected: true })).toBeInTheDocument()
  })
})
