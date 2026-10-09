import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridge, BrowserEvent, BrowserPage, BrowserTask } from '../../../../src/shared/browser'
import type { ToolsResult } from '../../../../src/shared/tools'
import { BrowserPlayer } from '../../../../src/renderer/src/tools/BrowserPlayer'
import { PhonePlayer } from '../../../../src/renderer/src/tools/PhonePlayer'
import { PhonePlayerStore } from '../../../../src/renderer/src/tools/phonePlayerStore'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { threadsStateFixture } from '../../../fixtures/renderer/liveAgentState'

const workspace = { threadId: 'visual-gate', projectId: 'workshop', workingDirectory: 'D:/work', workspaceId: 'workspace' }
const page: BrowserPage = { id: '11111111-1111-4111-8111-111111111111', workspace, url: 'http://localhost:8081/', title: 'Expo', status: 'ready', error: null, canGoBack: false, canGoForward: false, device: 'iphone' }
const task = (patch: Partial<BrowserTask> = {}): BrowserTask => ({
  id: '22222222-2222-4222-8222-222222222222', threadId: workspace.threadId, workspaceId: workspace.workspaceId, pageId: page.id,
  status: 'working', description: 'Checking the form', steps: [], thumbnail: null, summary: null, unchecked: [], updatedAt: 1,
  pendingAction: null, output: null, device: 'iphone', ...patch,
})
const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })

