import { join } from 'node:path'
import { VISUAL_PAGE_OPEN, visualPageRequestSchema, type VisualPageResult } from '../../shared/visualPages'
import type { AgentVisual } from '../../shared/visuals'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import { localVisualThreadId, VisualPageStore } from './visualPageStore'
import { admitVisualGuest, sealVisualGuest, sealVisualSession, type VisualGuestLike, type VisualSessionLike } from './visualSeal'

type PreventableEvent = { preventDefault(): void }
type AttachListener = (event: PreventableEvent, webPreferences: Record<string, unknown>, params: Record<string, string>) => void

/** The parts of a webContents the sandbox reads and seals: every one Electron makes, guests among them. */
export interface VisualContentsLike extends VisualGuestLike {
  getType(): string
  readonly session: unknown
  close(): void
  on(event: 'will-navigate' | 'will-frame-navigate' | 'will-redirect' | 'will-attach-webview', listener: (event: PreventableEvent) => void): unknown
  on(event: 'will-attach-webview', listener: AttachListener): unknown
}
type ContentsListener = (event: unknown, contents: VisualContentsLike) => void

/** The Electron pieces the sandbox needs, injected so a test can stand in for each. */
export interface VisualSandboxAdapters {
  readonly ipc: IpcMainAdapter
  /** `app`'s `web-contents-created`. */
  readonly contentsCreated: { on(listener: ContentsListener): void; off(listener: ContentsListener): void }
  /** The `sotto-visual` in-memory session, made the first time it is asked for. */
  session(): VisualSessionLike
  /** The proxy that answers nothing, started the first time a page is asked for. */
  startProxy(): Promise<{ readonly port: number; close(): void }>
}

export interface VisualSandboxOptions {
  /** The visual this computer's thread holds under this ID. */
  read(threadId: string, visualId: string): AgentVisual | undefined
  /** This computer's host ID, which a window's host-qualified thread key names for a thread here. */
  localHostId(): string | undefined
  /** Sotto's main window, the only renderer that may hold a visual's guest. */
  mainWebContents(): unknown
  senders(): readonly TrustedIpcSender[]
  /** The guest preload's folder, holding `visual.js`. */
  readonly preloadDirectory: string
  /** The Figtree faces, as `@font-face` rules with data URLs. */
  readonly fontCss: string
}

interface Sealed { readonly session: VisualSessionLike; readonly proxy: { close(): void } }

const NOT_SEALED = 'Sotto could not seal this page from the network, so it is not shown.'
const ELSEWHERE = 'This page belongs to a thread on another computer, so it is not shown here.'

/**
 * Answers the window's request for an interactive visual's page, admits a `<webview>` guest only for an address
 * awaiting its load in the main window, and seals every guest (ADR-0060). The session is sealed, and its proxy started,
 * the first time a page is asked for, so a launch that shows none sets up nothing. If the proxy cannot hold a port, no
 * page is shown; the next request tries again.
 */
export function installVisualSandbox(adapters: VisualSandboxAdapters, options: VisualSandboxOptions): () => void {
  const store = new VisualPageStore({ read: options.read, fontCss: options.fontCss })
  const preload = join(options.preloadDirectory, 'visual.js')
  let sealed: Sealed | undefined
  let sealing: Promise<Sealed> | undefined
  let disposed = false

  const seal = (): Promise<Sealed> => sealing ??= (async () => {
    const proxy = await adapters.startProxy()
    try {
      const session = adapters.session()
      await sealVisualSession(session, store, proxy.port)
      if (disposed) throw new Error('The sandbox was closed.')
      sealed = { session, proxy }
      return sealed
    } catch (error) { proxy.close(); throw error }
  })().catch((error: unknown) => { sealing = undefined; throw error })

  const onContents: ContentsListener = (_event, contents) => {
    contents.on('will-attach-webview', ((event, webPreferences, params) => {
      const embedderTrusted = sealed !== undefined && contents === options.mainWebContents()
      if (!admitVisualGuest({ embedderTrusted, webPreferences, params, preload, isAwaitingLoad: url => store.isAwaitingLoad(url) })) event.preventDefault()
    }) as AttachListener)
    if (contents.getType() !== 'webview') return
    // Every guest is a visual's: one on any other session, or before the session is sealed, is closed before it loads.
    if (!sealed || contents.session !== sealed.session) { contents.close(); return }
    sealVisualGuest(contents)
  }
  adapters.contentsCreated.on(onContents)

  adapters.ipc.handle(VISUAL_PAGE_OPEN, async (event, payload: unknown): Promise<VisualPageResult> => {
    if (!isAuthorizedIpcSender(event, options.senders(), ['main'])) throw new Error('VISUAL_MAIN_WINDOW_REQUIRED')
    const request = visualPageRequestSchema.parse(payload)
    // A key for another host names a paired host's thread: its visuals are there, never in this computer's store.
    const threadId = localVisualThreadId(request.threadId, options.localHostId())
    if (threadId === undefined) return { ok: false, reason: ELSEWHERE }
    try { await seal() } catch { return { ok: false, reason: NOT_SEALED } }
    return store.open({ ...request, threadId })
  })

  return () => {
    disposed = true
    adapters.contentsCreated.off(onContents)
    adapters.ipc.removeHandler(VISUAL_PAGE_OPEN)
    sealed?.proxy.close()
  }
}
