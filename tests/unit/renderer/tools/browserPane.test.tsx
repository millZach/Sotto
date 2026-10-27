import { browserBridgeFixture, browserPage, browserTask } from '../../../fixtures/renderer/browserBridge'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserTask } from '../../../../src/shared/browser'
import type { ToolsResult } from '../../../../src/shared/tools'
import { DEFAULT_SETTINGS } from '../../../../src/shared/settings'
import type { AppContextValue } from '../../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../../src/renderer/src/state/AppContext'
import { useOptionalAgents } from '../../../../src/renderer/src/agents/AgentContext'
import { ThreadDraftStore } from '../../../../src/renderer/src/agents/threadDraftStore'
import { appendBrowserFeedback } from '../../../../src/renderer/src/tools/BrowserFeedback'
import { ToolsPanel } from '../../../../src/renderer/src/tools/ToolsPanel'
import { BrowserPlayerStore } from '../../../../src/renderer/src/tools/browserPlayerStore'
import { browserStepWords, browsingWords, shortAddress } from '../../../../src/renderer/src/tools/browserSteps'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { BrowserStore } from '../../../../src/renderer/src/tools/browserStore'
import { threadsStateFixture } from '../../../fixtures/renderer/liveAgentState'
import { TOKEN_A, fakeFilesBridge, text } from '../../../fixtures/renderer/fakeFilesBridge'

vi.mock('../../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../../src/renderer/src/agents/AgentContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/renderer/src/agents/AgentContext')>(),
  useOptionalAgents: vi.fn(),
}))
vi.mock('../../../../src/renderer/src/tools/BrowserFeedback', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/renderer/src/tools/BrowserFeedback')>(),
  appendBrowserFeedback: vi.fn(async () => null),
}))

/**
 * The quiet browser pane (ADR-0154): on Owl, Tools > Browser is one row above the page, an agent's work is one strip
 * at the page's foot, and the pane opens on its own while Tools is open. Stable keeps today's surface.
 */
const workspace = { threadId: 'visual-gate', projectId: 'workshop', workingDirectory: 'D:\\work\\workshop', workspaceId: TOKEN_A }
const PAGE_1 = '11111111-1111-4111-8111-111111111111'
const PAGE_2 = '22222222-2222-4222-8222-222222222222'
const TASK = '33333333-3333-4333-8333-333333333333'
const page = (id: string, patch: Partial<BrowserPage> = {}): BrowserPage => browserPage(workspace, { id, url: 'http://localhost:5173/sign-in', title: 'Sign in · Fieldnotes', sharedOrigin: 'http://localhost:5173', ...patch })
const task = (patch: Partial<BrowserTask> = {}): BrowserTask => browserTask({ id: TASK, threadId: 'visual-gate', workspaceId: TOKEN_A, pageId: PAGE_1, updatedAt: 10, ...patch })
const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })
const capture = { image: 'data:image/png;base64,YWJj', url: 'http://localhost:5173/sign-in', width: 1280, height: 800, element: null }

