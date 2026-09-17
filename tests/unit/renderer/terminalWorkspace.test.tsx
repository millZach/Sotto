import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import type { TerminalOpenRequest, TerminalWorkspaceBridge, WorkspaceTerminal, WorkspaceTerminalEvent } from '../../../src/shared/terminalWorkspace'
import type { ToolsResult } from '../../../src/shared/tools'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { SIDEBAR_MODE_KEY } from '../../../src/renderer/src/agents/SidebarFrame'
import { SplitLayoutStore } from '../../../src/renderer/src/agents/splitLayout'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { TerminalWorkspaceStore } from '../../../src/renderer/src/terminals/terminalWorkspaceStore'
import type { TerminalViewFactory, TerminalViewHandlers } from '../../../src/renderer/src/tools/terminalStore'
import { liveAgentState, threadsStateFixture } from './liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const WIDE = 1400
const ID_1 = '11111111-1111-4111-8111-111111111111'
const ID_2 = '22222222-2222-4222-8222-222222222222'
const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })

function terminal(id: string, patch: Partial<WorkspaceTerminal> = {}): WorkspaceTerminal {
  return {
    id, projectId: 'workshop', title: 'Build', launch: { provider: 'claude', modelId: 'claude:sonnet', reasoning: null, permission: 'ask' },
    workingCopy: 'shared', workingDirectory: 'C:/workshop', branch: 'main', command: 'claude --model claude:sonnet', status: 'running', cols: 80, rows: 24,
    exitCode: null, openedAt: NOW - 4 * 60_000, closedAt: null, ...patch,
  }
}