function fake(initial: BrowserTask[] = [task()]) {
  const listeners = new Set<(event: BrowserEvent) => void>()
  const bridge: BrowserBridge = {
    tasks: vi.fn(async () => ok(initial)), list: vi.fn(async () => ok({ workspace, pages: [page] })),
    create: vi.fn(async () => ok(page)), navigate: vi.fn(async () => ok(page)), back: vi.fn(async () => ok(page)), forward: vi.fn(async () => ok(page)), reload: vi.fn(async () => ok(page)), close: vi.fn(async () => ok(undefined)), mount: vi.fn(async () => ok(undefined)),
    share: vi.fn(async () => ok(page)), viewport: vi.fn(async () => ok(page)), capture: vi.fn(async () => ok({ image: '', url: page.url, width: 393, height: 852, element: null })),
    controlTask: vi.fn(async request => ok(task({ status: request.control === 'pause' ? 'paused' : 'working', updatedAt: Date.now() }))),
    answerAction: vi.fn(async () => ok(task())), stopGrant: vi.fn(async () => ok(undefined)), openLink: vi.fn(async () => ok({ destination: 'external' as const })),
    onEvent: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  return { bridge, emit: (event: BrowserEvent) => listeners.forEach(listener => listener(event)) }
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('the phone player', () => {
  it.each(['first shown', 'reopened'])('never mounts over an existing dialog when %s', async phase => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 800, y: 300, width: 240, height: 520 }))
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([DOMRect.fromRect({ width: 100, height: 100 })] as unknown as DOMRectList)
    const browser = fake(); const store = new ToolsPanelStore(); const phoneStore = new PhonePlayerStore()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    if (phase === 'first shown') document.body.append(dialog)
    try {
      render(<PhonePlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} phoneStore={phoneStore} />)
      await screen.findByRole('complementary', { name: 'Test iPhone for Visual gate flake' })
      if (phase === 'reopened') {
        await waitFor(() => expect(browser.bridge.mount).toHaveBeenCalledWith(expect.objectContaining({ bounds: expect.any(Object) })))
        act(() => phoneStore.hide('visual-gate'))
        await act(async () => { document.body.append(dialog) })
        vi.mocked(browser.bridge.mount).mockClear()
        act(() => phoneStore.show('visual-gate'))
      }
      expect(screen.getByText('The phone steps aside while a menu or dialog is open.')).toBeInTheDocument()
      expect(browser.bridge.mount).not.toHaveBeenCalledWith(expect.objectContaining({ bounds: expect.any(Object) }))
      await act(async () => { dialog.remove() })
      await waitFor(() => expect(browser.bridge.mount).toHaveBeenCalledWith(expect.objectContaining({ bounds: expect.any(Object) })))
    } finally { dialog.remove() }
  })

  it('does no overlay scans or pane measurement while hidden, but still opens a new task', async () => {
    const browser = fake([]); const store = new ToolsPanelStore(); const phoneStore = new PhonePlayerStore()
    const scans = vi.spyOn(document, 'querySelectorAll')
    const geometry = vi.spyOn(phoneStore, 'pointFor')
    render(<PhonePlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} phoneStore={phoneStore} />)
    await act(async () => { await Promise.resolve() })
    const mutation = document.createElement('span')
    await act(async () => { document.body.append(mutation); mutation.remove() })
    expect(scans.mock.calls.filter(([selector]) => selector.includes('[data-covers-native-view]'))).toHaveLength(0)
    expect(geometry).not.toHaveBeenCalled()
    act(() => browser.emit({ type: 'task', task: task() }))
    await screen.findByRole('complementary', { name: 'Test iPhone for Visual gate flake' })
    expect(geometry).toHaveBeenCalled()
  })

  it('stops scanning when hidden and checks existing overlays again when reopened', async () => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([DOMRect.fromRect({ width: 100, height: 100 })] as unknown as DOMRectList)
    const browser = fake(); const store = new ToolsPanelStore(); const phoneStore = new PhonePlayerStore()
    render(<PhonePlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} phoneStore={phoneStore} />)
    await screen.findByRole('complementary', { name: 'Test iPhone for Visual gate flake' })
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    await act(async () => { document.body.append(dialog) })
    expect(screen.getByText('The phone steps aside while a menu or dialog is open.')).toBeInTheDocument()
    act(() => phoneStore.hide('visual-gate'))
    const scans = vi.spyOn(document, 'querySelectorAll')
    const geometry = vi.spyOn(phoneStore, 'pointFor')
    await act(async () => { dialog.remove() })
    expect(scans.mock.calls.filter(([selector]) => selector.includes('[data-covers-native-view]'))).toHaveLength(0)
    expect(geometry).not.toHaveBeenCalled()
    act(() => phoneStore.show('visual-gate'))
    expect(screen.queryByText('The phone steps aside while a menu or dialog is open.')).not.toBeInTheDocument()
    await act(async () => { document.body.append(dialog) })
    expect(screen.getByText('The phone steps aside while a menu or dialog is open.')).toBeInTheDocument()
    act(() => phoneStore.hide('visual-gate'))
    act(() => phoneStore.show('visual-gate'))
    expect(screen.getByText('The phone steps aside while a menu or dialog is open.')).toBeInTheDocument()
    await act(async () => { dialog.remove() })
  })

  it('shows the focused thread’s test iPhone with its status, and Pause controls the task', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 800, y: 300, width: 240, height: 520 }))
    const browser = fake(); const store = new ToolsPanelStore(); const phoneStore = new PhonePlayerStore()
    render(<PhonePlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} phoneStore={phoneStore} />)
    act(() => store.browser.watchTasks(browser.bridge, ['visual-gate']))
    const player = await screen.findByRole('complementary', { name: 'Test iPhone for Visual gate flake' })
    expect(player).toBeInTheDocument()
    expect(screen.getByText('Checking the form')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(browser.bridge.controlTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: task().id, control: 'pause' })))
  })

  it('never shows in the Browser player: a task on the test iPhone is excluded there', async () => {
    const browser = fake(); const store = new ToolsPanelStore()
    render(<>
      <BrowserPlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} />
      <PhonePlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} />
    </>)
    await screen.findByRole('complementary', { name: 'Test iPhone for Visual gate flake' })
    expect(screen.queryByRole('complementary', { name: /Browser for/ })).not.toBeInTheDocument()
  })

  it('never opens for a task on an ordinary page, even for the same thread', async () => {
    const browser = fake([]); const store = new ToolsPanelStore(); const phoneStore = new PhonePlayerStore()
    render(<PhonePlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} phoneStore={phoneStore} />)
    act(() => store.browser.watchTasks(browser.bridge, ['visual-gate']))
    await waitFor(() => expect(browser.bridge.tasks).toHaveBeenCalled())
    act(() => browser.emit({ type: 'task', task: task({ device: undefined, id: 'ordinary-task' }) }))
    expect(screen.queryByRole('complementary', { name: /Test iPhone/ })).not.toBeInTheDocument()
  })

  it('never shows another thread’s test iPhone, even while that thread has one', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const phoneStore = new PhonePlayerStore()
    render(<PhonePlayer state={threadsStateFixture()} focusedThreadId="grok-previews" bridge={browser.bridge} store={store} phoneStore={phoneStore} />)
    act(() => store.browser.watchTasks(browser.bridge, ['grok-previews', 'visual-gate']))
    await waitFor(() => expect(browser.bridge.tasks).toHaveBeenCalled())
    expect(screen.queryByRole('complementary', { name: /Test iPhone/ })).not.toBeInTheDocument()
  })

  it('never shows a remote host thread’s test iPhone: Sotto’s browser is this computer’s', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const phoneStore = new PhonePlayerStore()
    const state = threadsStateFixture()
    state.host.threads = state.host.threads.map(thread => thread.id === 'visual-gate' ? { ...thread, remoteHost: true } : thread)
    render(<PhonePlayer state={state} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} phoneStore={phoneStore} />)
    act(() => store.browser.watchTasks(browser.bridge, ['visual-gate']))
    await waitFor(() => expect(browser.bridge.tasks).toHaveBeenCalled())
    expect(screen.queryByRole('complementary', { name: /Test iPhone/ })).not.toBeInTheDocument()
  })

  it('hides on Escape, handing focus back to the composer', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const phoneStore = new PhonePlayerStore()
    render(<>
      <section className="thread-pane" data-focused><form className="thread-prompt"><textarea aria-label="Message" /></form></section>
      <PhonePlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} phoneStore={phoneStore} />
    </>)
    act(() => store.browser.watchTasks(browser.bridge, ['visual-gate']))
    const player = await screen.findByRole('complementary', { name: 'Test iPhone for Visual gate flake' })
    fireEvent.keyDown(player, { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: /Test iPhone/ })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus())
  })

  it('names the size button by what pressing it would do, and cycles through the sizes', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); const phoneStore = new PhonePlayerStore()
    render(<PhonePlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} phoneStore={phoneStore} />)
    act(() => store.browser.watchTasks(browser.bridge, ['visual-gate']))
    await screen.findByRole('complementary', { name: 'Test iPhone for Visual gate flake' })
    const sizeButton = screen.getByRole('button', { name: 'Make the test iPhone large' })
    expect(sizeButton).toHaveTextContent('Medium')
    fireEvent.click(sizeButton)
    expect(phoneStore.placement().size).toBe('large')
    expect(screen.getByRole('button', { name: 'Make the test iPhone small' })).toHaveTextContent('Large')
  })

  it('offers Allow once, Allow this thread and Deny for a waiting action', async () => {
    const pending = task({ pendingAction: { id: '33333333-3333-4333-8333-333333333333', action: { type: 'tap', x: 10, y: 20 }, description: 'Tap at 10, 20 on the test iPhone', expiresAt: Date.now() + 10000 } })
    const browser = fake([pending]); const store = new ToolsPanelStore(); const phoneStore = new PhonePlayerStore()
    render(<PhonePlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} phoneStore={phoneStore} />)
    act(() => store.browser.watchTasks(browser.bridge, ['visual-gate']))
    const group = await screen.findByRole('group', { name: 'Test iPhone action permission' })
    expect([...group.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Allow once', 'Allow this thread', 'Deny'])
    expect(browser.bridge.answerAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Allow this thread to use the browser and test iPhone without asking' }))
    await waitFor(() => expect(browser.bridge.answerAction).toHaveBeenCalledWith(expect.objectContaining({ actionId: pending.pendingAction!.id, allow: true, forThread: true })))
  })

  it('mounts the live page at the screen element’s rectangle', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('phone-player__screen') ? DOMRect.fromRect({ x: 800, y: 300, width: 240, height: 520 }) : DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 })
    })
    const browser = fake(); const store = new ToolsPanelStore(); const phoneStore = new PhonePlayerStore()
    render(<PhonePlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} phoneStore={phoneStore} />)
    act(() => store.browser.watchTasks(browser.bridge, ['visual-gate']))
    await waitFor(() => expect(browser.bridge.mount).toHaveBeenCalledWith(expect.objectContaining({ pageId: page.id, bounds: { x: 800, y: 300, width: 240, height: 520 } })))
  })
})
