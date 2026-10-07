// @vitest-environment node
/**
 * The gates around an interactive visual's sealed page (ADR-0057), with every Electron piece stood in for: only the main
 * window may ask for a page, a paired host's thread is never read from this computer's store, nothing is set up until a
 * page is asked for, a guest attaches only in the main window for an address awaiting its load, and a guest on any
 * other session is closed.
 */
import { describe, expect, it, vi } from 'vitest'
import { installVisualSandbox, type VisualContentsLike, type VisualSandboxAdapters } from '../../../src/main/agents/visualSandbox'
import type { VisualSessionLike } from '../../../src/main/agents/visualSeal'
import type { IpcInvocationEvent, TrustedIpcSender } from '../../../src/main/ipc/registerIpc'
import { VISUAL_PAGE_OPEN, type VisualPageResult } from '../../../src/shared/visualPages'
import type { AgentVisual } from '../../../src/shared/visuals'

const HERE = '11111111-2222-4333-8444-555555555555'
const THERE = '99999999-2222-4333-8444-555555555555'
const theme = { mode: 'dark', reducedMotion: false, tokens: Object.fromEntries(['--sotto-text', '--sotto-muted', '--sotto-line', '--sotto-background', '--sotto-surface',
  '--sotto-border', '--sotto-group', '--sotto-note', '--sotto-accent'].map(name => [name, '#123456'])) }
const page: AgentVisual = { id: 'v1', title: 'A queue', kind: 'interactive', source: '<h1>Queue</h1>' }

function renderer(url = 'file:///C:/Sotto/out/renderer/index.html') {
  const mainFrame = { parent: null, url }
  return { mainFrame, getURL: () => url, isDestroyed: () => false }
}

function fakeSession(): VisualSessionLike {
  return {
    protocol: { handle: vi.fn() }, webRequest: { onBeforeRequest: vi.fn() }, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(), setSpellCheckerEnabled: vi.fn(), on: vi.fn(), setProxy: vi.fn(async () => undefined),
  }
}

type Attach = (event: { preventDefault(): void }, webPreferences: Record<string, unknown>, params: Record<string, string>) => void
function contents(type: string, session: unknown) {
  const listeners = new Map<string, Attach>()
  const fake = {
    getType: () => type, session, close: vi.fn(), setWebRTCIPHandlingPolicy: vi.fn(), setWindowOpenHandler: vi.fn(),
    on: vi.fn((event: string, listener: Attach) => { if (!listeners.has(event)) listeners.set(event, listener) }),
  }
  const attach = (src: string): boolean => {
    const event = { preventDefault: vi.fn() }
    listeners.get('will-attach-webview')!(event, {}, { src })
    return event.preventDefault.mock.calls.length === 0
  }
  return { fake: fake as unknown as VisualContentsLike & typeof fake, attach }
}

function sandbox(overrides: { read?: (threadId: string, visualId: string) => AgentVisual | undefined; startProxy?: VisualSandboxAdapters['startProxy'] } = {}) {
  const handlers = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
  const created = new Set<(event: unknown, contents: VisualContentsLike) => void>()
  const visualSession = fakeSession()
  const proxy = { port: 41_234, close: vi.fn() }
  const main = renderer()
  const widget = renderer('file:///C:/Sotto/out/renderer/widget.html')
  const senders: TrustedIpcSender[] = [{ role: 'main', webContents: main, url: main.getURL() }, { role: 'widget', webContents: widget, url: widget.getURL() }]
  const read = vi.fn(overrides.read ?? ((threadId: string, visualId: string) => threadId === 'thread-1' && visualId === 'v1' ? page : undefined))
  const adapters: VisualSandboxAdapters = {
    ipc: { handle: (channel, listener) => { handlers.set(channel, listener) }, removeHandler: channel => { handlers.delete(channel) } },
    contentsCreated: { on: listener => { created.add(listener) }, off: listener => { created.delete(listener) } },
    session: vi.fn(() => visualSession),
    startProxy: vi.fn(overrides.startProxy ?? (async () => proxy)),
  }
  let mainContents: unknown = main
  const dispose = installVisualSandbox(adapters, { read, localHostId: () => HERE, mainWebContents: () => mainContents, senders: () => senders,
    preloadDirectory: '/out/preload', fontCss: '' })
  const ask = (from: ReturnType<typeof renderer>, threadId = 'thread-1'): Promise<VisualPageResult> =>
    Promise.resolve(handlers.get(VISUAL_PAGE_OPEN)!({ sender: from, senderFrame: from.mainFrame }, { threadId, visualId: 'v1', theme })) as Promise<VisualPageResult>
  const make = (type: string, session: unknown) => { const made = contents(type, session); for (const listener of created) listener({}, made.fake); return made }
  return { adapters, dispose, ask, make, main, widget, visualSession, proxy, read, handlers, created, setMain: (value: unknown) => { mainContents = value } }
}

