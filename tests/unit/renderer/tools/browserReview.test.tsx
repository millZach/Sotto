import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridge, BrowserCapture, BrowserEvent, BrowserPage, BrowserTask } from '../../../../src/shared/browser'
import type { ToolsResult } from '../../../../src/shared/tools'
import { BrowserTaskDetails } from '../../../../src/renderer/src/tools/BrowserTaskDetails'
import { BrowserPlayer } from '../../../../src/renderer/src/tools/BrowserPlayer'
import { BrowserStore } from '../../../../src/renderer/src/tools/browserStore'
import { BROWSER_PLAYER_MIN_WIDTH, BROWSER_PLAYER_MOVE_STEP, BROWSER_PLAYER_MOVE_STEP_LARGE, BrowserPlayerStore } from '../../../../src/renderer/src/tools/browserPlayerStore'
import { appendBrowserFeedback, BrowserFeedback } from '../../../../src/renderer/src/tools/BrowserFeedback'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { ToolsPanelToggle } from '../../../../src/renderer/src/tools/ToolsPanel'
import { ThreadDraftStore } from '../../../../src/renderer/src/agents/threadDraftStore'
import { threadsStateFixture } from '../../../fixtures/renderer/liveAgentState'
import { handleOf } from '../../../fixtures/stagedImages'
import type { AgentAttachmentStageRequest } from '../../../../src/shared/agents'