function fakeBrowser(initial: BrowserPage[] = [page(PAGE_1)], options: { grant?: boolean; tasks?: BrowserTask[] } = {}) {
  let pages = initial
  const published = browserBridgeFixture({ workspace, commands: {
    tasks: vi.fn(async () => ok(options.tasks ?? [])),
    share: vi.fn(async ({ pageId, enabled }) => ok(page(pageId, { sharedOrigin: enabled ? 'http://localhost:5173' : null }))),
    viewport: vi.fn(async request => ok(page(request.pageId, { viewport: 'reset' in request ? null : { width: request.width, height: request.height } }))),
    capture: vi.fn(async () => ok(capture)),
    controlTask: vi.fn(async request => ok(task({ ...options.tasks?.[0], status: request.control === 'pause' ? 'paused' : 'working', updatedAt: 20 }))),
    answerAction: vi.fn(async () => ok(task({ updatedAt: 20 }))), stopGrant: vi.fn(async () => ok(undefined)),
    list: vi.fn(async () => ok({ workspace, pages, grant: options.grant ? { grantedAt: 1, source: 'settings' as const } : null })),
    create: vi.fn(async ({ url }) => { const created = page(pages.some(item => item.id === PAGE_1) ? PAGE_2 : PAGE_1, { url, title: '' }); pages = [...pages, created]; return ok(created) }),
    navigate: vi.fn(async ({ pageId, url }) => ok(page(pageId, { url }))),
    back: vi.fn(async ({ pageId }) => ok(page(pageId))), forward: vi.fn(async ({ pageId }) => ok(page(pageId))), reload: vi.fn(async ({ pageId }) => ok(page(pageId))),
    close: vi.fn(async ({ pageId }) => { pages = pages.filter(item => item.id !== pageId); return ok(undefined) }),
    mount: vi.fn(async () => ok(undefined)),
    openLink: vi.fn(async () => ok({ destination: 'external' as const })),
  } })
  return { ...published, emit: published.publish }
}

let drafts: ThreadDraftStore
function owl(on: boolean, agents: { showBrowserPreviews?: boolean } = {}): void {
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'threads', platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    update: { owlFeatures: { 'quiet-browser': on } } } as unknown as AppContextValue)
  const state = threadsStateFixture()
  vi.mocked(useOptionalAgents).mockReturnValue({ state, threadDrafts: drafts, showBrowserPreviews: agents.showBrowserPreviews ?? true } as unknown as ReturnType<typeof useOptionalAgents>)
}

beforeEach(() => {
  drafts = new ThreadDraftStore(vi.fn(async () => null))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('browser-viewport') ? DOMRect.fromRect({ x: 1200, y: 180, width: 400, height: 520 }) : DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 })
  })
  // jsdom lays nothing out; an open menu reports a box the way a drawn one does, so the overlay check sees it.
  const rects = HTMLElement.prototype.getClientRects
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return this.getAttribute('role') === 'menu' ? [DOMRect.fromRect({ width: 220, height: 300 })] as unknown as DOMRectList : rects.call(this)
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(useOptionalApp).mockReset(); vi.mocked(useOptionalAgents).mockReset() })

function mount(browser: ReturnType<typeof fakeBrowser>, options: { surface?: 'browser' | 'files'; open?: boolean } = {}) {
  const store = new ToolsPanelStore(), playerStore = new BrowserPlayerStore()
  act(() => { store.setSurface(options.surface ?? 'browser'); store.setOpen(options.open ?? true) })
  const files = fakeFilesBridge({ 'visual-gate': { root: 'D:\\work\\workshop', token: TOKEN_A, tree: { 'a.txt': { kind: 'file', content: text('a') } } } })
  const view = render(<ToolsPanel focusedThreadId="visual-gate" state={threadsStateFixture()} files={files} browser={browser.bridge} store={store} playerStore={playerStore} />)
  return { store, playerStore, view }
}
const panel = () => screen.getByRole('complementary', { name: 'Tools', hidden: false })