/** Main's terminal workspace as the renderer sees it: a listing, snapshots, and one event stream. */
function fakeBridge(initial: WorkspaceTerminal[]) {
  let terminals = initial
  let next = 0
  const listeners = new Set<(event: WorkspaceTerminalEvent) => void>()
  const find = (id: string): WorkspaceTerminal => terminals.find(item => item.id === id)!
  const bridge: TerminalWorkspaceBridge = {
    list: vi.fn(async () => ok({ terminals, shell: 'pwsh' })),
    open: vi.fn(async (request: TerminalOpenRequest) => {
      next += 1
      const opened = terminal([ID_1, ID_2, '33333333-3333-4333-8333-333333333333'][next - 1] ?? ID_2, { title: request.title, launch: request.launch, workingCopy: request.workingCopy, openedAt: NOW })
      terminals = [...terminals, opened]
      return ok({ terminal: opened, output: 'Opened by Sotto at C:/workshop · claude\r\n', sequence: 1 })
    }),
    read: vi.fn(async ({ id }) => ok({ terminal: find(id), output: '', sequence: 0 })),
    write: vi.fn(async () => ok(undefined)),
    resize: vi.fn(async () => ok(undefined)),
    interrupt: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    restart: vi.fn(async ({ id }) => {
      const restarted = { ...find(id), status: 'running' as const, closedAt: null, exitCode: null }
      terminals = terminals.map(item => item.id === id ? restarted : item)
      return ok({ terminal: restarted, output: '', sequence: 0 })
    }),
    close: vi.fn(async ({ id }) => {
      terminals = terminals.map(item => item.id === id ? { ...item, status: 'exited' as const, closedAt: NOW } : item)
      for (const listener of [...listeners]) listener({ type: 'terminal', terminal: find(id) })
      return ok(undefined)
    }),
    pasteImage: vi.fn(async () => ok({ path: 'C:\\workshop\\.sotto\\clipboard\\20260916-101010-abcdef12.png' })),
    onEvent: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  return { bridge, emit: (event: WorkspaceTerminalEvent) => { for (const listener of [...listeners]) listener(event) } }
}

/** A stand-in for xterm that records what it was asked to draw. */
function fakeViews() {
  const views: { handlers: TerminalViewHandlers; written: string[]; input: boolean[]; focused: number }[] = []
  const factory: TerminalViewFactory = handlers => {
    const record = { handlers, written: [] as string[], input: [] as boolean[], focused: 0 }
    views.push(record)
    return {
      mount: container => { container.replaceChildren(Object.assign(document.createElement('textarea'), { className: 'fake-xterm' })) },
      unmount: () => {},
      write: (data, done) => { record.written.push(data); done?.() },
      reset: () => { record.written.push('<reset>') },
      setInputEnabled: enabled => { record.input.push(enabled) },
      fit: () => ({ cols: 100, rows: 30 }),
      focus: () => { record.focused += 1 },
      dispose: () => {},
    }
  }
  return { views, factory }
}

function mount(initial: WorkspaceTerminal[] = [], options: { readonly mode?: 'threads' | 'terminals'; readonly bridge?: boolean } = {}) {
  localStorage.setItem(SIDEBAR_MODE_KEY, options.mode ?? 'terminals')
  const state = threadsStateFixture()
  state.assignments = []
  state.queue = []
  const live = liveAgentState(state)
  const command = vi.fn(async (request: AgentCommand): Promise<AgentState | null> => live.command(request))
  vi.mocked(useAgents).mockImplementation(() => ({ ...live.useLive(), command }))
  const fake = fakeBridge(initial)
  const { views, factory } = fakeViews()
  const store = new TerminalWorkspaceStore()
  const terminals = { store, bridge: options.bridge === false ? undefined : fake.bridge, viewFactory: factory, layoutStore: new SplitLayoutStore(), platform: 'win32' }
  render(<ThreadsView onOpenAgents={vi.fn()} now={NOW} layoutStore={new SplitLayoutStore()} paneAreaWidth={WIDE} terminals={terminals} />)
  return { ...fake, views, store, command }
}

const sidebar = (name = 'Terminal sidebar') => screen.getByRole('complementary', { name })
const search = () => screen.getByRole('searchbox') as HTMLInputElement
const modeSwitch = () => within(screen.getByRole('radiogroup', { name: 'Sidebar mode' }))
const panes = () => within(screen.getByRole('group', { name: 'Terminal panes' })).getAllByRole('region')

beforeEach(() => { vi.mocked(useAgents).mockReset(); localStorage.clear() })
afterEach(() => { cleanup(); localStorage.clear() })

describe('Terminal mode', () => {
  it('switches the sidebar between threads and terminals, changing only the rows, the search and the shelf', async () => {
    mount([terminal(ID_1)], { mode: 'threads' })
    expect(sidebar('Thread sidebar')).toBeInTheDocument()
    expect(search().placeholder).toBe('Search threads')
    expect(within(sidebar('Thread sidebar')).getByRole('button', { name: /^Settled/ })).toBeInTheDocument()
    expect(modeSwitch().getByRole('radio', { name: 'Threads' })).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(modeSwitch().getByRole('radio', { name: 'Terminal' }))
    expect(within(sidebar()).getByRole('heading', { level: 1, name: 'Threads' })).toBeInTheDocument()
    expect(search().placeholder).toBe('Search terminals')
    expect(within(sidebar()).getByRole('button', { name: /^Closed/ })).toBeInTheDocument()
    expect(within(sidebar()).queryByRole('button', { name: /^Settled/ })).toBeNull()
    expect(await within(sidebar()).findByRole('button', { name: 'Build' })).toHaveTextContent('4 min')
    expect(within(sidebar()).queryByRole('button', { name: 'Visual gate flake' })).toBeNull()
    expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe('terminals')

    fireEvent.click(modeSwitch().getByRole('radio', { name: 'Threads' }))
    expect(search().placeholder).toBe('Search threads')
    expect(within(sidebar('Thread sidebar')).getByRole('button', { name: 'Visual gate flake' })).toBeInTheDocument()
  })

  it('opens a provider terminal from the dialog with the mapped command in the Runs box, then shows its pane', async () => {
    const view = mount()
    await waitFor(() => expect(view.store.getSnapshot().shell).toBe('pwsh'))
    fireEvent.click(within(sidebar()).getByRole('button', { name: 'New terminal' }))
    const dialog = screen.getByRole('dialog', { name: 'New terminal' })
    fireEvent.click(within(dialog).getByRole('button', { name: /workshop/ }))
    const name = within(dialog).getByLabelText('Terminal name')
    expect(within(dialog).getByRole('button', { name: 'Open terminal' })).toBeDisabled()
    expect(within(dialog).getByRole('combobox', { name: 'Terminal provider' })).toHaveValue('claude')
    expect(within(dialog).getByLabelText('Runs')).toHaveTextContent('claude --model claude:sonnet')

    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Terminal permissions' }), { target: { value: 'everything' } })
    expect(within(dialog).getByLabelText('Runs')).toHaveTextContent('claude --model claude:sonnet --dangerously-skip-permissions')
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Terminal provider' }), { target: { value: 'codex' } })
    expect(within(dialog).getByLabelText('Runs')).toHaveTextContent('codex -m codex:gpt')
    expect(within(dialog).getByRole('combobox', { name: 'Terminal permissions' })).toHaveValue('ask')
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Terminal provider' }), { target: { value: '' } })
    expect(within(dialog).getByLabelText('Runs')).toHaveTextContent('pwsh')
    expect(within(dialog).queryByRole('combobox', { name: 'Terminal permissions' })).toBeNull()
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Terminal provider' }), { target: { value: 'claude' } })

    // A terminal opens in the project folder unless a worktree is chosen on purpose.
    expect(within(dialog).getByRole('radio', { name: 'Project folder' })).toBeChecked()
    fireEvent.click(within(dialog).getByRole('radio', { name: 'New worktree' }))
    fireEvent.change(name, { target: { value: 'Build' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Open terminal' })) })
    expect(view.bridge.open).toHaveBeenCalledWith({ projectId: 'workshop', title: 'Build', workingCopy: 'independent', launch: { provider: 'claude', modelId: 'claude:sonnet', reasoning: null, permission: 'ask' } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const pane = await screen.findByRole('region', { name: 'Build' })
    expect(within(pane).getByRole('heading', { level: 2, name: 'Build' })).toBeInTheDocument()
    expect(within(pane).getByText('workshop · Worktree')).toBeInTheDocument()
    expect(within(pane).getByText('main')).toBeInTheDocument()
    expect(within(pane).getByText(/Ctrl\+C copies a selection or interrupts · Ctrl\+V pastes/)).toBeInTheDocument()
    await waitFor(() => expect(view.views[0]!.written).toEqual(['<reset>', 'Opened by Sotto at C:/workshop · claude\r\n']))
    expect(view.views[0]!.input.at(-1)).toBe(true)
    expect(view.views[0]!.focused).toBe(1)
    expect(within(sidebar()).getByRole('button', { name: 'Build' })).toHaveAttribute('aria-current', 'page')
  })

  it('shows two terminals side by side, focuses the one clicked, and closing a pane keeps the terminal running', async () => {
    const view = mount([terminal(ID_1, { title: 'Build' }), terminal(ID_2, { title: 'Tests' })])
    fireEvent.click(await within(sidebar()).findByRole('button', { name: 'Build' }))
    await screen.findByRole('region', { name: 'Build' })
    fireEvent.click(within(sidebar()).getByRole('button', { name: 'Open Tests beside' }))
    expect(panes().map(pane => pane.getAttribute('aria-label'))).toEqual(['Build', 'Tests'])
    expect(screen.getByRole('separator')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Tests' })).toHaveAttribute('data-focused')

    fireEvent.pointerDown(within(screen.getByRole('region', { name: 'Build' })).getByRole('heading', { level: 2, name: 'Build' }))
    expect(screen.getByRole('region', { name: 'Build' })).toHaveAttribute('data-focused')
    expect(screen.getByRole('region', { name: 'Tests' })).not.toHaveAttribute('data-focused')
    expect(within(sidebar()).getByRole('button', { name: 'Build' })).toHaveAttribute('aria-current', 'page')
    expect(within(sidebar()).getByRole('button', { name: 'Tests' }).closest('li')).toHaveAttribute('data-open')

    await act(async () => { fireEvent.click(within(screen.getByRole('region', { name: 'Tests' })).getByRole('button', { name: 'Close Tests pane' })) })
    expect(screen.queryByRole('separator')).toBeNull()
    expect(screen.getByRole('region', { name: 'Build' })).toBeInTheDocument()
    expect(view.bridge.close).not.toHaveBeenCalled()
    expect(within(sidebar()).getByRole('button', { name: 'Tests' })).toBeInTheDocument()
  })

  it('closes a terminal to the Closed shelf and reopens it from there', async () => {
    const view = mount([terminal(ID_1, { title: 'Build' })])
    fireEvent.click(await within(sidebar()).findByRole('button', { name: 'Build' }))
    await screen.findByRole('region', { name: 'Build' })
    await act(async () => { fireEvent.click(within(sidebar()).getByRole('button', { name: 'Close Build' })) })
    expect(view.bridge.close).toHaveBeenCalledWith({ id: ID_1 })
    expect(screen.queryByRole('region', { name: 'Build' })).toBeNull()
    fireEvent.click(within(sidebar()).getByRole('button', { name: /^Closed/ }))
    const shelf = within(sidebar()).getByRole('region', { name: 'Closed' })
    expect(within(shelf).getByRole('button', { name: 'Build' })).toHaveTextContent('Closed')
    await act(async () => { fireEvent.click(within(shelf).getByRole('button', { name: 'Reopen Build' })) })
    expect(view.bridge.restart).toHaveBeenCalledWith({ id: ID_1 })
    expect(await screen.findByRole('region', { name: 'Build' })).toBeInTheDocument()
  })

  it('saves a pasted image through main and shows where it went', async () => {
    const view = mount([terminal(ID_1, { title: 'Build' })])
    fireEvent.click(await within(sidebar()).findByRole('button', { name: 'Build' }))
    await screen.findByRole('region', { name: 'Build' })
    await waitFor(() => expect(view.views[0]!.input.at(-1)).toBe(true))
    await act(async () => { view.views[0]!.handlers.onPasteImage?.('data:image/png;base64,iVBORw0KGgo=') })
    expect(view.bridge.pasteImage).toHaveBeenCalledWith({ id: ID_1, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' })
    expect(await screen.findByRole('status', { name: '' })).toHaveTextContent('Image saved · 20260916-101010-abcdef12.png')
  })

  it('says so when the window has no terminal bridge', async () => {
    mount([], { bridge: false })
    expect(await screen.findByRole('heading', { level: 2, name: 'Terminal is not available in this window.' })).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Terminal workspace' })).getByRole('button', { name: 'New terminal' })).toBeDisabled()
  })
})