const workspace = { threadId: 'visual-gate', projectId: 'workshop', workingDirectory: 'D:/work', workspaceId: 'workspace' }
const page: BrowserPage = { id: '11111111-1111-4111-8111-111111111111', workspace, url: 'http://localhost:5173/', title: 'Preview', status: 'ready', error: null, canGoBack: false, canGoForward: false }
const image = 'data:image/png;base64,YWJj'
const capture: BrowserCapture = { image, url: page.url, width: 1280, height: 800, element: null }
const task = (patch: Partial<BrowserTask> = {}): BrowserTask => ({ id: '22222222-2222-4222-8222-222222222222', threadId: workspace.threadId, workspaceId: workspace.workspaceId, pageId: page.id, status: 'working', description: 'Checking the form', steps: [], thumbnail: image, summary: null, unchecked: [], updatedAt: 1, pendingAction: null, output: null, ...patch })
const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })
function fake(initial: BrowserTask[] = [task()]) {
  const listeners = new Set<(event: BrowserEvent) => void>()
  const bridge: BrowserBridge = {
    tasks: vi.fn(async () => ok(initial)), list: vi.fn(async () => ok({ workspace, pages: [page] })),
    create: vi.fn(async () => ok(page)), navigate: vi.fn(async () => ok(page)), back: vi.fn(async () => ok(page)), forward: vi.fn(async () => ok(page)), reload: vi.fn(async () => ok(page)), close: vi.fn(async () => ok(undefined)), mount: vi.fn(async () => ok(undefined)),
    share: vi.fn(async () => ok(page)), viewport: vi.fn(async () => ok(page)), capture: vi.fn(async () => ok(capture)),
    controlTask: vi.fn(async request => ok(task({ status: request.control === 'pause' ? 'paused' : 'working', updatedAt: Date.now() }))),
    answerAction: vi.fn(async () => ok(task())), stopGrant: vi.fn(async () => ok(undefined)), openLink: vi.fn(async () => ok({ destination: 'external' as const })),
    onEvent: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  return { bridge, emit: (event: BrowserEvent) => listeners.forEach(listener => listener(event)) }
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('the browser player', () => {
  it('does not measure a placement without a task, while hidden, or while docked', async () => {
    const browser = fake([]); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    const geometry = vi.spyOn(playerStore, 'rectFor')
    render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    await act(async () => { await Promise.resolve() })
    expect(geometry).not.toHaveBeenCalled()
    act(() => browser.emit({ type: 'task', task: task() }))
    await screen.findByRole('complementary', { name: 'Browser for Visual gate flake' })
    expect(geometry).toHaveBeenCalled()
    geometry.mockClear()
    act(() => playerStore.hide('visual-gate'))
    act(() => browser.emit({ type: 'task', task: task({ summary: 'Still working', updatedAt: 2 }) }))
    expect(geometry).not.toHaveBeenCalled()
    act(() => playerStore.restore('visual-gate'))
    await act(async () => { await store.browser.activate(browser.bridge, 'visual-gate'); store.browser.select('visual-gate', page.id) })
    geometry.mockClear()
    act(() => { store.setSurface('browser'); store.setOpen(true) })
    expect(geometry).not.toHaveBeenCalled()
    expect(screen.queryByRole('complementary', { name: /Browser for/ })).not.toBeInTheDocument()
  })

  it('keeps the live page mounted across task events and changes it only when the page changes', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 800, y: 300, width: 340, height: 200 }))
    const browser = fake(), store = new ToolsPanelStore(), playerStore = new BrowserPlayerStore()
    render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    await waitFor(() => expect(browser.bridge.mount).toHaveBeenCalledWith(expect.objectContaining({ pageId: page.id, bounds: expect.any(Object) })))
    vi.mocked(browser.bridge.mount).mockClear()
    act(() => browser.emit({ type: 'task', task: task({ summary: 'Checked the form', updatedAt: 2 }) }))
    expect(browser.bridge.mount).not.toHaveBeenCalled()
    const nextPage = { ...page, id: '33333333-3333-4333-8333-333333333333' }
    act(() => {
      browser.emit({ type: 'page', page: nextPage })
      browser.emit({ type: 'task', task: task({ pageId: nextPage.id, updatedAt: 3 }) })
    })
    expect(browser.bridge.mount).toHaveBeenCalledWith(expect.objectContaining({ pageId: page.id, bounds: null }))
    expect(browser.bridge.mount).toHaveBeenCalledWith(expect.objectContaining({ pageId: nextPage.id, bounds: expect.any(Object) }))
  })
  it('asks for no remote host thread\'s tasks, and survives a bridge that refuses a thread outright', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    const state = threadsStateFixture()
    const [local, ...others] = state.host.threads
    state.host.threads = [local!, ...others.map(thread => ({ ...thread, remoteHost: true }))]
    // The preload throws, before any promise, for a thread on a host this computer does not run.
    vi.mocked(browser.bridge.tasks!).mockImplementation(request => { if (request.threadId !== local!.id) throw new Error('This action runs on the host machine. Open it there.'); return Promise.resolve(ok([task()])) })
    render(<BrowserPlayer state={state} focusedThreadId={local!.id} bridge={browser.bridge} store={store} playerStore={playerStore} />)
    await waitFor(() => expect(browser.bridge.tasks).toHaveBeenCalled())
    expect(vi.mocked(browser.bridge.tasks!).mock.calls.map(([request]) => request.threadId)).toEqual([local!.id])
    const refusing = new ToolsPanelStore()
    expect(() => refusing.browser.watchTasks(browser.bridge, [others[0]!.id])).not.toThrow()
  })
  it('shows only the focused thread’s task, and never a pinned one (#331)', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    const { rerender } = render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="another-thread" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    await waitFor(() => expect(store.browser.taskSnapshot()).toHaveLength(1))
    expect(screen.queryByRole('complementary', { name: /Browser for/ })).not.toBeInTheDocument()
    // Pinning Tools to visual-gate used to be enough to show its preview in every pane; the player ignores the pin entirely.
    act(() => store.pin('visual-gate'))
    expect(screen.queryByRole('complementary', { name: /Browser for/ })).not.toBeInTheDocument()
    act(() => store.unpin())
    rerender(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    expect(screen.getByRole('complementary', { name: 'Browser for Visual gate flake' })).toBeInTheDocument()
  })
  it('does not ask this computer’s browser about a thread on another host', async () => {
    const browser = fake([])
    const remoteId = 'host:00000000-0000-4000-8000-000000000099:remote-thread'
    browser.bridge.tasks = vi.fn(async (request: { threadId: string }) => {
      if (request.threadId === remoteId) throw new Error('This action belongs to another host. Select that host before trying again.')
      return ok([])
    })
    const state = threadsStateFixture()
    const sample = state.host.threads[0]!
    state.host.threads = [...state.host.threads, { ...sample, id: remoteId, remoteHost: true, title: 'On DGX' }]
    const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    render(<BrowserPlayer state={state} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    await waitFor(() => expect(browser.bridge.tasks).toHaveBeenCalled())
    const asked = vi.mocked(browser.bridge.tasks).mock.calls.map(call => call[0].threadId)
    expect(asked).toContain('visual-gate')
    expect(asked).not.toContain(remoteId)
  })
  it('keeps listing the other threads when one browser subscription throws', () => {
    const store = new BrowserStore()
    const tasks = vi.fn((request: { threadId: string }) => {
      if (request.threadId === 'foreign') throw new Error('This action belongs to another host. Select that host before trying again.')
      return Promise.resolve(ok([]))
    })
    const bridge: BrowserBridge = { ...fake([]).bridge, tasks }
    expect(() => store.watchTasks(bridge, ['foreign', 'local'])).not.toThrow()
    expect(tasks.mock.calls.map(call => call[0].threadId)).toEqual(['foreign', 'local'])
    tasks.mockClear()
    store.watchTasks(bridge, ['foreign', 'local'])
    expect(tasks.mock.calls.map(call => call[0].threadId)).toEqual(['foreign'])
  })
  it('shows its own live page rather than "steps aside", even though its own root carries data-covers-native-view', async () => {
    // Regression: the player marks its own <aside> so a page docked elsewhere steps aside for it (browserOverlay.ts).
    // useOverlayOpen must exclude that marker from covering the player's *own* frame, or every open player would
    // permanently read as covered by itself, whatever any other thread is doing (#331 follow-up).
    const browser = fake(); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    const player = await screen.findByRole('complementary', { name: 'Browser for Visual gate flake' })
    expect(player).toHaveAttribute('data-covers-native-view')
    await waitFor(() => expect(player.querySelector('.browser-player__viewport')).not.toBeNull())
    expect(player.querySelector('.browser-player__viewport')).not.toHaveAttribute('data-covered')
    expect(screen.queryByText('The page steps aside while a menu or dialog is open.')).not.toBeInTheDocument()
  })
  it('does not open a task on its own when the setting is off', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} autoShow={false} playerStore={playerStore} />)
    await waitFor(() => expect(store.browser.taskSnapshot()).toHaveLength(1))
    expect(screen.queryByRole('complementary', { name: /Browser for/ })).not.toBeInTheDocument()
  })
  it('opens a genuinely new task on its own once the setting is on', async () => {
    const browser = fake([]); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} autoShow playerStore={playerStore} />)
    await waitFor(() => expect(browser.bridge.tasks).toHaveBeenCalled())
    expect(screen.queryByRole('complementary', { name: /Browser for/ })).not.toBeInTheDocument()
    act(() => browser.emit({ type: 'task', task: task() }))
    expect(await screen.findByRole('complementary', { name: 'Browser for Visual gate flake' })).toBeInTheDocument()
  })
  it('steps aside, drawing nothing, once Tools > Browser shows the same thread’s same page', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    await screen.findByRole('complementary', { name: 'Browser for Visual gate flake' })
    await act(async () => { await store.browser.activate(browser.bridge, 'visual-gate'); store.browser.select('visual-gate', page.id) })
    act(() => { store.setSurface('browser'); store.setOpen(true) })
    expect(screen.queryByRole('complementary', { name: /Browser for/ })).not.toBeInTheDocument()
  })
  it('never lights the pane dot for a thread it is only pinned to (#331)', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore(); const state = threadsStateFixture()
    render(<>
      <section className="thread-pane" data-thread-id="visual-gate"><ToolsPanelToggle store={store} state={state} /></section>
      <section className="thread-pane" data-thread-id="grok-previews"><ToolsPanelToggle store={store} state={state} /></section>
      <BrowserPlayer state={state} focusedThreadId="grok-previews" bridge={browser.bridge} store={store} autoShow={false} playerStore={playerStore} />
    </>)
    await waitFor(() => expect(store.browser.taskSnapshot()).toHaveLength(1))
    const [waitingPane, otherPane] = screen.getAllByRole('button', { name: 'Tools' })
    expect(waitingPane).not.toHaveAccessibleDescription(/browser request/)
    act(() => browser.emit({ type: 'task', task: task({ updatedAt: 3, pendingAction: { id: '44444444-4444-4444-8444-444444444444', action: { type: 'navigate', url: 'http://localhost:5173/about' }, description: 'Go to /about', expiresAt: Date.now() + 1000 } }) }))
    expect(waitingPane).toHaveAccessibleDescription('A browser request is waiting for your answer')
    expect(waitingPane!.querySelector('.tools-toggle__agents-dot')).not.toBeNull()
    expect(otherPane).not.toHaveAccessibleDescription(/browser request/)
    expect(otherPane!.querySelector('.tools-toggle__agents-dot')).toBeNull()
    // Pinning Tools to visual-gate (the waiting task's thread) from the other pane must not light that pane's own dot.
    act(() => store.pin('visual-gate'))
    expect(otherPane!.querySelector('.tools-toggle__agents-dot')).toBeNull()
    act(() => browser.emit({ type: 'task', task: task({ updatedAt: 4 }) }))
    expect(waitingPane!.querySelector('.tools-toggle__agents-dot')).toBeNull()
  })
  it('moves the task’s page into Tools > Browser without pinning', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    render(<><button id="tools-tab-browser">Browser</button><BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} /></>)
    fireEvent.click(await screen.findByRole('button', { name: 'Move the browser into Tools' }))
    await waitFor(() => expect(store.getSnapshot()).toMatchObject({ open: true, surface: 'browser', pinnedThreadId: null }))
    expect(store.browser.thread('visual-gate')?.activePageId).toBe(page.id)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Browser' })).toHaveFocus())
  })
  it('shrinks to a pill showing the current action, moves focus there, and the pill restores it', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    await screen.findByRole('complementary', { name: 'Browser for Visual gate flake' })
    fireEvent.click(screen.getByRole('button', { name: 'Shrink the browser to a pill' }))
    expect(screen.queryByRole('complementary', { name: /Browser for/ })).not.toBeInTheDocument()
    const pill = screen.getByRole('button', { name: /Show the browser for Visual gate flake/ })
    expect(pill).toHaveTextContent('Checking the form')
    // Focus follows the player to the pill that replaces it, never dropping to the page body.
    await waitFor(() => expect(pill).toHaveFocus())
    fireEvent.click(pill)
    expect(await screen.findByRole('complementary', { name: 'Browser for Visual gate flake' })).toBeInTheDocument()
  })
  it('hides on request, leaving Tools > Browser as the way back, and moves focus to the composer', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    render(<><section className="thread-pane" data-focused><form className="thread-prompt"><textarea aria-label="Message" /></form></section>
      <BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} /></>)
    await screen.findByRole('complementary', { name: 'Browser for Visual gate flake' })
    fireEvent.click(screen.getByRole('button', { name: 'Hide the browser; the agent keeps working' }))
    expect(screen.queryByRole('complementary', { name: /Browser for/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show the browser for Visual gate flake/ })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus())
  })
  it('shrinks the player and returns focus to the composer on Escape', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    render(<><section className="thread-pane" data-focused><form className="thread-prompt"><textarea aria-label="Message" /></form></section>
      <BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} /></>)
    const player = await screen.findByRole('complementary', { name: 'Browser for Visual gate flake' })
    fireEvent.keyDown(player, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: /Browser for/ })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus()
  })
  it('offers Allow once, Allow this thread and Deny for a waiting action, and keeps the page in view', async () => {
    const pending = task({ pendingAction: { id: '33333333-3333-4333-8333-333333333333', action: { type: 'click', x: 10, y: 20 }, description: 'Click at 10, 20 on localhost', expiresAt: Date.now() + 10000 } })
    const browser = fake([pending]); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    const group = await screen.findByRole('group', { name: 'Browser action permission' })
    expect(screen.getByText('Click at 10, 20 on localhost')).toBeInTheDocument()
    expect([...group.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Allow once', 'Allow this thread', 'Deny'])
    const threadButton = screen.getByRole('button', { name: 'Allow this thread to use the browser without asking' })
    expect(threadButton).toHaveAttribute('title', 'Allow this thread to use the browser without asking')
    expect(browser.bridge.answerAction).not.toHaveBeenCalled()
    fireEvent.click(threadButton)
    await waitFor(() => expect(browser.bridge.answerAction).toHaveBeenCalledWith(expect.objectContaining({ actionId: pending.pendingAction!.id, allow: true, forThread: true })))
  })
  it('disables Allow once and Allow this thread while the task is paused, keeping Deny available, like the Tools task details', async () => {
    const pending = task({ status: 'paused', pendingAction: { id: '33333333-3333-4333-8333-333333333333', action: { type: 'click', x: 10, y: 20 }, description: 'Click at 10, 20 on localhost', expiresAt: Date.now() + 10000 } })
    const browser = fake([pending]); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    await screen.findByRole('group', { name: 'Browser action permission' })
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Allow this thread to use the browser without asking' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled()
  })
  it('disables every answer while one is in flight, so a second press cannot double-answer', async () => {
    const pending = task({ pendingAction: { id: '33333333-3333-4333-8333-333333333333', action: { type: 'click', x: 10, y: 20 }, description: 'Click at 10, 20 on localhost', expiresAt: Date.now() + 10000 } })
    const browser = fake([pending]); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    let settleAnswer: (() => void) | null = null
    browser.bridge.answerAction = vi.fn<NonNullable<BrowserBridge['answerAction']>>(() => new Promise(resolve => { settleAnswer = () => resolve(ok(task())) }))
    render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    const allowOnce = await screen.findByRole('button', { name: 'Allow once' })
    const deny = screen.getByRole('button', { name: 'Deny' })
    fireEvent.click(allowOnce)
    await waitFor(() => expect(allowOnce).toBeDisabled())
    expect(deny).toBeDisabled()
    expect(browser.bridge.answerAction).toHaveBeenCalledTimes(1)
    settleAnswer!()
  })
  it('shows a compact grant line with Stop when the thread has a browser grant', async () => {
    const browser = fake()
    browser.bridge.list = vi.fn(async () => ok({ workspace, pages: [page], grant: { grantedAt: Date.now(), source: 'settings' as const } }))
    const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    await screen.findByRole('complementary', { name: 'Browser for Visual gate flake' })
    expect(await screen.findByText('Uses the browser without asking')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stop letting this thread use the browser without asking' }))
    await waitFor(() => expect(browser.bridge.stopGrant).toHaveBeenCalledWith({ threadId: 'visual-gate', workspaceId: workspace.workspaceId }))
  })
  it('pauses through the host, then offers resume while keeping the player visible', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }))
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument()
    expect(browser.bridge.controlTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: task().id, control: 'pause' }))
  })
})

