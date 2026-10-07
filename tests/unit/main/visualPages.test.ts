// @vitest-environment node
/**
 * An interactive visual's sealed page (ADR-0056): the one-time address main gives the window, the page it serves once
 * and the headers it serves it with, the session every page runs in, and the guest that shows one. The session and the
 * guest are recorded fakes here; the running app proves them in tests/e2e/visual-sandbox.spec.ts.
 */
import { connect } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import {
  admitVisualGuest, sealVisualGuest, sealVisualSession, startDeadProxy, VISUAL_PAGE_CSP, VISUAL_PAGE_HEADERS, VISUAL_PAGE_TOKEN_TTL_MS,
  VISUAL_PAGE_TOKENS_MAX, visualPageDocument, VisualPages, type VisualGuestLike, type VisualSessionLike,
} from '../../../src/main/agents/visualPages'
import type { AgentVisual } from '../../../src/shared/visuals'
import type { VisualTheme } from '../../../src/shared/visualGuest'

const theme: VisualTheme = { mode: 'dark', reducedMotion: false, tokens: {
  '--sotto-text': '#fffaff', '--sotto-muted': '#a5aab3', '--sotto-line': '#a5aab3', '--sotto-background': '#252e38', '--sotto-surface': '#333b45',
  '--sotto-border': '#848e9b', '--sotto-group': '#324e66', '--sotto-note': '#2c3d4e', '--sotto-accent': '#70b9ee',
} }
const page: AgentVisual = { id: 'page-1', title: 'A queue', kind: 'interactive', source: '<h1>Queue</h1><script>document.title = "drawn"</script>' }
const diagram: AgentVisual = { id: 'diagram-1', title: 'A flow', kind: 'diagram', source: 'flowchart LR\n  A --> B' }

function pages(overrides: Partial<ConstructorParameters<typeof VisualPages>[0]> = {}) {
  let now = 1_000
  const store: Record<string, AgentVisual[]> = { 'thread-1': [page, diagram] }
  const created = new VisualPages({ read: (threadId, visualId) => store[threadId]?.find(item => item.id === visualId), enabled: () => true, sealed: () => true,
    fontCss: '@font-face{font-family:"Figtree"}', now: () => now, ...overrides })
  return { pages: created, store, advance: (ms: number) => { now += ms } }
}
const opened = (target: VisualPages, request: Partial<{ threadId: string; visualId: string }> = {}): string => {
  const result = target.open({ threadId: 'thread-1', visualId: 'page-1', theme, ...request })
  if (!result.ok) throw new Error(result.reason)
  return result.url
}

describe('an interactive visual\'s page address', () => {
  it('is a one-time address on the sotto-visual scheme, good for exactly one load', async () => {
    const { pages: target } = pages()
    const url = opened(target)
    expect(url).toMatch(/^sotto-visual:\/\/page\/[A-Za-z0-9_-]{43}$/u)
    expect(target.live(url)).toBe(true)
    const first = target.serve(url)
    expect(first.status).toBe(200)
    expect(await first.text()).toContain('<h1>Queue</h1>')
    expect(target.live(url)).toBe(false)
    const second = target.serve(url)
    expect(second.status).toBe(404)
    expect(await second.text()).not.toContain('Queue')
  })

  it('is a new address every time, and an address never names the thread or the visual', () => {
    const { pages: target } = pages()
    const a = opened(target); const b = opened(target)
    expect(a).not.toBe(b)
    for (const url of [a, b]) for (const word of ['thread-1', 'page-1']) expect(url).not.toContain(word)
  })

  it('is refused for another thread, an unknown visual or a diagram, in plain words', () => {
    const { pages: target } = pages()
    for (const request of [{ threadId: 'thread-2' }, { visualId: 'missing' }, { visualId: 'diagram-1' }])
      expect(target.open({ threadId: 'thread-1', visualId: 'page-1', theme, ...request })).toEqual({ ok: false, reason: 'Sotto no longer has this visual. The visual is not shown. Its steps are below.' })
  })

  it('is refused while visuals are off, or while the session is not sealed', () => {
    expect(pages({ enabled: () => false }).pages.open({ threadId: 'thread-1', visualId: 'page-1', theme }))
      .toEqual({ ok: false, reason: 'Visuals are turned off in Settings. The visual is not shown. Its steps are below.' })
    expect(pages({ sealed: () => false }).pages.open({ threadId: 'thread-1', visualId: 'page-1', theme }))
      .toEqual({ ok: false, reason: 'Sotto could not seal this page from the network. The visual is not shown. Its steps are below.' })
  })

  it('lapses unloaded after its time, and serves nothing once its visual is gone or visuals are off', () => {
    const lapsed = pages()
    const url = opened(lapsed.pages)
    lapsed.advance(VISUAL_PAGE_TOKEN_TTL_MS)
    expect(lapsed.pages.live(url)).toBe(false)
    expect(lapsed.pages.serve(url).status).toBe(404)

    const rewound = pages()
    const kept = opened(rewound.pages)
    rewound.store['thread-1'] = [diagram]
    expect(rewound.pages.serve(kept).status).toBe(404)

    let on = true
    const switched = pages({ enabled: () => on })
    const before = opened(switched.pages)
    on = false
    expect(switched.pages.serve(before).status).toBe(404)
  })

  it('keeps at most a few addresses waiting, dropping the oldest', () => {
    const { pages: target } = pages()
    const urls = Array.from({ length: VISUAL_PAGE_TOKENS_MAX + 1 }, () => opened(target))
    expect(target.live(urls[0]!)).toBe(false)
    expect(urls.slice(1).every(url => target.live(url))).toBe(true)
  })

  it('reads nothing that is not exactly a page address', () => {
    const { pages: target } = pages()
    const url = opened(target)
    for (const near of [`${url}/`, `${url}?x=1`, url.replace('page', 'other'), url.toUpperCase(), `https://example.invalid/${url}`]) {
      expect(target.live(near)).toBe(false)
      expect(target.serve(near).status).toBe(404)
    }
    expect(target.live(url)).toBe(true)
  })
})

