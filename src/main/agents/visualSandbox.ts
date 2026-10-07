import { app, ipcMain, session, type WebContents } from 'electron'
import { join } from 'node:path'
import figtreeLatin from '../../renderer/src/assets/fonts/figtree-latin.woff2?inline'
import figtreeLatinExt from '../../renderer/src/assets/fonts/figtree-latin-ext.woff2?inline'
import { VISUAL_PAGE_OPEN, VISUAL_PARTITION, visualPageRequestSchema } from '../../shared/visualPages'
import type { AgentVisual } from '../../shared/visuals'
import { isAuthorizedIpcSender, type TrustedIpcSender } from '../ipc/registerIpc'
import { admitVisualGuest, sealVisualGuest, sealVisualSession, startDeadProxy, VisualPages } from './visualPages'

// Figtree travels with the page as data URLs, so showing it fetches nothing (ADR-0056).
const FIGTREE_CSS = [
  `@font-face{font-family:"Figtree";font-style:normal;font-weight:300 900;src:url(${figtreeLatin}) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}`,
  `@font-face{font-family:"Figtree";font-style:normal;font-weight:300 900;src:url(${figtreeLatinExt}) format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}`,
].join('')

export interface VisualSandboxOptions {
  read(threadId: string, visualId: string): AgentVisual | undefined
  /** Sotto's main window, the only renderer that may hold a visual's guest. */
  mainWebContents(): unknown
  senders(): readonly TrustedIpcSender[]
  /** The guest preload, `out/preload/visual.js`. */
  readonly preloadDirectory: string
}

/**
 * Seals the in-memory session interactive visuals run in, admits a `<webview>` guest only for a live page address in
 * the main window, seals every guest, and answers the window's request for a page (ADR-0056). If the dead proxy cannot
 * hold a port, the session is not sealed and no page is shown; the card shows the visual's steps instead.
 */
export async function installVisualSandbox(options: VisualSandboxOptions): Promise<() => void> {
  let proxy: Awaited<ReturnType<typeof startDeadProxy>> | undefined
  let sealed = false
  const pages = new VisualPages({ read: options.read, sealed: () => sealed, fontCss: FIGTREE_CSS })
  const visualSession = session.fromPartition(VISUAL_PARTITION)
  try {
    proxy = await startDeadProxy()
    await sealVisualSession(visualSession, pages, proxy.port)
    sealed = true
  } catch { sealed = false }
  const preload = join(options.preloadDirectory, 'visual.js')
  const onContents = (_event: unknown, contents: WebContents): void => {
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      const embedderTrusted = sealed && contents === options.mainWebContents()
      if (!admitVisualGuest({ embedderTrusted, webPreferences: webPreferences as Record<string, unknown>, params, preload, live: url => pages.live(url) })) event.preventDefault()
    })
    if (contents.getType() !== 'webview') return
    // Every guest is a visual's: anything that attached on another session is closed before it loads.
    if (contents.session !== visualSession) { contents.close(); return }
    sealVisualGuest(contents)
  }
  app.on('web-contents-created', onContents)
  ipcMain.handle(VISUAL_PAGE_OPEN, (event, payload: unknown) => {
    if (!isAuthorizedIpcSender(event, options.senders(), ['main'])) throw new Error('VISUAL_MAIN_WINDOW_REQUIRED')
    return pages.open(visualPageRequestSchema.parse(payload))
  })
  return () => {
    app.removeListener('web-contents-created', onContents)
    ipcMain.removeHandler(VISUAL_PAGE_OPEN)
    proxy?.close()
  }
}
