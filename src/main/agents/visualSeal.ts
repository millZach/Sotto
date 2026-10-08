import { createServer, type Server } from 'node:net'
import { VISUAL_PARTITION, VISUAL_SCHEME } from '../../shared/visualPages'
import type { VisualPageStore } from './visualPageStore'

/**
 * What seals an interactive visual from the network (ADR-0060): the session every page runs in, the proxy that session
 * points at, and the `<webview>` guest that shows a page.
 */

/**
 * How the `sotto-visual:` scheme is registered: standard, so a page has an origin to seal, and nothing more. Not secure,
 * no fetch, no CORS and no service workers.
 */
export const VISUAL_SCHEME_PRIVILEGES = Object.freeze({ scheme: VISUAL_SCHEME, privileges: Object.freeze({ standard: true }) })

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
 * Sends everything the session would send to a proxy that answers nothing, loopback included, so even a connection
 * that never passes through a request filter (WebRTC, a preconnect) has nowhere to go. Called again with a new port if
 * the proxy is ever lost.
 */
export async function pointVisualSessionAtProxy(session: VisualSessionLike, deadProxyPort: number): Promise<void> {
  await session.setProxy({ mode: 'fixed_servers', proxyRules: `socks5://127.0.0.1:${deadProxyPort}`, proxyBypassRules: '<-loopback>' })
}

/**
 * Seals the session every interactive visual runs in, once. It serves the page and nothing else: every request but a
 * waiting page address is cancelled, every permission is denied and downloads are blocked. Its proxy is set apart, by
 * `pointVisualSessionAtProxy`, and a page is shown only once both are done.
 */
export function sealVisualSession(session: VisualSessionLike, pages: Pick<VisualPageStore, 'isAwaitingLoad' | 'serve'>): void {
  session.protocol.handle(VISUAL_SCHEME, request => pages.serve(request.url))
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(details.resourceType === 'mainFrame' && pages.isAwaitingLoad(details.url)) }))
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  session.setDevicePermissionHandler(() => false)
  session.setSpellCheckerEnabled(false)
  session.on('will-download', event => event.preventDefault())
}

/** The parts of a `net.Server` the dead proxy uses. */
export type DeadProxyServer = Pick<Server, 'listen' | 'address' | 'close' | 'unref' | 'on' | 'off'>
export interface DeadProxy { readonly port: number; close(): void }

/**
 * The proxy a sealed session points at: a loopback port Sotto holds, so no other program can take it, that closes
 * every connection without a byte. The server keeps an error handler for its whole life. An error before it listens
 * fails the start. An error after it listens, such as a failed accept when the process is out of file handles, is not
 * fatal: the server keeps its port. If the server closes when Sotto did not close it, `onLost` is called, so the
 * session is pointed at a new one before another page is shown.
 */
export function startDeadProxy(onLost: () => void, create: (onSocket: (socket: { destroy(): void }) => void) => DeadProxyServer = createServer): Promise<DeadProxy> {
  return new Promise((resolve, reject) => {
    const server = create(socket => socket.destroy())
    let listening = false
    let closing = false
    server.on('error', () => {
      if (!listening) reject(new Error('The dead proxy could not start.'))
    })
    server.on('close', () => {
      if (!listening || closing) return
      closing = true
      onLost()
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('The dead proxy has no port.')); return }
      listening = true
      server.unref()
      resolve({ port: address.port, close: () => { closing = true; server.close() } })
    })
  })
}

/** The preferences a visual's guest gets, whatever the `<webview>` element asked for. */
export function visualGuestPreferences(preload: string): Record<string, unknown> {
  // Run the isolated, sandboxed preload in frames too, so they get the same protections as the page.
  return {
    sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, nodeIntegrationInWorker: false,
    webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, plugins: false, experimentalFeatures: false,
    enableWebSQL: false, spellcheck: false, navigateOnDragDrop: false, disableDialogs: true, disablePopups: true,
    autoplayPolicy: 'document-user-activation-required', partition: VISUAL_PARTITION, preload,
  }
}

/**
 * Whether a `<webview>` may attach: only in Sotto's main window, only for a page address awaiting its load, and only with the
 * guest's preferences replaced by the sealed set. Anything else is refused before a guest exists.
 */
export function admitVisualGuest(input: { embedderTrusted: boolean; webPreferences: Record<string, unknown>; params: Record<string, string>; preload: string; isAwaitingLoad: (url: string) => boolean }): boolean {
  const { embedderTrusted, webPreferences, params } = input
  if (!embedderTrusted || typeof params.src !== 'string' || !input.isAwaitingLoad(params.src)) return false
  for (const key of Object.keys(webPreferences)) delete webPreferences[key]
  Object.assign(webPreferences, visualGuestPreferences(input.preload))
  for (const key of Object.keys(params)) if (key !== 'src') delete params[key]
  params.partition = VISUAL_PARTITION
  return true
}

/** Every way a page could start a navigation or a nested guest; a visual's guest refuses each one. */
export const GUEST_NAVIGATION_EVENTS = ['will-navigate', 'will-frame-navigate', 'will-redirect', 'will-attach-webview'] as const
export type GuestNavigationEvent = typeof GUEST_NAVIGATION_EVENTS[number]

/** The parts of a guest's webContents the seal sets. */
export interface VisualGuestLike {
  setWebRTCIPHandlingPolicy(policy: 'disable_non_proxied_udp'): void
  setWindowOpenHandler(handler: () => { action: 'deny' }): void
  on(event: GuestNavigationEvent, listener: (event: { preventDefault(): void }) => void): unknown
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
  for (const name of GUEST_NAVIGATION_EVENTS) guest.on(name, refuse)
}
