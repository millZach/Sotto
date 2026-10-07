import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import type { AgentVisual } from '../../shared/visuals'
import { VISUAL_PARTITION, VISUAL_SCHEME, type VisualPageRequest, type VisualPageResult } from '../../shared/visualPages'
import { visualThemeCss, type VisualTheme } from '../../shared/visualGuest'

/**
 * An interactive visual's sealed page (ADR-0057). Main keeps the page in its own visual store; the window asks for a
 * visual by thread and ID and is given a one-time address on the `sotto-visual:` scheme, which a `<webview>` guest on
 * an in-memory session loads once. Everything here is what makes that page unable to reach anything: the headers it is
 * served with, the session it runs in and the guest that shows it.
 */

/** The page's own policy. No report-uri: a violation report would itself be a request. */
export const VISUAL_PAGE_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", 'img-src data: blob:', 'font-src data:',
  "connect-src 'none'", "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "object-src 'none'", "manifest-src 'none'",
  "media-src 'none'", "form-action 'none'", "base-uri 'none'",
  // An opaque origin with scripts and nothing else: no popups, forms, modals, downloads, storage or top navigation.
  'sandbox allow-scripts',
].join('; ')

const OFF_FEATURES = ['accelerometer', 'ambient-light-sensor', 'autoplay', 'bluetooth', 'camera', 'clipboard-read', 'clipboard-write',
  'display-capture', 'encrypted-media', 'fullscreen', 'gamepad', 'geolocation', 'gyroscope', 'hid', 'idle-detection', 'local-fonts',
  'magnetometer', 'microphone', 'midi', 'payment', 'picture-in-picture', 'publickey-credentials-get', 'screen-wake-lock', 'serial',
  'usb', 'web-share', 'window-management', 'xr-spatial-tracking']

export const VISUAL_PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': VISUAL_PAGE_CSP,
  'X-DNS-Prefetch-Control': 'off',
  'Permissions-Policy': OFF_FEATURES.map(feature => `${feature}=()`).join(', '),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
})

/** How long an address waits to be loaded before it lapses, and how many may wait at once. */
export const VISUAL_PAGE_TOKEN_TTL_MS = 30_000
export const VISUAL_PAGE_TOKENS_MAX = 16
const PAGE_ADDRESS = new RegExp(`^${VISUAL_SCHEME}://page/([A-Za-z0-9_-]{43})$`, 'u')

export interface VisualPagesDependencies {
  /** The visual this thread holds under this ID, from main's own store; undefined when it holds none. */
  read(threadId: string, visualId: string): AgentVisual | undefined
  /** Whether the session is sealed: its dead proxy holds a port. Nothing is shown in a session that is not. */
  sealed(): boolean
  /** The Figtree faces, as `@font-face` rules with data URLs. */
  readonly fontCss: string
  readonly now?: () => number
}

interface Pending { readonly threadId: string; readonly visualId: string; readonly theme: VisualTheme; readonly expires: number }

const NOT_SHOWN = 'The visual is not shown. Its steps are below.'

/** The document a page is served as: Sotto's charset, colour scheme, fonts and theme first, then the agent's page. */
export function visualPageDocument(source: string, theme: VisualTheme, fontCss: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="${theme.mode}">`
    + `<style id="sotto-visual-fonts">${fontCss}</style><style id="sotto-visual-theme">${visualThemeCss(theme)}</style>\n${source}`
}

/** The page store's front: one-time addresses for the window, and the one load each allows. */
export class VisualPages {
  private readonly pending = new Map<string, Pending>()
  constructor(private readonly dependencies: VisualPagesDependencies) {}
  private now(): number { return this.dependencies.now?.() ?? Date.now() }

  /**
   * A one-time address for a visual this thread holds and that is an interactive page; why not, otherwise. Turning off
   * Let agents draw visuals in threads stops new visuals, not these: a page already in a thread still shows, as a
   * diagram does (ADR-0056).
   */
  open(request: VisualPageRequest): VisualPageResult {
    if (!this.dependencies.sealed()) return { ok: false, reason: `Sotto could not seal this page from the network. ${NOT_SHOWN}` }
    let visual: AgentVisual | undefined
    try { visual = this.dependencies.read(request.threadId, request.visualId) } catch { visual = undefined }
    if (visual?.kind !== 'interactive') return { ok: false, reason: `Sotto no longer has this visual. ${NOT_SHOWN}` }
    this.sweep()
    while (this.pending.size >= VISUAL_PAGE_TOKENS_MAX) this.pending.delete(this.pending.keys().next().value!)
    const token = randomBytes(32).toString('base64url')
    this.pending.set(token, { threadId: request.threadId, visualId: request.visualId, theme: request.theme, expires: this.now() + VISUAL_PAGE_TOKEN_TTL_MS })
    return { ok: true, url: `${VISUAL_SCHEME}://page/${token}` }
  }

  /** Whether this exact address is waiting to be loaded. A guest is attached for nothing else. */
  live(url: string): boolean {
    const token = PAGE_ADDRESS.exec(url)?.[1]
    const entry = token === undefined ? undefined : this.pending.get(token)
    return entry !== undefined && entry.expires > this.now()
  }

  /** The page for a live address, once; the address is spent whether or not the page can still be read. */
  serve(url: string): Response {
    const token = PAGE_ADDRESS.exec(url)?.[1]
    const entry = token === undefined ? undefined : this.pending.get(token)
    if (token !== undefined) this.pending.delete(token)
    if (!entry || entry.expires <= this.now()) return notFound()
    let visual: AgentVisual | undefined
    try { visual = this.dependencies.read(entry.threadId, entry.visualId) } catch { visual = undefined }
    if (visual?.kind !== 'interactive') return notFound()
    return new Response(visualPageDocument(visual.source, entry.theme, this.dependencies.fontCss), { status: 200, headers: { ...VISUAL_PAGE_HEADERS } })
  }

  private sweep(): void {
    const now = this.now()
    for (const [token, entry] of this.pending) if (entry.expires <= now) this.pending.delete(token)
  }
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { ...VISUAL_PAGE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } })
}

