import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridge, BrowserEvent, BrowserPage } from '../../../../src/shared/browser'
import type { ToolsResult } from '../../../../src/shared/tools'
import { MessageContent } from '../../../../src/renderer/src/agents/MessageContent'
import { ToolsPanel } from '../../../../src/renderer/src/tools/ToolsPanel'
import { normalizeAddress } from '../../../../src/renderer/src/tools/browserStore'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { ThreadWebLinks } from '../../../../src/renderer/src/tools/webLinks'
import { threadsStateFixture } from '../liveAgentState'
import { TOKEN_A, fakeFilesBridge, text } from './fakeFilesBridge'

const workspace = { threadId: 'visual-gate', projectId: 'workshop', workingDirectory: 'D:\\work\\workshop', workspaceId: TOKEN_A }
const PAGE_1 = '11111111-1111-4111-8111-111111111111'
const PAGE_2 = '22222222-2222-4222-8222-222222222222'
const page = (id: string, patch: Partial<BrowserPage> = {}): BrowserPage =>
  ({ id, workspace, url: 'http://localhost:5173/', title: 'Vite App', status: 'ready', error: null, canGoBack: false, canGoForward: false, ...patch })
const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })

function fakeBrowser(initial: BrowserPage[] = []) {
  let pages = initial
  const listeners = new Set<(event: BrowserEvent) => void>()
  const bridge: BrowserBridge = {
    list: vi.fn(async () => ok({ workspace, pages })),
    create: vi.fn(async ({ url }) => { const created = page(pages.length ? PAGE_2 : PAGE_1, { url, title: '', status: 'loading' }); pages = [...pages, created]; return ok(created) }),
    navigate: vi.fn(async ({ pageId, url }) => ok(page(pageId, { url, canGoBack: true }))),
    back: vi.fn(async ({ pageId }) => ok(page(pageId))),
    forward: vi.fn(async ({ pageId }) => ok(page(pageId))),
    reload: vi.fn(async ({ pageId }) => ok(page(pageId))),
    close: vi.fn(async ({ pageId }) => { pages = pages.filter(item => item.id !== pageId); return ok(undefined) }),
    mount: vi.fn(async () => ok(undefined)),
    openLink: vi.fn(async ({ url, destination }) => destination === 'external'
      ? ok({ destination: 'external' as const }) : ok({ destination: 'embedded' as const, page: page(PAGE_2, { url, title: 'Docs' }) })),
    onEvent: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  return { bridge, emit: (event: BrowserEvent) => { for (const listener of [...listeners]) listener(event) } }
}

beforeEach(() => {
  // jsdom lays nothing out; the viewport reports the rectangle a real panel would give it.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('browser-viewport') ? DOMRect.fromRect({ x: 1200.4, y: 180, width: 399.6, height: 520 }) : DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 })
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function setup(browser: ReturnType<typeof fakeBrowser>, store = new ToolsPanelStore()) {
  act(() => { store.setOpen(true); store.setSurface('browser') })
  const files = fakeFilesBridge({ 'visual-gate': { root: 'D:\\work\\workshop', token: TOKEN_A, tree: { 'a.txt': { kind: 'file', content: text('a') } } } })
  render(<ToolsPanel focusedThreadId="visual-gate" state={threadsStateFixture()} files={files} browser={browser.bridge} store={store} />)
  return { store }
}

const panel = () => screen.getByRole('complementary', { name: 'Tools' })
const target = { threadId: 'visual-gate', workspaceId: TOKEN_A }
const shownAt = { x: 1200, y: 180, width: 400, height: 520 }

describe('browser addresses', () => {
  it('opens local servers over HTTP, other hosts over HTTPS, and refuses other schemes', () => {
    expect(normalizeAddress('localhost:5173')).toEqual({ url: 'http://localhost:5173/' })
    expect(normalizeAddress(' 127.0.0.1:8080/app ')).toEqual({ url: 'http://127.0.0.1:8080/app' })
    expect(normalizeAddress('example.com/docs')).toEqual({ url: 'https://example.com/docs' })
    expect(normalizeAddress('example.com:8443')).toEqual({ url: 'https://example.com:8443/' })
    expect(normalizeAddress('http://example.com')).toEqual({ url: 'http://example.com/' })
    expect(normalizeAddress('javascript:alert(1)')).toEqual({ error: 'The browser opens HTTP and HTTPS pages only.' })
    expect(normalizeAddress('file:///C:/Windows')).toEqual({ error: 'The browser opens HTTP and HTTPS pages only.' })
    expect(normalizeAddress('https://user:pass@example.com')).toEqual({ error: 'That is not a web address the browser can open.' })
    expect(normalizeAddress('two words')).toHaveProperty('error')
  })
})

describe('Browser surface', () => {
  it('opens a typed address, draws the page into the viewport and steps aside for overlays and hiding', async () => {
    const browser = fakeBrowser()
    const { store } = setup(browser)
    const address = await within(panel()).findByRole('textbox', { name: 'Address for a new page' })
    await userEvent.type(address, 'ftp://files{Enter}')
    expect(within(panel()).getByRole('alert')).toHaveTextContent('The browser opens HTTP and HTTPS pages only.')
    expect(browser.bridge.create).not.toHaveBeenCalled()
    await userEvent.clear(address)
    await userEvent.type(address, 'localhost:5173{Enter}')
    expect(browser.bridge.create).toHaveBeenCalledWith({ ...target, url: 'http://localhost:5173/' })
    expect(await within(panel()).findByRole('tab', { name: 'localhost:5173, loading', selected: true })).toBeInTheDocument()
    await waitFor(() => expect(browser.bridge.mount).toHaveBeenCalledWith({ ...target, pageId: PAGE_1, bounds: shownAt }))
    const mounts = vi.mocked(browser.bridge.mount).mock.calls.length
    await act(async () => { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
    // An unchanged rectangle is not sent again every frame.
    expect(vi.mocked(browser.bridge.mount).mock.calls.length).toBe(mounts)

    act(() => browser.emit({ type: 'page', page: page(PAGE_1, { title: 'Vite App', canGoBack: true }) }))
    expect(within(panel()).getByRole('tab', { name: 'Vite App', selected: true })).toBeInTheDocument()
    expect(within(panel()).getByRole('button', { name: 'Back' })).toBeEnabled()
    expect(within(panel()).getByRole('button', { name: 'Forward' })).toBeDisabled()

    const dialog = document.body.appendChild(Object.assign(document.createElement('div'), { role: 'dialog' }))
    dialog.setAttribute('role', 'dialog')
    vi.spyOn(dialog, 'getClientRects').mockReturnValue([DOMRect.fromRect({ width: 10, height: 10 })] as unknown as DOMRectList)
    await waitFor(() => expect(browser.bridge.mount).toHaveBeenLastCalledWith({ ...target, pageId: PAGE_1, bounds: null }))
    expect(within(panel()).getByText('The page steps aside while a menu or dialog is open.')).toBeInTheDocument()
    act(() => dialog.remove())
    await waitFor(() => expect(browser.bridge.mount).toHaveBeenLastCalledWith({ ...target, pageId: PAGE_1, bounds: shownAt }))

    act(() => store.setSurface('files'))
    expect(browser.bridge.mount).toHaveBeenLastCalledWith({ ...target, pageId: PAGE_1, bounds: null })
    expect(browser.bridge.close).not.toHaveBeenCalled()
  })

  it('shows an unavailable page as an explanation with Try again and the system browser, not an empty viewport', async () => {
    const browser = fakeBrowser([page(PAGE_1)])
    setup(browser)
    await waitFor(() => expect(browser.bridge.mount).toHaveBeenCalledWith({ ...target, pageId: PAGE_1, bounds: shownAt }))
    act(() => browser.emit({ type: 'page', page: page(PAGE_1, { status: 'unavailable', error: 'Nothing is listening on localhost:5173.' }) }))
    expect(browser.bridge.mount).toHaveBeenLastCalledWith({ ...target, pageId: PAGE_1, bounds: null })
    expect(within(panel()).getByText('This page could not load.')).toBeInTheDocument()
    expect(within(panel()).getByText('Nothing is listening on localhost:5173.')).toBeInTheDocument()
    await userEvent.click(within(panel()).getAllByRole('button', { name: 'Open in system browser' }).at(-1)!)
    expect(browser.bridge.openLink).toHaveBeenCalledWith({ url: 'http://localhost:5173/', destination: 'external' })
    await userEvent.click(within(panel()).getByRole('button', { name: 'Try again' }))
    expect(browser.bridge.reload).toHaveBeenCalledWith({ ...target, pageId: PAGE_1 })
  })

  it('navigates the open page from its address, keeps a second page in its own tab and closes pages', async () => {
    const browser = fakeBrowser([page(PAGE_1)])
    setup(browser)
    const address = await within(panel()).findByRole('textbox', { name: 'Address' })
    expect(address).toHaveValue('http://localhost:5173/')
    await userEvent.clear(address)
    await userEvent.type(address, 'localhost:5173/about{Enter}')
    expect(browser.bridge.navigate).toHaveBeenCalledWith({ ...target, pageId: PAGE_1, url: 'http://localhost:5173/about' })
    await waitFor(() => expect(within(panel()).getByRole('textbox', { name: 'Address' })).toHaveValue('http://localhost:5173/about'))

    await userEvent.click(within(panel()).getByRole('button', { name: 'New page' }))
    const fresh = within(panel()).getByRole('textbox', { name: 'Address for a new page' })
    await waitFor(() => expect(fresh).toHaveFocus())
    expect(browser.bridge.mount).toHaveBeenLastCalledWith({ ...target, pageId: PAGE_1, bounds: null })
    await userEvent.keyboard('{Escape}')
    expect(within(panel()).getByRole('tab', { name: 'Vite App' })).toHaveFocus()

    await userEvent.click(within(panel()).getByRole('button', { name: 'Close page: Vite App' }))
    expect(browser.bridge.close).toHaveBeenCalledWith({ ...target, pageId: PAGE_1 })
    expect(await within(panel()).findByText('No page is open for this thread.')).toBeInTheDocument()
  })
})

describe('Browser page placement', () => {
  const frames = (count = 3) => act(async () => { for (let index = 0; index < count; index++) await new Promise(resolve => requestAnimationFrame(resolve)) })
  const viewport = () => panel().querySelector('.browser-page')!

  it('explains a page main refused to show, stops asking every frame and shows it again on Try again', async () => {
    const browser = fakeBrowser([page(PAGE_1)])
    vi.mocked(browser.bridge.mount).mockResolvedValueOnce({ ok: false, error: { code: 'workspace-unavailable', message: 'The thread working directory is unavailable. Restore the folder and refresh Files.' } })
    setup(browser)
    const problem = await within(panel()).findByRole('alert')
    expect(problem).toHaveTextContent('This page could not be shown. The working folder is not available.')
    expect(viewport()).toContainElement(problem)
    const sent = vi.mocked(browser.bridge.mount).mock.calls.filter(([request]) => request.bounds !== null).length
    await frames()
    // The same rectangle on a refused page is not sent again every frame.
    expect(vi.mocked(browser.bridge.mount).mock.calls.filter(([request]) => request.bounds !== null)).toHaveLength(sent)

    await userEvent.click(within(viewport() as HTMLElement).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(within(panel()).queryByText(/could not be shown/u)).not.toBeInTheDocument())
    // The notice goes at once; the placement follows on the next frame.
    await waitFor(() => expect(browser.bridge.mount).toHaveBeenLastCalledWith({ ...target, pageId: PAGE_1, bounds: shownAt }))
    expect(vi.mocked(browser.bridge.mount).mock.calls.filter(([request]) => request.bounds !== null)).toHaveLength(sent + 1)
  })

  it('treats a mount that never answers like a refusal', async () => {
    const browser = fakeBrowser([page(PAGE_1)])
    vi.mocked(browser.bridge.mount).mockRejectedValueOnce(new Error('ipc gone'))
    setup(browser)
    expect(await within(panel()).findByRole('alert')).toHaveTextContent('This page could not be shown. Sotto did not answer.')
  })

  it('lists the workspace again after it changed, and Try again places the page in the new workspace', async () => {
    const TOKEN_B = TOKEN_A.replace(/^./u, 'b')
    const moved = { ...workspace, workspaceId: TOKEN_B }
    const browser = fakeBrowser([page(PAGE_1)])
    vi.mocked(browser.bridge.mount).mockResolvedValueOnce({ ok: false, error: { code: 'workspace-changed', message: 'The thread working directory changed. Refresh Files.' } })
    setup(browser)
    vi.mocked(browser.bridge.list).mockResolvedValue(ok({ workspace: moved, pages: [page(PAGE_1, { workspace: moved })] }))
    expect(await within(panel()).findByRole('alert')).toHaveTextContent('This page could not be shown. The working folder changed.')
    await waitFor(() => expect(browser.bridge.list).toHaveBeenCalledTimes(2))
    await frames()
    expect(browser.bridge.mount).not.toHaveBeenCalledWith(expect.objectContaining({ workspaceId: TOKEN_B, bounds: shownAt }))
    await userEvent.click(within(viewport() as HTMLElement).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(browser.bridge.mount).toHaveBeenLastCalledWith({ threadId: 'visual-gate', workspaceId: TOKEN_B, pageId: PAGE_1, bounds: shownAt }))
    expect(within(panel()).queryByText(/could not be shown/u)).not.toBeInTheDocument()
  })

  it('ignores a late answer for a page that is no longer the one shown', async () => {
    const browser = fakeBrowser([page(PAGE_1), page(PAGE_2, { title: 'Docs' })])
    let refuse!: (result: ToolsResult<void>) => void
    vi.mocked(browser.bridge.mount).mockImplementation(async ({ pageId, bounds }) => pageId === PAGE_2 && bounds !== null
      ? new Promise<ToolsResult<void>>(resolve => { refuse = resolve }) : ok(undefined))
    setup(browser)
    await waitFor(() => expect(browser.bridge.mount).toHaveBeenCalledWith({ ...target, pageId: PAGE_2, bounds: shownAt }))
    await userEvent.click(within(panel()).getByRole('tab', { name: 'Vite App' }))
    await waitFor(() => expect(browser.bridge.mount).toHaveBeenLastCalledWith({ ...target, pageId: PAGE_1, bounds: shownAt }))
    const sent = vi.mocked(browser.bridge.mount).mock.calls.length
    await act(async () => { refuse({ ok: false, error: { code: 'busy', message: 'Busy.' } }) })
    await frames()
    expect(within(panel()).queryByRole('alert')).not.toBeInTheDocument()
    // Nothing about the shown page changes: no hide, no second placement.
    expect(vi.mocked(browser.bridge.mount).mock.calls).toHaveLength(sent)
    await userEvent.click(within(panel()).getByRole('tab', { name: 'Docs' }))
    await waitFor(() => expect(browser.bridge.mount).toHaveBeenLastCalledWith({ ...target, pageId: PAGE_2, bounds: shownAt }))
    expect(within(panel()).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('ignores a late refusal for a rectangle the page has since moved from', async () => {
    const browser = fakeBrowser([page(PAGE_1)])
    let refuse!: (result: ToolsResult<void>) => void
    let calls = 0
    vi.mocked(browser.bridge.mount).mockImplementation(async ({ bounds }) => bounds !== null && ++calls === 1
      ? new Promise<ToolsResult<void>>(resolve => { refuse = resolve }) : ok(undefined))
    setup(browser)
    await waitFor(() => expect(calls).toBe(1))
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('browser-viewport') ? DOMRect.fromRect({ x: 900, y: 180, width: 700, height: 520 }) : DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 })
    })
    await waitFor(() => expect(browser.bridge.mount).toHaveBeenLastCalledWith({ ...target, pageId: PAGE_1, bounds: { x: 900, y: 180, width: 700, height: 520 } }))
    await act(async () => { refuse({ ok: false, error: { code: 'busy', message: 'Busy.' } }) })
    await frames()
    expect(within(panel()).queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('web links in a thread', () => {
  function transcript(browser: ReturnType<typeof fakeBrowser>, store: ToolsPanelStore) {
    render(<ThreadWebLinks threadId="visual-gate" threadTitle="Visual gate flake" bridge={browser.bridge} store={store}>
      <MessageContent text="See [the docs](https://example.com/docs) or [mail us](mailto:team@example.com)." />
    </ThreadWebLinks>)
  }

  it('lets the setting decide a click, and opens an embedded page in the tools panel for the link’s thread', async () => {
    const browser = fakeBrowser()
    const store = new ToolsPanelStore()
    transcript(browser, store)
    await userEvent.click(screen.getByRole('link', { name: 'the docs' }))
    await waitFor(() => expect(browser.bridge.openLink).toHaveBeenCalledWith({ url: 'https://example.com/docs', target }))
    await waitFor(() => expect(store.getSnapshot()).toMatchObject({ open: true, surface: 'browser' }))
    expect(store.browser.thread('visual-gate')?.activePageId).toBe(PAGE_2)

    store.setOpen(false)
    store.pin('grok-previews')
    await userEvent.click(screen.getByRole('link', { name: 'the docs' }))
    expect(await screen.findByText('Opened in Visual gate flake’s browser. The tools panel is pinned to another thread.')).toBeInTheDocument()
    expect(store.getSnapshot()).toMatchObject({ open: false, pinnedThreadId: 'grok-previews' })
  })

  it('offers a per-link choice from the keyboard and returns focus to the link', async () => {
    const browser = fakeBrowser()
    const openExternalLink = vi.fn(async () => ({ ok: true }))
    Object.defineProperty(window, 'sotto', { configurable: true, value: { openExternalLink } })
    try {
      transcript(browser, new ToolsPanelStore())
      const link = screen.getByRole('link', { name: 'the docs' })
      link.focus()
      fireEvent.keyDown(link, { key: 'F10', shiftKey: true })
      const menu = screen.getByRole('menu', { name: 'Link: example.com' })
      expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Open in Sotto browser', 'Open in system browser', 'Copy link'])
      expect(within(menu).getByRole('menuitem', { name: 'Open in Sotto browser' })).toHaveFocus()
      await userEvent.keyboard('{Escape}')
      expect(screen.queryByRole('menu')).toBeNull()
      expect(link).toHaveFocus()

      fireEvent.contextMenu(link, { clientX: 40, clientY: 60 })
      await userEvent.keyboard('{ArrowDown}{Enter}')
      await waitFor(() => expect(browser.bridge.openLink).toHaveBeenCalledWith({ url: 'https://example.com/docs', destination: 'external', target }))
      expect(link).toHaveFocus()

      const mail = screen.getByRole('link', { name: 'mail us' })
      fireEvent.contextMenu(mail, { clientX: 40, clientY: 60 })
      expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Open in mail app', 'Copy address'])
      await userEvent.keyboard('{Enter}')
      await waitFor(() => expect(openExternalLink).toHaveBeenCalledWith('mailto:team@example.com'))
    } finally {
      Reflect.deleteProperty(window, 'sotto')
    }
  })
})