describe('the quiet browser pane on Owl', () => {
  it('draws one row above the page, with no tab line for one page and no grant, task or steps lines', async () => {
    owl(true)
    const browser = fakeBrowser([page(PAGE_1)], { grant: true, tasks: [task({ steps: [{ id: 's1', action: 'click', status: 'completed', at: 1, detail: '' }] })] })
    mount(browser)
    const tools = panel()
    await within(tools).findByRole('textbox', { name: 'Address' })
    for (const name of ['Back', 'Forward', 'Reload', 'Screenshot to message', 'More browser actions']) expect(within(tools).getByRole('button', { name })).toBeInTheDocument()
    expect(within(tools).queryByRole('tablist', { name: 'Pages' })).not.toBeInTheDocument()
    expect(within(tools).queryByRole('button', { name: 'Comment on page' })).not.toBeInTheDocument()
    expect(within(tools).queryByText('This thread uses the browser without asking')).not.toBeInTheDocument()
    expect(within(tools).queryByText(/recorded steps/)).not.toBeInTheDocument()
    expect(within(tools).queryByRole('combobox', { name: 'Browser viewport size' })).not.toBeInTheDocument()
    // Not editing, the field shows the host and path with the title after it; its value stays the whole address.
    expect(within(tools).getByRole('textbox', { name: 'Address' })).toHaveValue('http://localhost:5173/sign-in')
    expect(tools.querySelector('.browser-pane__url')).toHaveTextContent('localhost:5173/sign-in')
    expect(tools.querySelector('.browser-pane__title')).toHaveTextContent('Sign in · Fieldnotes')
  })

  it('puts tabs on a line above the row only with two or more pages, with New page at its end', async () => {
    owl(true)
    mount(fakeBrowser([page(PAGE_1), page(PAGE_2, { title: 'Shared · Fieldnotes', url: 'http://localhost:5173/shared' })]))
    const tabs = await within(panel()).findByRole('tablist', { name: 'Pages' })
    expect(within(tabs).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Sign in · Fieldnotes', 'Shared · Fieldnotes'])
    expect(within(panel()).getByRole('button', { name: 'New page' })).toBeInTheDocument()
    // The row sits under the tab line, its own line rather than the surface's chrome.
    expect(within(panel()).getByRole('button', { name: 'Screenshot to message' }).closest('.browser-pane__row')).not.toHaveClass('tools-chrome')
  })

  it('keeps stable exactly as it was', async () => {
    owl(false)
    mount(fakeBrowser([page(PAGE_1)], { grant: true }))
    const tools = panel()
    await within(tools).findByRole('button', { name: 'Comment on page' })
    expect(within(tools).getByText('This thread uses the browser without asking')).toBeInTheDocument()
    expect(within(tools).getByRole('combobox', { name: 'Browser viewport size' })).toBeInTheDocument()
    expect(within(tools).queryByRole('button', { name: 'Screenshot to message' })).not.toBeInTheDocument()
    expect(within(tools).queryByRole('button', { name: 'More browser actions' })).not.toBeInTheDocument()
  })

  it('lists the page actions, the sizes and Ask before this thread uses the browser in More, and the page steps aside while it is open', async () => {
    owl(true)
    const browser = fakeBrowser([page(PAGE_1)], { grant: true })
    mount(browser)
    const tools = panel()
    await waitFor(() => expect(browser.bridge.mount).toHaveBeenCalledWith(expect.objectContaining({ pageId: PAGE_1, bounds: expect.objectContaining({ width: 400 }) })))
    const more = within(tools).getByRole('button', { name: 'More browser actions' })
    fireEvent.click(more)
    const menu = within(tools).getByRole('menu', { name: 'More browser actions' })
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['New page', 'Close page', 'Open in system browser', 'Stop sharing', 'Ask before this thread uses the browser'])
    expect(within(menu).getAllByRole('menuitemradio').map(item => [item.textContent, item.getAttribute('aria-checked')])).toEqual([
      ['Fit the pane', 'true'], ['Show at 1600 x 1000', 'false'], ['Show at 1280 x 800', 'false'], ['Show at 820 x 560', 'false'], ['Show at 390 x 844', 'false']])
    await waitFor(() => expect(browser.bridge.mount).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: PAGE_1, bounds: null })))
    expect(within(tools).getByText('The page steps aside while a menu or dialog is open.')).toBeInTheDocument()
    // Escape closes the menu and gives focus back to its button; the page comes back.
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(within(tools).queryByRole('menu')).not.toBeInTheDocument()
    expect(more).toHaveFocus()
    await waitFor(() => expect(browser.bridge.mount).toHaveBeenLastCalledWith(expect.objectContaining({ pageId: PAGE_1, bounds: expect.objectContaining({ width: 400 }) })))
    // Ask before this thread uses the browser is the grant's Stop.
    fireEvent.click(more)
    fireEvent.click(within(tools).getByRole('menuitem', { name: 'Ask before this thread uses the browser' }))
    await waitFor(() => expect(browser.bridge.stopGrant).toHaveBeenCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A }))
    expect(more).toHaveFocus()
    fireEvent.click(more)
    expect(within(tools).queryByRole('menuitem', { name: 'Ask before this thread uses the browser' })).not.toBeInTheDocument()
    fireEvent.click(within(tools).getByRole('menuitemradio', { name: 'Show at 820 x 560' }))
    await waitFor(() => expect(browser.bridge.viewport).toHaveBeenCalledWith(expect.objectContaining({ pageId: PAGE_1, width: 820, height: 560 })))
  })

  it('says what the agent is doing at the page\'s foot, with Pause and Resume', async () => {
    owl(true)
    const browser = fakeBrowser([page(PAGE_1)], { tasks: [task({ steps: [{ id: 's1', action: 'click', status: 'completed', at: 1, detail: '' }] })] })
    mount(browser)
    const tools = panel()
    const strip = await waitFor(() => { const found = tools.querySelector<HTMLElement>('.browser-pane__strip'); expect(found).not.toBeNull(); return found! })
    expect(strip).toHaveTextContent('Agent is browsing · clicked in the page')
    // The strip sits at the page's foot, after the page itself.
    expect(strip.previousElementSibling).toHaveClass('browser-viewport')
    fireEvent.click(within(strip).getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(browser.bridge.controlTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: TASK, control: 'pause' })))
    await waitFor(() => expect(tools.querySelector('.browser-pane__strip')).toHaveTextContent('Browsing paused · clicked in the page'))
    expect(within(tools).getByRole('button', { name: 'Resume' })).toBeInTheDocument()
    // A finished task leaves nothing above or below the page.
    act(() => browser.emit({ type: 'task', task: task({ status: 'completed', updatedAt: 30 }) }))
    expect(tools.querySelector('.browser-pane__strip')).toBeNull()
  })

  it('puts a waiting request in the strip\'s place, with Allow once, Allow this thread and Deny', async () => {
    owl(true)
    const pendingAction = { id: '44444444-4444-4444-8444-444444444444', action: { type: 'click' as const, x: 10, y: 10 }, description: 'Click in the page at 10, 10', expiresAt: Date.now() + 60_000 }
    const browser = fakeBrowser([page(PAGE_1)], { tasks: [task({ pendingAction })] })
    mount(browser)
    const request = await within(panel()).findByRole('group', { name: 'Browser action permission' })
    expect(request).toHaveTextContent('Click in the page at 10, 10')
    expect(request).toHaveClass('browser-pane__strip')
    expect(within(request).getAllByRole('button').map(button => button.textContent)).toEqual(['Allow once', 'Allow this thread to use the browser', 'Deny'])
    expect(within(panel()).queryByText(/Agent is browsing/)).not.toBeInTheDocument()
    fireEvent.click(within(request).getByRole('button', { name: 'Allow this thread to use the browser' }))
    await waitFor(() => expect(browser.bridge.answerAction).toHaveBeenCalledWith(expect.objectContaining({ allow: true, forThread: true })))
  })

  it('adds a picture of the page to the draft with Screenshot to message, with no comment step', async () => {
    owl(true)
    const browser = fakeBrowser([page(PAGE_1)])
    mount(browser)
    const tools = panel()
    fireEvent.click(await within(tools).findByRole('button', { name: 'Screenshot to message' }))
    await waitFor(() => expect(appendBrowserFeedback).toHaveBeenCalledWith(drafts, 'visual-gate', capture, '', expect.any(Boolean)))
    expect(browser.bridge.capture).toHaveBeenCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_A, pageId: PAGE_1 })
    const title = threadsStateFixture().host.threads.find(item => item.id === 'visual-gate')!.title
    await waitFor(() => expect(tools.querySelector('.tools-panel__status')).toHaveTextContent(`Added to the draft for ${title}`))
    expect(within(tools).queryByRole('textbox', { name: /comment/i })).not.toBeInTheDocument()
  })

  it('offers the addresses this thread\'s browser opened this session once its pages are closed', async () => {
    owl(true)
    const browser = fakeBrowser([page(PAGE_1)])
    mount(browser)
    const tools = panel()
    await within(tools).findByRole('textbox', { name: 'Address' })
    fireEvent.click(within(tools).getByRole('button', { name: 'More browser actions' }))
    fireEvent.click(within(tools).getByRole('menuitem', { name: 'Close page' }))
    const list = await within(tools).findByRole('region', { name: 'Opened this session' })
    expect(within(tools).getByRole('textbox', { name: 'Address for a new page' })).toHaveValue('')
    fireEvent.click(within(list).getByRole('button', { name: 'Open localhost:5173/sign-in' }))
    await waitFor(() => expect(browser.bridge.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://localhost:5173/sign-in' })))
  })
})

