import { terminalBridgeFixture, terminalSession, fakeTerminalViews } from '../../../fixtures/renderer/terminalBridge'
import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalSession } from '../../../../src/shared/terminal'
import type { ToolsResult } from '../../../../src/shared/tools'
import { PaneTerminalDrawer } from '../../../../src/renderer/src/tools/PaneTerminalDrawer'
import { PaneTerminalToggle } from '../../../../src/renderer/src/tools/PaneTerminalToggle'
import { PaneTerminalChromeStore } from '../../../../src/renderer/src/tools/paneTerminalStore'
import { setDrawerShortcut } from '../../../../src/renderer/src/tools/paneTerminalShortcut'
import { TerminalStore } from '../../../../src/renderer/src/tools/terminalStore'

const workspace = { threadId: 'thread-a', projectId: 'workshop', workingDirectory: 'D:\\work\\workshop', workspaceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
const ID_1 = '11111111-1111-4111-8111-111111111111'
const ID_2 = '22222222-2222-4222-8222-222222222222'
const session = (id: string, patch: Partial<TerminalSession> = {}): TerminalSession =>
  terminalSession(id, workspace, { place: 'drawer', ...patch })
const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })

function fakeTerminal(initial: TerminalSession[] = []) {
  const published: ReturnType<typeof terminalBridgeFixture> = terminalBridgeFixture({ workspace, sessions: initial, commands: {
    list: vi.fn(async ({ threadId }) => ok({ workspace, sessions: published.sessions().filter(item => item.workspace.threadId === threadId) })),
    create: vi.fn(async ({ threadId }) => {
      const created = session(threadId === workspace.threadId ? ID_1 : ID_2, { workspace: { ...workspace, threadId } })
      published.setSessions([...published.sessions(), created])
      return ok({ session: created, output: 'PS D:\\work\\workshop> ', sequence: 1 })
    }),
    reopen: vi.fn(async ({ sessionId }) => ok({ session: published.sessions().find(item => item.id === sessionId)!, output: '', sequence: 0 })),
  } })
  return { ...published, emit: published.publish }
}

function fakeViews() {
  return fakeTerminalViews({ fit: { cols: 80, rows: 24 }, className: '' })
}

const thread = { id: 'thread-a', nativeSessionStarted: true as const, workingDirectory: 'D:\\work\\workshop', worktree: { status: 'ready' as const, mode: 'independent' as const, branch: 'feature/drawer', path: 'D:\\work\\workshop', repositoryRoot: 'D:\\work', dirty: false } }

function setup(terminal: ReturnType<typeof fakeTerminal>) {
  const chromeStore = new PaneTerminalChromeStore(null)
  const store = new TerminalStore('drawer')
  const { views, factory } = fakeViews()
  render(<div className="thread-pane" id="thread-pane-thread-a" data-thread-id="thread-a">
    <PaneTerminalToggle threadId="thread-a" store={chromeStore} />
    <div className="thread-workspace__compose"><textarea aria-label="Prompt" /></div>
    <PaneTerminalDrawer threadId="thread-a" thread={thread} project={undefined} bridge={terminal.bridge} viewFactory={factory} store={store} chromeStore={chromeStore} />
  </div>)
  return { chromeStore, store, views }
}

afterEach(() => { cleanup() })
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }) })
afterEach(() => { vi.unstubAllGlobals() })

