import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridge, BrowserCapture, BrowserEvent, BrowserPage, BrowserTask } from '../../../../src/shared/browser'
import type { ToolsResult } from '../../../../src/shared/tools'
import { BrowserTaskDetails } from '../../../../src/renderer/src/tools/BrowserTaskDetails'
import { BrowserPlayer } from '../../../../src/renderer/src/tools/BrowserPlayer'
import { BrowserPlayerStore } from '../../../../src/renderer/src/tools/browserPlayerStore'
import { appendBrowserFeedback, BrowserFeedback } from '../../../../src/renderer/src/tools/BrowserFeedback'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { ToolsPanelToggle } from '../../../../src/renderer/src/tools/ToolsPanel'
import { ThreadDraftStore } from '../../../../src/renderer/src/agents/threadDraftStore'
import { threadsStateFixture } from '../liveAgentState'

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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Browser', exact: true })).toHaveFocus())
  })
  it('shrinks to a pill showing the current action, and the pill restores it', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    await screen.findByRole('complementary', { name: 'Browser for Visual gate flake' })
    fireEvent.click(screen.getByRole('button', { name: 'Shrink the browser to a pill' }))
    expect(screen.queryByRole('complementary', { name: /Browser for/ })).not.toBeInTheDocument()
    const pill = screen.getByRole('button', { name: /Show the browser for Visual gate flake/ })
    expect(pill).toHaveTextContent('Checking the form')
    fireEvent.click(pill)
    expect(await screen.findByRole('complementary', { name: 'Browser for Visual gate flake' })).toBeInTheDocument()
  })
  it('hides on request, leaving Tools > Browser as the way back', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    render(<BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} playerStore={playerStore} />)
    await screen.findByRole('complementary', { name: 'Browser for Visual gate flake' })
    fireEvent.click(screen.getByRole('button', { name: 'Hide the browser; the agent keeps working' }))
    expect(screen.queryByRole('complementary', { name: /Browser for/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show the browser for Visual gate flake/ })).not.toBeInTheDocument()
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

describe('placement across threads (BrowserPlayerStore integration)', () => {
  it('keeps one placement across threads: moving the player in one thread keeps it moved for the next', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const playerStore = new BrowserPlayerStore()
    playerStore.move(40, 20, { width: window.innerWidth, height: window.innerHeight })
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
    const browser = fake(); const add = vi.fn(() => null); const close = vi.fn()
    vi.mocked(browser.bridge.capture).mockResolvedValue(ok({ ...capture, element: { tag: 'button', role: 'button', name: 'Save', text: 'Save', selector: '#save' } }))
    render(<BrowserFeedback page={page} initial={capture} bridge={browser.bridge} onAdd={add} onClose={close} />)
    const select = screen.getByRole('button', { name: /Select page element/ })
    fireEvent.keyDown(select, { key: 'ArrowRight' }); fireEvent.keyDown(select, { key: 'Enter' })
    await screen.findByText('Selected: Save')
    expect(browser.bridge.capture).toHaveBeenCalledWith(expect.objectContaining({ point: { x: 650, y: 400 } }))
    expect(add).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Browser feedback comment' }), { target: { value: 'Give this more space' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to draft' }))
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ element: expect.objectContaining({ selector: '#save' }) }), 'Give this more space')
    expect(close).toHaveBeenCalledOnce()
  })
  it('selects a region entirely from the keyboard and binds it to the captured frame', async () => {
    const browser = fake()
    render(<BrowserFeedback page={page} initial={{ ...capture, captureId: 'frame-id' }} bridge={browser.bridge} onAdd={() => null} onClose={() => undefined} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Selection mode' }), { target: { value: 'region' } })
    const select = screen.getByRole('button', { name: /Select page region/ })
    fireEvent.keyDown(select, { key: ' ' })
    fireEvent.keyDown(select, { key: 'ArrowRight' })
    fireEvent.keyDown(select, { key: 'ArrowDown' })
    fireEvent.keyDown(select, { key: 'Enter' })
    await waitFor(() => expect(browser.bridge.capture).toHaveBeenCalledWith(expect.objectContaining({ region: { x: 640, y: 400, width: 10, height: 10 }, captureId: 'frame-id' })))
  })
  it('appends to the latest draft without submitting or replacing existing text and attachments', () => {
    vi.useFakeTimers()
    const command = vi.fn(async () => null); const drafts = new ThreadDraftStore(command)
    drafts.edit('visual-gate', { text: 'Keep this thought' })
    expect(appendBrowserFeedback(drafts, 'visual-gate', capture, 'This button needs room', true)).toBeNull()
    expect(drafts.draft('visual-gate').text).toContain('Keep this thought\n\nBrowser feedback:')
    expect(drafts.draft('visual-gate').attachments).toHaveLength(1)
    expect(drafts.submissions()).toEqual([])
    expect(command).not.toHaveBeenCalled()
    const before = drafts.draft('visual-gate')
    expect(appendBrowserFeedback(drafts, 'visual-gate', capture, 'Other', false)).toContain('image support')
    expect(drafts.draft('visual-gate')).toBe(before)
    drafts.edit('visual-gate', { requestId: 'question' })
    expect(appendBrowserFeedback(drafts, 'visual-gate', capture, 'Other', true)).toContain('answers a question')
  })
})