describe('the quiet pane after review', () => {
  it('keeps no addresses on stable, and keeps them newest first on Owl, a revisit moving to the front', async () => {
    owl(false)
    const { store } = mount(fakeBrowser([page(PAGE_1, { url: 'http://localhost:5173/a' })]))
    await within(panel()).findByRole('button', { name: 'Comment on page' })
    expect(store.browser.openedAddresses('visual-gate')).toEqual([])
    cleanup()

    const browser = new BrowserStore()
    expect(browser.openedAddresses('visual-gate')).toEqual([])
    browser.adopt(page(PAGE_1, { url: 'http://localhost:5173/a' }))
    expect(browser.openedAddresses('visual-gate')).toEqual([])
    browser.setRemembering(true)
    browser.adopt(page(PAGE_1, { url: 'http://localhost:5173/b' }))
    browser.adopt(page(PAGE_1, { url: 'http://localhost:5173/a' }))
    expect(browser.openedAddresses('visual-gate')).toEqual(['http://localhost:5173/a', 'http://localhost:5173/b'])
    // A second page somewhere else goes in front once; other pages' updates do not reorder the list.
    browser.adopt(page(PAGE_2, { url: 'http://localhost:5173/c' }))
    browser.adopt(page(PAGE_1, { url: 'http://localhost:5173/a', title: 'Again' }))
    expect(browser.openedAddresses('visual-gate')).toEqual(['http://localhost:5173/c', 'http://localhost:5173/a', 'http://localhost:5173/b'])
    for (let index = 0; index < 10; index++) browser.adopt(page(PAGE_2, { url: `http://localhost:5173/${index}` }))
    expect(browser.openedAddresses('visual-gate')).toHaveLength(8)
    browser.setRemembering(false)
    expect(browser.openedAddresses('visual-gate')).toEqual([])
  })

  it('counts a reload or the same address submitted again as a visit, and a title or sharing update as none', async () => {
    const A = 'http://localhost:5173/a', B = 'http://localhost:5173/b'
    const browser = fakeBrowser([page(PAGE_1, { url: A }), page(PAGE_2, { url: B })])
    const store = new BrowserStore()
    store.setRemembering(true)
    await store.activate(browser.bridge, 'visual-gate')
    expect(store.openedAddresses('visual-gate')).toEqual([B, A])
    // Main reports a reload of A as loading again: a visit.
    act(() => browser.emit({ type: 'page', page: page(PAGE_1, { url: A, status: 'loading' }) }))
    expect(store.openedAddresses('visual-gate')).toEqual([A, B])
    // Its title arriving, its finishing and the other page's sharing changing are not visits.
    act(() => browser.emit({ type: 'page', page: page(PAGE_1, { url: A, status: 'loading', title: 'A' }) }))
    act(() => browser.emit({ type: 'page', page: page(PAGE_1, { url: A, status: 'ready', title: 'A' }) }))
    act(() => browser.emit({ type: 'page', page: page(PAGE_2, { url: B, sharedOrigin: null }) }))
    expect(store.openedAddresses('visual-gate')).toEqual([A, B])
    // B's own address submitted again is a visit even when main answers with the page already loaded.
    await act(async () => { await store.navigate(browser.bridge, 'visual-gate', PAGE_2, B) })
    expect(store.openedAddresses('visual-gate')).toEqual([B, A])
  })

  it('keeps nothing about pages once they are closed', async () => {
    const browser = fakeBrowser([page(PAGE_1)])
    const store = new BrowserStore()
    store.setRemembering(true)
    await store.activate(browser.bridge, 'visual-gate')
    for (let index = 0; index < 20; index++) {
      const pageId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
      act(() => browser.emit({ type: 'page', page: page(pageId, { url: `http://localhost:5173/${index}` }) }))
      act(() => browser.emit({ type: 'closed', threadId: 'visual-gate', workspaceId: TOKEN_A, pageId }))
    }
    const held = (store as unknown as { lastSeen: Map<string, ReadonlyMap<string, unknown>> }).lastSeen
    expect([...held.values()].reduce((sum, pages) => sum + pages.size, 0)).toBe(1)
    expect(store.openedAddresses('visual-gate')).toHaveLength(8)
  })

  it('leaves New page for the page an agent just opened when the user is not in the address field', async () => {
    owl(true)
    const browser = fakeBrowser([page(PAGE_1)])
    mount(browser)
    const tools = panel()
    await within(tools).findByRole('textbox', { name: 'Address' })
    fireEvent.click(within(tools).getByRole('button', { name: 'More browser actions' }))
    fireEvent.click(within(tools).getByRole('menuitem', { name: 'New page' }))
    const fresh = within(tools).getByRole('textbox', { name: 'Address for a new page' })
    fireEvent.change(fresh, { target: { value: 'example.com' } })
    act(() => fresh.blur())
    act(() => browser.emit({ type: 'page', page: page(PAGE_2, { url: 'http://localhost:5173/agent' }) }))
    act(() => browser.emit({ type: 'task', task: task({ pageId: PAGE_2 }) }))
    await waitFor(() => expect(within(tools).getByRole('textbox', { name: 'Address' })).toHaveValue('http://localhost:5173/agent'))
    expect(within(tools).queryByRole('textbox', { name: 'Address for a new page' })).not.toBeInTheDocument()
  })

  it('sends focus to the address when Ask before this thread uses the browser takes More away', async () => {
    owl(true)
    const browser = fakeBrowser([], { grant: true })
    mount(browser)
    const tools = panel()
    fireEvent.click(await within(tools).findByRole('button', { name: 'More browser actions' }))
    fireEvent.click(within(tools).getByRole('menuitem', { name: 'Ask before this thread uses the browser' }))
    await waitFor(() => expect(within(tools).queryByRole('button', { name: 'More browser actions' })).not.toBeInTheDocument())
    await waitFor(() => expect(within(tools).getByRole('textbox', { name: 'Address for a new page' })).toHaveFocus())
  })

  it('says a page the agent cannot see is private on Owl with or without a grant, and leaves stable as it was', async () => {
    for (const [on, grant] of [[true, true], [true, false], [false, false]] as const) {
      owl(on)
      const browser = fakeBrowser([page(PAGE_1, { sharedOrigin: null })], { grant })
      const { view } = mount(browser)
      await within(panel()).findByRole('textbox', { name: 'Address' })
      await act(async () => { await Promise.resolve() })
      const line = within(panel()).queryByText('This page is private. The agent cannot see it')
      if (!on) { expect(line).not.toBeInTheDocument(); view.unmount(); continue }
      expect(line).toBeInTheDocument()
      fireEvent.click(within(panel()).getByRole('button', { name: 'Share with agent' }))
      await waitFor(() => expect(browser.bridge.share).toHaveBeenCalledWith(expect.objectContaining({ pageId: PAGE_1, enabled: true })))
      view.unmount()
    }
  })
})

