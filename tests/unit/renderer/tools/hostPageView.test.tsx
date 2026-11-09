import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage } from '../../../../src/shared/browser'
import type { HostBrowserFrame } from '../../../../src/shared/hostBrowser'
import { addressFromHost } from '../../../../src/shared/hostBrowser'
import { hostEntityKey } from '../../../../src/shared/clientIdentity'
import { HostPageView, inputModifiers, keyInput, threadHost } from '../../../../src/renderer/src/tools/HostPageView'
import { ToolsPanel } from '../../../../src/renderer/src/tools/ToolsPanel'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { browserBridgeFixture, browserPage } from '../../../fixtures/renderer/browserBridge'
import { threadsStateFixture } from '../../../fixtures/renderer/liveAgentState'
import { TOKEN_A, fakeFilesBridge } from '../../../fixtures/renderer/fakeFilesBridge'

// The quiet pane and the paired host's browser are both Owl features; this window has both on.
vi.mock('../../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'quiet-browser' || id === 'paired-host-browser',
}))

const FORGE = '6f1c2d3e-4b5a-4c6d-8e7f-901234567890'
const threadId = hostEntityKey(FORGE, 'thread-1')
const workspace = { threadId, projectId: hostEntityKey(FORGE, 'project'), workingDirectory: '/home/forge/repo', workspaceId: TOKEN_A }
const PAGE = '11111111-1111-4111-8111-111111111111'
const page: BrowserPage = browserPage(workspace, { id: PAGE, url: 'http://localhost:5173/', title: 'Sign in' })
const target = { threadId, workspaceId: TOKEN_A, pageId: PAGE }