describe('the window\'s request for a page', () => {
  it('is the main window\'s alone', async () => {
    const box = sandbox()
    await expect(box.ask(box.widget)).rejects.toThrow('VISUAL_MAIN_WINDOW_REQUIRED')
    await expect(box.ask(renderer('https://example.com/'))).rejects.toThrow('VISUAL_MAIN_WINDOW_REQUIRED')
    expect((await box.ask(box.main)).ok).toBe(true)
  })

  it('reads this computer\'s thread for its own host key, and refuses a paired host\'s without reading', async () => {
    const box = sandbox()
    expect((await box.ask(box.main, `host:${HERE}:thread-1`)).ok).toBe(true)
    expect(box.read).toHaveBeenLastCalledWith('thread-1', 'v1')
    box.read.mockClear()
    expect(await box.ask(box.main, `host:${THERE}:thread-1`)).toEqual({ ok: false, reason: 'This page belongs to a thread on another computer, so it is not shown here.' })
    expect(box.read).not.toHaveBeenCalled()
  })

  it('sets up the session and its proxy on the first request only', async () => {
    const box = sandbox()
    expect(box.adapters.startProxy).not.toHaveBeenCalled()
    expect(box.adapters.session).not.toHaveBeenCalled()
    await box.ask(box.main); await box.ask(box.main)
    expect(box.adapters.startProxy).toHaveBeenCalledOnce()
    expect(box.visualSession.setProxy).toHaveBeenCalledWith({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:41234', proxyBypassRules: '<-loopback>' })
  })

  it('shows no page when the proxy cannot hold a port, and tries again on the next request', async () => {
    let fail = true
    const box = sandbox({ startProxy: async () => { if (fail) throw new Error('no port'); return { port: 41_235, close: vi.fn() } } })
    expect(await box.ask(box.main)).toEqual({ ok: false, reason: 'Sotto could not seal this page from the network, so it is not shown.' })
    fail = false
    expect((await box.ask(box.main)).ok).toBe(true)
  })
})

describe('a guest', () => {
  const waitingAddress = async (box: ReturnType<typeof sandbox>): Promise<string> => {
    const result = await box.ask(box.main)
    if (!result.ok) throw new Error(result.reason)
    return result.url
  }

  it('attaches in the main window for an address awaiting its load, and nowhere else', async () => {
    const box = sandbox()
    const mainWindow = box.make('window', {})
    const otherWindow = box.make('window', {})
    box.setMain(mainWindow.fake)
    const url = await waitingAddress(box)
    expect(otherWindow.attach(url)).toBe(false)
    expect(mainWindow.attach('sotto-visual://page/unknown')).toBe(false)
    expect(mainWindow.attach('https://example.com/')).toBe(false)
    expect(mainWindow.attach(url)).toBe(true)
  })

  it('attaches nowhere before a page was asked for, when nothing is sealed', () => {
    const box = sandbox()
    const mainWindow = box.make('window', {})
    box.setMain(mainWindow.fake)
    expect(mainWindow.attach('sotto-visual://page/' + 'a'.repeat(43))).toBe(false)
  })

  it('is sealed on the visual session, and closed on any other or before the session is sealed', async () => {
    const box = sandbox()
    const early = box.make('webview', box.visualSession)
    expect(early.fake.close).toHaveBeenCalledOnce()
    await waitingAddress(box)
    const stranger = box.make('webview', fakeSession())
    expect(stranger.fake.close).toHaveBeenCalledOnce()
    expect(stranger.fake.setWebRTCIPHandlingPolicy).not.toHaveBeenCalled()
    const guest = box.make('webview', box.visualSession)
    expect(guest.fake.close).not.toHaveBeenCalled()
    expect(guest.fake.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp')
    const window = box.make('window', {})
    expect(window.fake.close).not.toHaveBeenCalled()
  })

  it('stops answering, and closes the proxy, when disposed', async () => {
    const box = sandbox()
    await waitingAddress(box)
    box.dispose()
    expect(box.handlers.has(VISUAL_PAGE_OPEN)).toBe(false)
    expect(box.created.size).toBe(0)
    expect(box.proxy.close).toHaveBeenCalledOnce()
  })
})