describe('the browser pane opening on its own', () => {
  it('switches open Tools to Browser and the page the focused thread\'s agent just opened', async () => {
    owl(true)
    // Main lists both pages; without the switch, the last listed page would be the one Browser shows.
    const browser = fakeBrowser([page(PAGE_1), page(PAGE_2, { url: 'http://localhost:5173/other' })])
    const { store } = mount(browser, { surface: 'files' })
    await act(async () => { await Promise.resolve() })
    act(() => browser.emit({ type: 'task', task: task({ pageId: PAGE_1 }) }))
    await waitFor(() => expect(store.getSnapshot().surface).toBe('browser'))
    await waitFor(() => expect(store.browser.thread('visual-gate')?.activePageId).toBe(PAGE_1))
    expect(screen.queryByRole('complementary', { name: /Browser for/ })).not.toBeInTheDocument()
  })

  it('keeps the player away while Tools shows the thread’s browser, even on another page', async () => {
    owl(true)
    const browser = fakeBrowser([page(PAGE_1), page(PAGE_2, { url: 'http://localhost:5173/other' })], { tasks: [task({ pageId: PAGE_1, status: 'completed' })] })
    const { store } = mount(browser)
    await waitFor(() => expect(store.browser.thread('visual-gate')?.activePageId).toBe(PAGE_2))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('complementary', { name: /Browser for/ })).not.toBeInTheDocument()
    act(() => store.setOpen(false))
    expect(await screen.findByRole('complementary', { name: /Browser for/ })).toBeInTheDocument()
  })

  it('leaves Tools alone while it is closed, and the player floats instead', async () => {
    owl(true)
    const browser = fakeBrowser([page(PAGE_1)])
    const { store } = mount(browser, { surface: 'files', open: false })
    act(() => browser.emit({ type: 'task', task: task() }))
    expect(await screen.findByRole('complementary', { name: /Browser for/ })).toBeInTheDocument()
    expect(store.getSnapshot()).toMatchObject({ open: false, surface: 'files' })
  })

  it('does not take Tools while the user is working in it, or with Show the browser when an agent opens a page off, or on stable', async () => {
    for (const [on, previews, focusInside] of [[true, true, true], [true, false, false], [false, true, false]] as const) {
      owl(on, { showBrowserPreviews: previews })
      const browser = fakeBrowser([page(PAGE_1)])
      const { store, view } = mount(browser, { surface: 'files' })
      if (focusInside) act(() => within(panel()).getByRole('button', { name: 'Close tools panel' }).focus())
      act(() => browser.emit({ type: 'task', task: task() }))
      await act(async () => { await Promise.resolve() })
      expect(store.getSnapshot().surface).toBe('files')
      view.unmount()
    }
  })
})

describe('browser steps in plain words', () => {
  const step = (action: string, patch: Partial<BrowserTask['steps'][number]> = {}) => ({ id: 's', action, status: 'completed' as const, at: 1, detail: '', ...patch })
  it('says what each step did without guessing what was under a click', () => {
    expect(browserStepWords(step('click'))).toBe('clicked in the page')
    expect(browserStepWords(step('type'))).toBe('typed into the page')
    expect(browserStepWords(step('navigate', { url: 'http://localhost:5173/notes?x=1' }))).toBe('went to localhost:5173/notes?x=1')
    expect(browserStepWords(step('key', { detail: 'Pressed Enter.' }))).toBe('pressed Enter')
    expect(browserStepWords(step('click', { status: 'failed' }))).toBe('tried to click in the page')
    expect(browserStepWords(step('something-new'))).toBe('worked in the page')
  })
  it('names the page while the agent has taken no step yet', () => {
    expect(browsingWords(task(), 'http://localhost:5173/')).toEqual({ lead: 'Agent is browsing', last: 'localhost:5173' })
    expect(shortAddress('https://example.com/')).toBe('example.com')
  })
})