describe('the page Sotto serves', () => {
  it('carries the strict policy, no DNS prefetch and every feature off', async () => {
    const { pages: target } = pages()
    const response = target.serve(opened(target))
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('x-dns-prefetch-control')).toBe('off')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    const csp = response.headers.get('content-security-policy')!
    for (const directive of ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", 'img-src data: blob:', 'font-src data:',
      "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "form-action 'none'", "base-uri 'none'", 'sandbox allow-scripts']) expect(csp.split('; ')).toContain(directive)
    expect(csp).not.toMatch(/report-|https?:|\*/u)
    const features = response.headers.get('permissions-policy')!
    for (const feature of ['camera=()', 'microphone=()', 'geolocation=()', 'clipboard-read=()', 'usb=()', 'fullscreen=()']) expect(features).toContain(feature)
    expect(VISUAL_PAGE_HEADERS['Content-Security-Policy']).toBe(VISUAL_PAGE_CSP)
  })

  it('puts Sotto\'s charset, colour scheme, fonts and theme before the agent\'s page', () => {
    const document = visualPageDocument('<!doctype html><html><body>Mine</body></html>', { ...theme, mode: 'light' }, '@font-face{}')
    expect(document.startsWith('<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light">')).toBe(true)
    const fonts = document.indexOf('<style id="sotto-visual-fonts">')
    const style = document.indexOf('<style id="sotto-visual-theme">')
    const agent = document.indexOf('Mine')
    expect(fonts).toBeGreaterThan(0)
    expect(style).toBeGreaterThan(fonts)
    expect(agent).toBeGreaterThan(style)
    expect(document).toContain('--sotto-background:#252e38')
    expect(document).toContain('color-scheme:light')
  })
})