/** The parts of an Electron session the seal sets. */
export interface VisualSessionLike {
  protocol: { handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void }
  webRequest: { onBeforeRequest(listener: (details: { url: string; resourceType: string }, callback: (response: { cancel: boolean }) => void) => void): void }
  setPermissionRequestHandler(handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void): void
  setPermissionCheckHandler(handler: () => boolean): void
  setDevicePermissionHandler(handler: () => boolean): void
  setSpellCheckerEnabled(enabled: boolean): void
  on(event: 'will-download', listener: (event: { preventDefault(): void }) => void): unknown
  setProxy(config: { mode: 'fixed_servers'; proxyRules: string; proxyBypassRules: string }): Promise<void>
}

/**
 * Seals the session every interactive visual runs in. It serves the page and nothing else: every request but a live
 * page address is cancelled, every permission is denied, downloads are blocked, and everything that would leave
 * goes to a proxy that answers nothing, loopback included, so even a connection that never passes through a request
 * filter (WebRTC, a preconnect) has nowhere to go.
 */
export async function sealVisualSession(session: VisualSessionLike, pages: Pick<VisualPages, 'live' | 'serve'>, deadProxyPort: number): Promise<void> {
  await session.setProxy({ mode: 'fixed_servers', proxyRules: `socks5://127.0.0.1:${deadProxyPort}`, proxyBypassRules: '<-loopback>' })
  session.protocol.handle(VISUAL_SCHEME, request => pages.serve(request.url))
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(details.resourceType === 'mainFrame' && pages.live(details.url)) }))
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  session.setDevicePermissionHandler(() => false)
  session.setSpellCheckerEnabled(false)
  session.on('will-download', event => event.preventDefault())
}

/**
 * The proxy a sealed session points at: a loopback port Sotto holds, so no other program can take it, that closes
 * every connection without a byte.
 */
export function startDeadProxy(): Promise<{ readonly port: number; close(): void }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(socket => socket.destroy())
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('The dead proxy has no port.')); return }
      server.unref()
      resolve({ port: address.port, close: () => server.close() })
    })
  })
}

/** The preferences a visual's guest gets, whatever the `<webview>` element asked for. */
export function visualGuestPreferences(preload: string): Record<string, unknown> {
  return {
    sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
    webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, plugins: false, experimentalFeatures: false,
    enableWebSQL: false, spellcheck: false, navigateOnDragDrop: false, disableDialogs: true, disablePopups: true,
    autoplayPolicy: 'document-user-activation-required', partition: VISUAL_PARTITION, preload,
  }
}

/**
 * Whether a `<webview>` may attach: only in Sotto's main window, only for a live page address, and only with the
 * guest's preferences replaced by the sealed set. Anything else is refused before a guest exists.
 */
export function admitVisualGuest(input: { embedderTrusted: boolean; webPreferences: Record<string, unknown>; params: Record<string, string>; preload: string; live: (url: string) => boolean }): boolean {
  const { embedderTrusted, webPreferences, params } = input
  if (!embedderTrusted || typeof params.src !== 'string' || !input.live(params.src)) return false
  for (const key of Object.keys(webPreferences)) delete webPreferences[key]
  Object.assign(webPreferences, visualGuestPreferences(input.preload))
  for (const key of Object.keys(params)) if (key !== 'src') delete params[key]
  params.partition = VISUAL_PARTITION
  return true
}

/** The parts of a guest's webContents the seal sets. */
export interface VisualGuestLike {
  setWebRTCIPHandlingPolicy(policy: 'disable_non_proxied_udp'): void
  setWindowOpenHandler(handler: () => { action: 'deny' }): void
  on(event: 'will-navigate' | 'will-frame-navigate' | 'will-redirect' | 'will-attach-webview', listener: (event: { preventDefault(): void }) => void): unknown
}

/**
 * Seals a visual's guest: WebRTC may use only the proxy (which answers nothing), no new window opens, and no
 * navigation the page starts goes anywhere. The guest's one load is Electron's own, from the `src` it was attached
 * with; nothing the page does can start another.
 */
export function sealVisualGuest(guest: VisualGuestLike): void {
  guest.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  guest.setWindowOpenHandler(() => ({ action: 'deny' }))
  const refuse = (event: { preventDefault(): void }): void => event.preventDefault()
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview'] as const) guest.on(name, refuse)
}