describe('the browser player’s keyboard path for moving and resizing', () => {
  it('names the drag bar for a screen reader and moves the player with the arrow keys', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    await screen.findByRole('complementary', { name: 'Browser for Visual gate flake' })
    const bar = screen.getByRole('group', { name: /Move the browser\. Drag, or use the arrow keys/ })
    expect(bar).toHaveAttribute('aria-roledescription', 'drag handle')
    const windowSize = { width: window.innerWidth, height: window.innerHeight }
    const before = playerStore.rectFor(windowSize)
    fireEvent.keyDown(bar, { key: 'ArrowRight' })
    expect(playerStore.rectFor(windowSize).x).toBe(before.x + BROWSER_PLAYER_MOVE_STEP)
    fireEvent.keyDown(bar, { key: 'ArrowDown', shiftKey: true })
    expect(playerStore.rectFor(windowSize).y).toBe(before.y + BROWSER_PLAYER_MOVE_STEP_LARGE)
  })
  it('makes the corner grip focusable and resizes the player with the arrow keys, respecting the minimum', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    await screen.findByRole('complementary', { name: 'Browser for Visual gate flake' })
    const grip = screen.getByRole('separator', { name: /Resize the browser\. Use the arrow keys/ })
    expect(grip).not.toHaveAttribute('aria-orientation')
    expect(grip).toHaveAttribute('tabindex', '0')
    grip.focus()
    expect(grip).toHaveFocus()
    const windowSize = { width: window.innerWidth, height: window.innerHeight }
    const before = playerStore.rectFor(windowSize)
    fireEvent.keyDown(grip, { key: 'ArrowRight' })
    expect(playerStore.rectFor(windowSize).width).toBe(before.width + BROWSER_PLAYER_MOVE_STEP)
    fireEvent.keyDown(grip, { key: 'ArrowDown', shiftKey: true })
    expect(playerStore.rectFor(windowSize).height).toBe(before.height + BROWSER_PLAYER_MOVE_STEP_LARGE)
    // Shrinking past the minimum stops there, the same rule a corner drag follows.
    for (let attempt = 0; attempt < 40; attempt++) fireEvent.keyDown(grip, { key: 'ArrowLeft', shiftKey: true })
    expect(playerStore.rectFor(windowSize).width).toBe(BROWSER_PLAYER_MIN_WIDTH)
  })
  it('resizes from the corner from a keyboard press even before the user has ever moved the player (no jump)', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    const grip = await screen.findByRole('separator', { name: /Resize the browser/ })
    const windowSize = { width: window.innerWidth, height: window.innerHeight }
    const drawn = playerStore.rectFor(windowSize) // the default, never moved or resized
    fireEvent.keyDown(grip, { key: 'ArrowRight' })
    expect(playerStore.rectFor(windowSize)).toMatchObject({ x: drawn.x, y: drawn.y, width: drawn.width + BROWSER_PLAYER_MOVE_STEP, height: drawn.height })
  })
})