describe('the sealed session', () => {
  function fakeSession() {
    let beforeRequest: Parameters<VisualSessionLike['webRequest']['onBeforeRequest']>[0] | undefined
    let permission: Parameters<VisualSessionLike['setPermissionRequestHandler']>[0] | undefined
    let check: (() => boolean) | undefined
    let device: (() => boolean) | undefined
    let download: ((event: { preventDefault(): void }) => void) | undefined
    let handler: ((request: Request) => Response | Promise<Response>) | undefined
    const session: VisualSessionLike = {
      protocol: { handle: (_scheme, value) => { handler = value } },
      webRequest: { onBeforeRequest: listener => { beforeRequest = listener } },
      setPermissionRequestHandler: value => { permission = value },
      setPermissionCheckHandler: value => { check = value },
      setDevicePermissionHandler: value => { device = value },
      setSpellCheckerEnabled: vi.fn(),
      on: (_event, listener) => { download = listener },
      setProxy: vi.fn(async () => undefined),
    }
    const cancelled = (url: string, resourceType: string): boolean => {
      let answer: boolean | undefined
      beforeRequest!({ url, resourceType }, response => { answer = response.cancel })
      return answer!
    }
    return { session, cancelled, permission: () => permission!, check: () => check!, device: () => device!, download: () => download!, handler: () => handler! }
  }

  it('sends everything to a proxy that answers nothing, with no bypass, loopback included', async () => {
    const fake = fakeSession()
    await sealVisualSession(fake.session, pages().pages, 40_123)
    expect(fake.session.setProxy).toHaveBeenCalledWith({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:40123', proxyBypassRules: '<-loopback>' })
    expect(fake.session.setSpellCheckerEnabled).toHaveBeenCalledWith(false)
  })

  it('cancels every request but a live page address loaded as the page itself', async () => {
    const fake = fakeSession()
    const { pages: target } = pages()
    await sealVisualSession(fake.session, target, 40_123)
    const url = opened(target)
    expect(fake.cancelled(url, 'mainFrame')).toBe(false)
    for (const [other, type] of [[url, 'image'], [url, 'xhr'], [url, 'subFrame'], ['http://127.0.0.1:8080/', 'mainFrame'], ['http://127.0.0.1:8080/data.json', 'xhr'],
      ['https://example.com/a.png', 'image'], ['ws://127.0.0.1:9/', 'webSocket'], ['file:///C:/Windows/win.ini', 'mainFrame'], ['sotto-visual://page/unknown', 'mainFrame']] as const)
      expect(fake.cancelled(other, type)).toBe(true)
    // Served once, the address is spent, so even the page's own address is cancelled after.
    expect((await fake.handler()(new Request(url))).status).toBe(200)
    expect(fake.cancelled(url, 'mainFrame')).toBe(true)
  })

  it('denies every permission, every check and every device, and blocks downloads', async () => {
    const fake = fakeSession()
    await sealVisualSession(fake.session, pages().pages, 40_123)
    for (const name of ['media', 'geolocation', 'notifications', 'clipboard-read', 'fullscreen', 'pointerLock', 'hid', 'serial', 'usb']) {
      const callback = vi.fn()
      fake.permission()({}, name, callback)
      expect(callback).toHaveBeenCalledWith(false)
    }
    expect(fake.check()()).toBe(false)
    expect(fake.device()()).toBe(false)
    const event = { preventDefault: vi.fn() }
    fake.download()(event)
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('holds the dead proxy\'s port and closes every connection without a byte', async () => {
    const proxy = await startDeadProxy()
    try {
      const received = await new Promise<number>(done => {
        let bytes = 0
        const socket = connect(proxy.port, '127.0.0.1')
        socket.on('data', chunk => { bytes += chunk.length })
        socket.on('close', () => done(bytes))
        // A reset is how the proxy closes: it is the close, not a failure of the test.
        socket.on('error', () => undefined)
        socket.on('connect', () => socket.write(Buffer.from([5, 1, 0])))
      })
      expect(received).toBe(0)
    } finally { proxy.close() }
  })
})

describe('a visual\'s guest', () => {
  it('attaches only in Sotto\'s main window and only for a live address', () => {
    const { pages: target } = pages()
    const url = opened(target)
    const input = (embedderTrusted: boolean, src: string) => ({ embedderTrusted, webPreferences: {}, params: { src }, preload: '/out/preload/visual.js', live: (value: string) => target.live(value) })
    expect(admitVisualGuest(input(false, url))).toBe(false)
    expect(admitVisualGuest(input(true, 'https://example.com/'))).toBe(false)
    expect(admitVisualGuest(input(true, 'sotto-visual://page/unknown'))).toBe(false)
    expect(admitVisualGuest(input(true, url))).toBe(true)
  })

  it('gets the sealed preferences and partition whatever the element asked for', () => {
    const { pages: target } = pages()
    const url = opened(target)
    const webPreferences: Record<string, unknown> = { nodeIntegration: true, contextIsolation: false, sandbox: false, webSecurity: false, preload: 'C:/elsewhere.js', partition: 'persist:other', disablePopups: false }
    const params: Record<string, string> = { src: url, allowpopups: 'true', partition: 'persist:other', preload: 'file:///C:/elsewhere.js', webpreferences: 'nodeIntegration=yes' }
    expect(admitVisualGuest({ embedderTrusted: true, webPreferences, params, preload: '/out/preload/visual.js', live: value => target.live(value) })).toBe(true)
    expect(webPreferences).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false,
      disablePopups: true, disableDialogs: true, partition: 'sotto-visual', preload: '/out/preload/visual.js', nodeIntegrationInSubFrames: false })
    expect(params).toEqual({ src: url, partition: 'sotto-visual' })
  })

  it('limits WebRTC to the proxy, opens no window and follows no navigation', () => {
    const listeners = new Map<string, (event: { preventDefault(): void }) => void>()
    let open: (() => { action: 'deny' }) | undefined
    const guest: VisualGuestLike = {
      setWebRTCIPHandlingPolicy: vi.fn(),
      setWindowOpenHandler: handler => { open = handler },
      on: (event, listener) => { listeners.set(event, listener) },
    }
    sealVisualGuest(guest)
    expect(guest.setWebRTCIPHandlingPolicy).toHaveBeenCalledWith('disable_non_proxied_udp')
    expect(open!()).toEqual({ action: 'deny' })
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
      const event = { preventDefault: vi.fn() }
      listeners.get(name)!(event)
      expect(event.preventDefault).toHaveBeenCalled()
    }
  })
})