describe('the pane terminal drawer', () => {
  it('toggles open and starts a shell on its own, with no empty "Start terminal" step', async () => {
    const terminal = fakeTerminal()
    setup(terminal)
    const toggle = screen.getByRole('button', { name: 'Terminal drawer' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    // A pressed toggle keeps its name; the title says what a press does now.
    expect(toggle).toHaveAccessibleName('Terminal drawer')
    expect(toggle).toHaveAttribute('title', 'Hide terminal drawer (Ctrl+J)')
    await waitFor(() => expect(terminal.bridge.create).toHaveBeenCalledWith({ threadId: 'thread-a', workspaceId: workspace.workspaceId, place: 'drawer' }))
    expect(await screen.findByRole('tab', { name: 'PowerShell', selected: true })).toBeInTheDocument()
    expect(screen.queryByText('No terminal is open for this thread.')).toBeNull()
  })

  it('starts a shell as wide as the drawer can show, so its first prompt is not cut off in a narrow pane', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
    try {
      const terminal = fakeTerminal()
      setup(terminal)
      await userEvent.click(screen.getByRole('button', { name: 'Terminal drawer' }))
      await waitFor(() => expect(terminal.bridge.create).toHaveBeenCalledWith(expect.objectContaining({ place: 'drawer', cols: 45, rows: 5 })))
    } finally {
      width.mockRestore()
    }
  })

  it('shows the thread’s branch and keeps the shell running when Hide is pressed', async () => {
    const terminal = fakeTerminal([session(ID_1)])
    setup(terminal)
    await userEvent.click(screen.getByRole('button', { name: 'Terminal drawer' }))
    await screen.findByRole('tab', { name: 'PowerShell', selected: true })
    expect(screen.getByText('feature/drawer')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Hide terminal drawer' }))
    expect(screen.queryByRole('tab', { name: 'PowerShell' })).toBeNull()
    expect(terminal.bridge.close).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Terminal drawer' })).toHaveAttribute('aria-pressed', 'false')
    // The pressed button left the page with the drawer; focus goes back to the composer.
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveFocus())
  })

  it('gives a drawer’s terminal the chord to pass to the page, and makes it follow the frosted room', async () => {
    const terminal = fakeTerminal([session(ID_1)])
    const { views } = setup(terminal)
    await userEvent.click(screen.getByRole('button', { name: 'Terminal drawer' }))
    await screen.findByRole('tab', { name: 'PowerShell', selected: true })
    await waitFor(() => expect(views).toHaveLength(1))
    const handlers = views[0]!.handlers
    expect(handlers.followsFrost).toBe(true)
    const key = (patch: Partial<KeyboardEvent>) => ({ key: 'j', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, ...patch }) as KeyboardEvent
    expect(handlers.isPageShortcut?.(key({}))).toBe(true)
    expect(handlers.isPageShortcut?.(key({ key: 'k' }))).toBe(false)
  })

  it('lets a terminal kept from an earlier drawer follow the shortcut in force now, not the one it was made under', async () => {
    const terminal = fakeTerminal([session(ID_1)])
    const chromeStore = new PaneTerminalChromeStore(null)
    const store = new TerminalStore('drawer')
    const { views, factory } = fakeViews()
    const drawer = () => <div className="thread-pane" id="thread-pane-thread-a" data-thread-id="thread-a">
      <PaneTerminalDrawer threadId="thread-a" thread={thread} project={undefined} bridge={terminal.bridge} viewFactory={factory} store={store} chromeStore={chromeStore} />
    </div>
    const first = render(drawer())
    act(() => chromeStore.setOpen('thread-a', true))
    await screen.findByRole('tab', { name: 'PowerShell', selected: true })
    await waitFor(() => expect(views).toHaveLength(1))
    const keepsItsView = views[0]!.handlers
    const ctrlJ = { key: 'j', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false } as KeyboardEvent
    // Dictation owned Ctrl+J while that drawer was on screen, so it went to the shell.
    act(() => setDrawerShortcut(null))
    expect(keepsItsView.isPageShortcut?.(ctrlJ)).toBe(false)
    // Leaving for Settings unmounts the drawer; the store keeps the terminal's view for when it comes back.
    first.unmount()
    render(drawer())
    await screen.findByRole('tab', { name: 'PowerShell', selected: true })
    expect(views).toHaveLength(1)
    // Back with dictation moved off Ctrl+J: the kept terminal hands the chord to the page again.
    expect(keepsItsView.isPageShortcut?.(ctrlJ)).toBe(true)
  })

  it('keeps each pane of a split to its own drawer and its own shells', async () => {
    const terminal = fakeTerminal()
    const chromeStore = new PaneTerminalChromeStore(null)
    const store = new TerminalStore('drawer')
    const { factory } = fakeViews()
    const other = { ...thread, id: 'thread-b' }
    render(<>
      {[thread, other].map(item => <section key={item.id} className="thread-pane" id={`thread-pane-${item.id}`} data-thread-id={item.id} aria-label={item.id}>
        <PaneTerminalToggle threadId={item.id} store={chromeStore} />
        <PaneTerminalDrawer threadId={item.id} thread={item} project={undefined} bridge={terminal.bridge} viewFactory={factory} store={store} chromeStore={chromeStore} />
      </section>)}
    </>)
    const [first, second] = screen.getAllByRole('button', { name: 'Terminal drawer' }) as [HTMLElement, HTMLElement]
    await userEvent.click(second)
    await waitFor(() => expect(terminal.bridge.create).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-b', place: 'drawer' })))
    expect(first).toHaveAttribute('aria-pressed', 'false')
    expect(within(screen.getByRole('region', { name: 'thread-a' })).queryByRole('tablist')).toBeNull()
    await userEvent.click(first)
    await waitFor(() => expect(terminal.bridge.create).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-a', place: 'drawer' })))
    expect(second).toHaveAttribute('aria-pressed', 'true')
    expect(document.querySelectorAll('.pane-terminal')).toHaveLength(2)
  })

  it('hides the drawer once its last shell is closed', async () => {
    const terminal = fakeTerminal([session(ID_1)])
    setup(terminal)
    await userEvent.click(screen.getByRole('button', { name: 'Terminal drawer' }))
    const tab = await screen.findByRole('tab', { name: 'PowerShell', selected: true })
    await userEvent.click(within(tab.parentElement!).getByRole('button', { name: 'Close PowerShell' }))
    await userEvent.click(screen.getByRole('button', { name: 'End terminal' }))
    await waitFor(() => expect(terminal.bridge.close).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Terminal drawer' })).toHaveAttribute('aria-pressed', 'false'))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveFocus())
  })

  it('resizes with the keyboard: arrows step, Home and End reach the bounds, double-click resets to a third', async () => {
    const terminal = fakeTerminal([session(ID_1)])
    setup(terminal)
    const pane = document.querySelector('.thread-pane') as HTMLElement
    Object.defineProperty(pane, 'clientHeight', { value: 600, configurable: true })
    await userEvent.click(screen.getByRole('button', { name: 'Terminal drawer' }))
    await screen.findByRole('tab', { name: 'PowerShell', selected: true })
    const divider = screen.getByRole('separator', { name: 'Resize terminal' })
    await waitFor(() => expect(divider).toHaveAttribute('aria-valuenow', '200'))
    divider.focus()
    await userEvent.keyboard('{ArrowUp}')
    expect(divider).toHaveAttribute('aria-valuenow', '224')
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(divider).toHaveAttribute('aria-valuenow', '176')
    await userEvent.keyboard('{Home}')
    expect(divider).toHaveAttribute('aria-valuenow', '120')
    await userEvent.keyboard('{End}')
    expect(divider).toHaveAttribute('aria-valuenow', '280')
    act(() => { divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(divider).toHaveAttribute('aria-valuenow', '200')
  })

  it('focuses the terminal once it opens and a request was made for it, as the keyboard shortcut asks', async () => {
    const terminal = fakeTerminal([session(ID_1)])
    const chromeStore = new PaneTerminalChromeStore(null)
    const store = new TerminalStore('drawer')
    const { views, factory } = fakeViews()
    chromeStore.requestFocus('thread-a')
    render(<div className="thread-pane">
      <PaneTerminalDrawer threadId="thread-a" thread={thread} project={undefined} bridge={terminal.bridge} viewFactory={factory} store={store} chromeStore={chromeStore} />
    </div>)
    act(() => chromeStore.setOpen('thread-a', true))
    await screen.findByRole('tab', { name: 'PowerShell', selected: true })
    await waitFor(() => expect(views[0]?.focused).toBe(1))
  })
})