describe('placement across threads (BrowserPlayerStore integration)', () => {
  it('keeps one placement across threads: moving the player in one thread keeps it moved for the next', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    const windowSize = { width: window.innerWidth, height: window.innerHeight }
    const start = playerStore.rectFor(windowSize)
    playerStore.setRect({ ...start, x: start.x + 40, y: start.y + 20 }, windowSize)
    const before = playerStore.rectFor({ width: window.innerWidth, height: window.innerHeight })
    const { rerender } = render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    await screen.findByRole('complementary', { name: 'Browser for Visual gate flake' })
    rerender(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="grok-previews" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    expect(playerStore.rectFor({ width: window.innerWidth, height: window.innerHeight })).toEqual(before)
  })
})

describe('the browser task details in Tools', () => {
  it('shows evidence and never answers a requested action until the user presses its button', async () => {
    const browser = fake(); const store = new ToolsPanelStore()
    const pending = task({ pendingAction: { id: '33333333-3333-4333-8333-333333333333', action: { type: 'click', x: 10, y: 20 }, description: 'Click at 10, 20 on localhost', expiresAt: Date.now() + 10000 }, steps: [{ id: 's1', action: 'Screenshot', detail: '1280 ? 800', at: 1, status: 'completed' }], unchecked: ['Saving'] })
    render(<BrowserTaskDetails task={pending} bridge={browser.bridge} store={store.browser} />)
    expect(screen.getByText('Not checked: Saving')).toBeInTheDocument()
    expect(browser.bridge.answerAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(browser.bridge.answerAction).toHaveBeenCalledWith(expect.objectContaining({ actionId: pending.pendingAction!.id, allow: true })))
    expect(vi.mocked(browser.bridge.answerAction).mock.calls[0]![0]).not.toHaveProperty('forThread')
  })
  it.each([
    { type: 'navigate' as const, url: 'http://localhost:5173/', description: 'Open and share this page with the thread: http://localhost:5173/' },
    { type: 'click' as const, x: 10, y: 20, description: 'Click at 10, 20 on localhost' },
  ])('offers the thread-wide answer for every action, and gives it only when that button is pressed: $type', async action => {
    const browser = fake(); const store = new ToolsPanelStore()
    const { description, ...actionPayload } = action
    const opening = task({ pendingAction: { id: '33333333-3333-4333-8333-333333333333', action: actionPayload, description, expiresAt: Date.now() + 10000 } })
    render(<BrowserTaskDetails task={opening} bridge={browser.bridge} store={store.browser} />)
    const group = screen.getByRole('group', { name: 'Browser action permission' })
    expect([...group.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Allow once', 'Allow this thread to use the browser', 'Deny'])
    expect(browser.bridge.answerAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Allow this thread to use the browser' }))
    await waitFor(() => expect(browser.bridge.answerAction).toHaveBeenCalledWith(expect.objectContaining({ actionId: opening.pendingAction!.id, allow: true, forThread: true })))
  })
})

describe('browser feedback', () => {
  it('selects an element by keyboard, then adds its screenshot and comment only on request', async () => {
    const browser = fake(); const add = vi.fn(async () => null); const close = vi.fn()
    vi.mocked(browser.bridge.capture).mockResolvedValue(ok({ ...capture, element: { tag: 'button', role: 'button', name: 'Save', text: 'Save', selector: '#save' } }))
    render(<BrowserFeedback page={page} initial={capture} bridge={browser.bridge} onAdd={add} onClose={close} />)
    const select = screen.getByRole('button', { name: /Select page element/ })
    fireEvent.keyDown(select, { key: 'ArrowRight' }); fireEvent.keyDown(select, { key: 'Enter' })
    await screen.findByText('Selected: Save')
    expect(browser.bridge.capture).toHaveBeenCalledWith(expect.objectContaining({ point: { x: 650, y: 400 } }))
    expect(add).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Browser feedback comment' }), { target: { value: 'Give this more space' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to draft' }))
    expect(screen.getByRole('button', { name: 'Add to draft' })).toBeDisabled()
    await waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ element: expect.objectContaining({ selector: '#save' }) }), 'Give this more space', expect.any(AbortSignal))
  })
  it('returns focus to Add to draft with the problem shown when adding fails, and never stays busy', async () => {
    const browser = fake(); const close = vi.fn()
    const add = vi.fn(async () => 'This screenshot does not fit in the draft. Remove an attachment or capture a smaller region.')
    const { rerender } = render(<BrowserFeedback page={page} initial={capture} bridge={browser.bridge} onAdd={add} onClose={close} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Browser feedback comment' }), { target: { value: 'Tighter' } })
    const button = screen.getByRole('button', { name: 'Add to draft' })
    button.focus(); fireEvent.click(button)
    expect(await screen.findByRole('alert')).toHaveTextContent('does not fit in the draft')
    await waitFor(() => expect(document.activeElement).toBe(button))
    expect(button).toBeEnabled(); expect(close).not.toHaveBeenCalled()
    // A rejection says what happened rather than leaving the button disabled for good.
    const failing = vi.fn(async (): Promise<string | null> => { throw new Error('bridge gone') })
    rerender(<BrowserFeedback page={page} initial={capture} bridge={browser.bridge} onAdd={failing} onClose={close} />)
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not add this screenshot. Nothing was attached. Try again.'))
    await waitFor(() => expect(button).toBeEnabled())
  })
  it('selects a region entirely from the keyboard and binds it to the captured frame', async () => {
    const browser = fake()
    render(<BrowserFeedback page={page} initial={{ ...capture, captureId: 'frame-id' }} bridge={browser.bridge} onAdd={async () => null} onClose={() => undefined} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Selection mode' }), { target: { value: 'region' } })
    const select = screen.getByRole('button', { name: /Select page region/ })
    fireEvent.keyDown(select, { key: ' ' })
    fireEvent.keyDown(select, { key: 'ArrowRight' })
    fireEvent.keyDown(select, { key: 'ArrowDown' })
    fireEvent.keyDown(select, { key: 'Enter' })
    await waitFor(() => expect(browser.bridge.capture).toHaveBeenCalledWith(expect.objectContaining({ region: { x: 640, y: 400, width: 10, height: 10 }, captureId: 'frame-id' })))
  })
  it('stages the screenshot and appends to the latest draft without submitting or replacing existing text and attachments', async () => {
    const staged: AgentAttachmentStageRequest[] = []
    vi.stubGlobal('sotto', { agents: { stageAttachment: vi.fn(async (request: AgentAttachmentStageRequest) => { staged.push(request); return handleOf(request.bytes, 'feedback', request.name) }) } })
    try {
      const command = vi.fn(async () => null); const drafts = new ThreadDraftStore(command, 60_000)
      drafts.edit('visual-gate', { text: 'Keep this thought' })
      expect(await appendBrowserFeedback(drafts, 'visual-gate', capture, 'This button needs room', true)).toBeNull()
      expect(drafts.draft('visual-gate').text).toContain('Keep this thought\n\nBrowser feedback:')
      // The draft carries the handle; the bytes went to main once, for this thread.
      expect(drafts.draft('visual-gate').attachments).toEqual([expect.objectContaining({ id: 'feedback', name: 'Browser feedback.png', mimeType: 'image/png' })])
      expect(staged).toEqual([expect.objectContaining({ threadId: 'visual-gate', name: 'Browser feedback.png', mimeType: 'image/png', bytes: new Uint8Array(Buffer.from('abc')) })])
      expect(drafts.submissions()).toEqual([])
      expect(command).not.toHaveBeenCalled()
      const before = drafts.draft('visual-gate')
      expect(await appendBrowserFeedback(drafts, 'visual-gate', capture, 'Other', false)).toContain('image support')
      expect(drafts.draft('visual-gate')).toBe(before)
      drafts.edit('visual-gate', { requestId: 'question' })
      expect(await appendBrowserFeedback(drafts, 'visual-gate', capture, 'Other', true)).toContain('answers a question')
      expect(staged).toHaveLength(1)
    } finally { vi.unstubAllGlobals() }
  })
  it('shows a staging refusal in its own words, without the channel Electron names', async () => {
    vi.stubGlobal('sotto', { agents: { stageAttachment: vi.fn(async () => { throw new Error("Error invoking remote method 'sotto:agents:stage-attachment': Error: This host is disconnected. Connect again before attaching images. Nothing was attached.") }) } })
    try {
      const drafts = new ThreadDraftStore(vi.fn(async () => null), 60_000)
      expect(await appendBrowserFeedback(drafts, 'visual-gate', capture, 'Look', true)).toBe('This host is disconnected. Connect again before attaching images. Nothing was attached.')
    } finally { vi.unstubAllGlobals() }
  })
  it('leaves the draft as it was when the add is cancelled while its screenshot is prepared', async () => {
    vi.useFakeTimers()
    const drafts = new ThreadDraftStore(vi.fn(async () => null))
    drafts.edit('visual-gate', { text: 'Keep this thought' })
    const before = drafts.draft('visual-gate')
    let finish: (value: { blob: Blob }) => void = () => undefined
    const prepare = vi.fn(() => new Promise<{ blob: Blob }>(resolve => { finish = resolve }))
    const controller = new AbortController()
    const added = appendBrowserFeedback(drafts, 'visual-gate', capture, 'Too tight', true, { prepare, signal: controller.signal })
    controller.abort()
    finish({ blob: new Blob(['abc'], { type: 'image/png' }) })
    expect(await added).toBeNull()
    expect(drafts.draft('visual-gate')).toBe(before)
  })
  it('stops a pending add when Cancel is pressed, and does not close twice', async () => {
    const browser = fake(); const close = vi.fn()
    let signal: AbortSignal | undefined
    let finish: (error: string | null) => void = () => undefined
    const add = vi.fn((_capture: unknown, _comment: string, given: AbortSignal) => { signal = given; return new Promise<string | null>(resolve => { finish = resolve }) })
    render(<BrowserFeedback page={page} initial={capture} bridge={browser.bridge} onAdd={add} onClose={close} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Browser feedback comment' }), { target: { value: 'Give this more space' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to draft' }))
    await waitFor(() => expect(add).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(signal?.aborted).toBe(true)
    expect(close).toHaveBeenCalledOnce()
    finish(null)
    await Promise.resolve(); await Promise.resolve()
    expect(close).toHaveBeenCalledOnce()
  })
  it('scales a capture past the screenshot bound down before it joins the draft, keeping typing done meanwhile', async () => {
    vi.useFakeTimers()
    const staged: AgentAttachmentStageRequest[] = []
    vi.stubGlobal('sotto', { agents: { stageAttachment: vi.fn(async (request: AgentAttachmentStageRequest) => {
      staged.push(request); return { ...handleOf(request.bytes, 'feedback', request.name), ...(request.dimensions ? { dimensions: request.dimensions } : {}) }
    }) } })
    const drafts = new ThreadDraftStore(vi.fn(async () => null))
    const dimensions = { original: { width: 5120, height: 2880 }, sent: { width: 2576, height: 1449 } }
    let finish: (value: { blob: Blob, dimensions: typeof dimensions }) => void = () => undefined
    const prepare = vi.fn<(image: Blob) => Promise<{ blob: Blob, dimensions: typeof dimensions }>>(() => new Promise(resolve => { finish = resolve }))
    const added = appendBrowserFeedback(drafts, 'visual-gate', { ...capture, width: 5120, height: 2880 }, 'Too tight', true, { prepare })
    // The capture is decoded from its data URL once, and those bytes are what is prepared.
    expect(new Uint8Array(await prepare.mock.calls[0]![0].arrayBuffer())).toEqual(new Uint8Array(Buffer.from('abc')))
    drafts.edit('visual-gate', { text: 'Typed while it was prepared' })
    finish({ blob: new Blob(['scaled'], { type: 'image/png' }), dimensions })
    expect(await added).toBeNull()
    expect(drafts.draft('visual-gate').text).toMatch(/^Typed while it was prepared\n\nBrowser feedback:/)
    // The agent is told the size of the image it receives, not only the size captured.
    expect(drafts.draft('visual-gate').text).toContain('Screenshot size: 5120 x 2880, sent at 2576 x 1449')
    // The handle carries the sizes, and main was told them with the bytes it stages.
    expect(drafts.draft('visual-gate').attachments).toEqual([expect.objectContaining({ name: 'Browser feedback.png', dimensions })])
    expect(staged).toEqual([expect.objectContaining({ dimensions, bytes: new Uint8Array(Buffer.from('scaled')) })])
    vi.unstubAllGlobals()
  })
})