beforeEach(() => {
  // jsdom lays nothing out; the picture reports the size a real pane would give it.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('host-page__picture') ? 800 : 0 })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('host-page__picture') ? 600 : 0 })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('host-page__picture') ? DOMRect.fromRect({ x: 100, y: 50, width: 800, height: 600 }) : DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 })
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

function hostBridge() {
  const frames = new Set<(frame: HostBrowserFrame) => void>()
  const fixture = browserBridgeFixture({ workspace, pages: [page], commands: {
    onFrame: vi.fn(listener => { frames.add(listener); return () => { frames.delete(listener) } }),
    openLink: vi.fn(async () => ({ ok: true as const, value: { destination: 'external' as const } })),
  } })
  return { ...fixture, draw: (frame: HostBrowserFrame) => act(() => { for (const listener of frames) listener(frame) }) }
}

describe('a paired host\'s page drawn from its pictures (ADR-0198)', () => {
  it('watches at the pane\'s size once it settles, draws the newest picture of its own page, and stops watching when it goes', async () => {
    vi.useFakeTimers()
    const browser = hostBridge()
    const view = render(<HostPageView page={page} threadId={threadId} bridge={browser.bridge} shown connected />)
    expect(browser.bridge.watch).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    expect(browser.bridge.watch).toHaveBeenCalledExactlyOnceWith({ ...target, size: { width: 800, height: 600 } })
    browser.draw({ pageId: PAGE, data: 'QUJD', width: 800, height: 600 })
    browser.draw({ pageId: '22222222-2222-4222-8222-222222222222', data: 'T1RIRVI=', width: 800, height: 600 })
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,QUJD')
    view.unmount()
    expect(browser.bridge.unwatch).toHaveBeenCalledExactlyOnceWith(target)
  })

  it('sends the user\'s clicks, keys, scrolls and pasted text to the page, in page pixels, and leaves Tab to the window', async () => {
    const browser = hostBridge()
    render(<HostPageView page={page} threadId={threadId} bridge={browser.bridge} shown connected />)
    const picture = screen.getByRole('application', { name: 'Page: Sign in' })
    fireEvent.pointerDown(picture, { button: 0, clientX: 160, clientY: 90, detail: 1 })
    fireEvent.pointerUp(picture, { button: 0, clientX: 160, clientY: 90, detail: 1 })
    fireEvent.keyDown(picture, { key: 'a', code: 'KeyA', keyCode: 65 })
    fireEvent.keyDown(picture, { key: 'Tab', code: 'Tab', keyCode: 9 })
    fireEvent.wheel(picture, { deltaY: 3, deltaMode: 1, clientX: 200, clientY: 150 })
    fireEvent.paste(picture, { clipboardData: { getData: () => 'hello forge' } })
    await waitFor(() => expect(browser.bridge.input).toHaveBeenCalledTimes(5))
    expect(vi.mocked(browser.bridge.input).mock.calls.map(([request]) => request.input)).toEqual([
      { type: 'mouse', action: 'down', x: 60, y: 40, button: 'left', clickCount: 1, modifiers: 0 },
      { type: 'mouse', action: 'up', x: 60, y: 40, button: 'left', clickCount: 1, modifiers: 0 },
      { type: 'key', action: 'down', key: 'a', code: 'KeyA', keyCode: 65, text: 'a', modifiers: 0 },
      { type: 'wheel', x: 100, y: 100, deltaX: 0, deltaY: 48, modifiers: 0 },
      { type: 'text', text: 'hello forge' },
    ])
    expect(document.activeElement).toBe(picture)
  })

  it('keeps the last picture greyed and sends nothing while the host is away', async () => {
    vi.useFakeTimers()
    const browser = hostBridge()
    const view = render(<HostPageView page={page} threadId={threadId} bridge={browser.bridge} shown connected={false} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(150) })
    fireEvent.pointerDown(screen.getByRole('application'), { button: 0, clientX: 160, clientY: 90 })
    expect(browser.bridge.watch).not.toHaveBeenCalled()
    expect(browser.bridge.input).not.toHaveBeenCalled()
    expect(view.container.querySelector('.host-page')?.hasAttribute('data-off')).toBe(true)
  })

  it('reads keys, modifiers, the thread\'s host and the address to open on this computer', () => {
    expect(inputModifiers({ altKey: true, ctrlKey: true, metaKey: false, shiftKey: true })).toBe(11)
    expect(keyInput({ key: 'Enter', code: 'Enter', keyCode: 13, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }, 'down')).toMatchObject({ text: '\r' })
    expect(keyInput({ key: 'c', code: 'KeyC', keyCode: 67, altKey: false, ctrlKey: true, metaKey: false, shiftKey: false }, 'down')).not.toHaveProperty('text')
    expect(keyInput({ key: 'Tab', code: 'Tab', keyCode: 9, altKey: false, ctrlKey: false, metaKey: false, shiftKey: true }, 'down')).toBeNull()
    const state = threadsStateFixture()
    state.connections = [{ hostId: FORGE, name: 'forge', kind: 'remote', connected: true, browser: true }]
    expect(threadHost(state, threadId)).toEqual({ hostId: FORGE, name: 'forge', connected: true, browser: true })
    expect(threadHost(state, 'visual-gate')).toBeUndefined()
    expect(addressFromHost('http://localhost:5173/sign-in?x=1#top', 'forge.tail5728ca.ts.net')).toBe('http://forge.tail5728ca.ts.net:5173/sign-in?x=1#top')
    expect(addressFromHost('http://127.0.0.1:3000/', 'forge')).toBe('http://forge:3000/')
    expect(addressFromHost('http://[::1]:8080/', 'forge')).toBe('http://forge:8080/')
    expect(addressFromHost('https://example.com/', 'forge')).toBe('https://example.com/')
  })
})

describe('Tools > Browser for a paired host\'s thread (ADR-0198)', () => {
  function setup(connection: { connected: boolean; browser?: true }) {
    const state = threadsStateFixture()
    const sample = state.host.threads.find(item => item.id === 'visual-gate')!
    state.host.threads = [{ ...sample, id: threadId, remoteHost: true, hostId: FORGE, hostLabel: 'forge', title: 'Check the sign-in page' }]
    state.connections = [{ hostId: FORGE, name: 'forge', kind: 'remote', ...connection }]
    const store = new ToolsPanelStore()
    act(() => { store.setOpen(true); store.setSurface('browser') })
    const browser = hostBridge()
    const files = fakeFilesBridge({})
    render(<ToolsPanel focusedThreadId={threadId} state={state} files={files} browser={browser.bridge} store={store} />)
    return browser
  }

  it('shows the host\'s page with the row saying where it runs, without Point at something, Screenshot to message or page sizes', async () => {
    const browser = setup({ connected: true, browser: true })
    expect(await screen.findByRole('application', { name: 'Page: Sign in' })).toBeTruthy()
    expect(screen.getByTitle('This page runs on forge').textContent).toBe('on forge')
    expect(screen.queryByRole('button', { name: 'Point at something' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Screenshot to message' })).toBeNull()
    expect(browser.bridge.mount).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'More browser actions' }))
    expect(screen.queryByRole('menuitemradio', { name: 'Fit the pane' }) ?? screen.queryByText('Fit the pane')).toBeNull()
    fireEvent.click(screen.getByText('Open in system browser'))
    await waitFor(() => expect(browser.bridge.openLink).toHaveBeenCalledWith({ url: 'http://localhost:5173/', destination: 'external', target: { threadId, workspaceId: TOKEN_A } }))
  })

  it('says it is reconnecting over the last picture while the host is away', async () => {
    setup({ connected: false, browser: true })
    expect(await screen.findByText('Reconnecting to forge. The page stays open there, and the agent keeps browsing.')).toBeTruthy()
  })

  it('says a host with no browser should get one, and checks again when asked', async () => {
    const state = threadsStateFixture()
    const sample = state.host.threads.find(item => item.id === 'visual-gate')!
    state.host.threads = [{ ...sample, id: threadId, remoteHost: true, hostId: FORGE, hostLabel: 'forge', title: 'Check the sign-in page' }]
    state.connections = [{ hostId: FORGE, name: 'forge', kind: 'remote', connected: true, browser: true }]
    const store = new ToolsPanelStore()
    act(() => { store.setOpen(true); store.setSurface('browser') })
    const available = vi.fn().mockResolvedValueOnce({ ok: true, value: { available: false } }).mockResolvedValue({ ok: true, value: { available: true } })
    const browser = browserBridgeFixture({ workspace, pages: [], commands: { available } })
    render(<ToolsPanel focusedThreadId={threadId} state={state} files={fakeFilesBridge({})} browser={browser.bridge} store={store} />)
    expect(await screen.findByText('forge has no browser for this thread.')).toBeTruthy()
    expect(screen.getByText('Install Chromium or Google Chrome on forge, then press Check again.')).toBeTruthy()
    expect(available).toHaveBeenCalledWith({ threadId })
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByRole('textbox', { name: 'Address for a new page' })).toBeTruthy()
    expect(screen.queryByText('forge has no browser for this thread.')).toBeNull()
  })

  it('tells an older host to update, as the browser stays on that machine', () => {
    const browser = setup({ connected: true })
    expect(screen.getByText('Browser is on the host machine.')).toBeTruthy()
    expect(screen.getByText('Update Sotto on forge in Settings > Hosts & phones to use it here.')).toBeTruthy()
    expect(browser.bridge.list).not.toHaveBeenCalled()
  })
})
