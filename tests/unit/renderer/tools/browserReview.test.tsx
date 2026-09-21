import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridge, BrowserCapture, BrowserEvent, BrowserPage, BrowserTask } from '../../../../src/shared/browser'
import type { ToolsResult } from '../../../../src/shared/tools'
import { BrowserTaskDetails, BrowserTaskPreview } from '../../../../src/renderer/src/tools/BrowserTaskPreview'
import { appendBrowserFeedback, BrowserFeedback } from '../../../../src/renderer/src/tools/BrowserFeedback'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
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
    answerAction: vi.fn(async () => ok(task())), openLink: vi.fn(async () => ok({ destination: 'external' as const })),
    onEvent: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  return { bridge, emit: (event: BrowserEvent) => listeners.forEach(listener => listener(event)) }
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('the shared browser preview', () => {
  it('opens the retained task page in Tools even when another thread was pinned', async () => {
    const browser = fake(); const store = new ToolsPanelStore(); store.pin('another-thread')
    render(<><button id="tools-tab-browser">Browser</button><BrowserTaskPreview state={threadsStateFixture()} focusedThreadId="another-thread" bridge={browser.bridge} store={store} /></>)
    fireEvent.click(await screen.findByRole('button', { name: /Open browser task in Tools/ }))
    await waitFor(() => expect(store.getSnapshot()).toMatchObject({ open: true, surface: 'browser', pinnedThreadId: 'visual-gate' }))
    expect(store.browser.thread('visual-gate')?.activePageId).toBe(page.id)
    expect(browser.bridge.create).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Browser', exact: true })).toHaveFocus())
    expect(screen.queryByRole('button', { name: /Open browser task in Tools/ })).not.toBeInTheDocument()
  })
  it('dismisses one task without pausing and keeps it dismissed across progress updates', async () => {
    const browser = fake(); const store = new ToolsPanelStore()
    render(<><button aria-controls="sotto-tools-panel">Tools</button><BrowserTaskPreview state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} /></>)
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss browser preview' }))
    expect(screen.getByRole('button', { name: 'Tools' })).toHaveFocus()
    expect(browser.bridge.controlTask).not.toHaveBeenCalled()
    act(() => browser.emit({ type: 'task', task: task({ description: 'Checking reload', updatedAt: 2 }) }))
    expect(screen.queryByRole('button', { name: /Open browser task in Tools/ })).not.toBeInTheDocument()
    act(() => browser.emit({ type: 'task', task: task({ id: '33333333-3333-4333-8333-333333333333', updatedAt: 3 }) }))
    expect(screen.getByRole('button', { name: /Open browser task in Tools/ })).toBeInTheDocument()
  })
  it('leaves room above a taller composer', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 400, y: 500, width: 624, height: 268 }))
    const browser = fake(); const store = new ToolsPanelStore()
    render(<><section className="thread-pane" data-focused><form className="thread-prompt" /></section><BrowserTaskPreview state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} /></>)
    const preview = await screen.findByRole('complementary', { name: /Browser preview/ })
    expect(preview.style.bottom).toBe(`${innerHeight - 500 + 16}px`)
    expect(preview.style.maxHeight).toBe('420px')
  })
  it('pauses through the host, then offers resume while keeping the preview visible', async () => {
    const browser = fake(); const store = new ToolsPanelStore()
    render(<BrowserTaskPreview state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser.bridge} store={store} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }))
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument()
    expect(browser.bridge.controlTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: task().id, control: 'pause' }))
  })
  it('shows evidence and never answers a requested action until the user presses its button', async () => {
    const browser = fake(); const store = new ToolsPanelStore()
    const pending = task({ pendingAction: { id: '33333333-3333-4333-8333-333333333333', action: { type: 'click', x: 10, y: 20 }, description: 'Click at 10, 20 on localhost', expiresAt: Date.now() + 10000 }, steps: [{ id: 's1', action: 'Screenshot', detail: '1280 ? 800', at: 1, status: 'completed' }], unchecked: ['Saving'] })
    render(<BrowserTaskDetails task={pending} bridge={browser.bridge} store={store.browser} />)
    expect(screen.getByText('Not checked: Saving')).toBeInTheDocument()
    expect(browser.bridge.answerAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    await waitFor(() => expect(browser.bridge.answerAction).toHaveBeenCalledWith(expect.objectContaining({ actionId: pending.pendingAction!.id, allow: true })))
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
