import { createServer, type Server } from 'node:net'
import { VISUAL_PARTITION, VISUAL_SCHEME } from '../../shared/visualPages'
import type { VisualPageStore } from './visualPageStore'

/**
 * What seals an interactive visual from the network (ADR-0057): the session every page runs in, the proxy that session
 * points at, and the `<webview>` guest that shows a page.
 */

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
 * Seals the session every interactive visual runs in. It serves the page and nothing else: every request but a waiting
 * page address is cancelled, every permission is denied, downloads are blocked, and everything that would leave
 * goes to a proxy that answers nothing, loopback included, so even a connection that never passes through a request
 * filter (WebRTC, a preconnect) has nowhere to go.
 */
export async function sealVisualSession(session: VisualSessionLike, pages: Pick<VisualPageStore, 'isAwaitingLoad' | 'serve'>, deadProxyPort: number): Promise<void> {
  await session.setProxy({ mode: 'fixed_servers', proxyRules: `socks5://127.0.0.1:${deadProxyPort}`, proxyBypassRules: '<-loopback>' })
  session.protocol.handle(VISUAL_SCHEME, request => pages.serve(request.url))
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(details.resourceType === 'mainFrame' && pages.isAwaitingLoad(details.url)) }))
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
