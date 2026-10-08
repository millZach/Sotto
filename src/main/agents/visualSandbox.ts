import { join } from 'node:path'
import { VISUAL_PAGE_OPEN, visualPageRequestSchema, type VisualPageResult } from '../../shared/visualPages'
import type { AgentVisual } from '../../shared/visuals'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import { localVisualThreadId, VisualPageStore } from './visualPageStore'
import { admitVisualGuest, pointVisualSessionAtProxy, sealVisualGuest, sealVisualSession, type DeadProxy, type GuestNavigationEvent, type VisualGuestLike, type VisualSessionLike } from './visualSeal'

type PreventableEvent = { preventDefault(): void }
type AttachListener = (event: PreventableEvent, webPreferences: Record<string, unknown>, params: Record<string, string>) => void

/** The parts of a webContents the sandbox reads and seals: every one Electron makes, guests among them. */
export interface VisualContentsLike extends VisualGuestLike {
  getType(): string
  readonly session: unknown
  close(): void
  on(event: GuestNavigationEvent, listener: (event: PreventableEvent) => void): unknown
  on(event: 'will-attach-webview', listener: AttachListener): unknown
  once(event: 'destroyed', listener: () => void): unknown
}
type ContentsListener = (event: unknown, contents: VisualContentsLike) => void

/** The Electron pieces the sandbox needs, injected so a test can stand in for each. */
export interface VisualSandboxAdapters {
  readonly ipc: IpcMainAdapter
  /** Listens to `app`'s `web-contents-created`; the answer stops listening. */
  contentsCreated(listener: ContentsListener): () => void
  /** The `sotto-visual` in-memory session, made the first time it is asked for. */
  session(): VisualSessionLike
  /** The proxy that answers nothing, started the first time a page is asked for; `onLost` if it ever fails after. */
  startProxy(onLost: () => void): Promise<DeadProxy>
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

const NOT_SEALED = 'Sotto could not seal this page from the network, so it is not shown.'
const ON_ANOTHER_COMPUTER = 'This page belongs to a thread on another computer, so it is not shown here.'

/**
 * Answers the window's request for an interactive visual's page, admits a `<webview>` guest only for an address
 * awaiting its load in the main window, and seals every guest (ADR-0060). The session is sealed, and its proxy started,
 * the first time a page is asked for, so a launch that shows none sets up nothing. If the proxy cannot hold a port, no
 * page is shown; the next request tries again.
 */
export function installVisualSandbox(adapters: VisualSandboxAdapters, options: VisualSandboxOptions): () => void {
  const store = new VisualPageStore({ read: options.read, fontCss: options.fontCss })
  const preload = join(options.preloadDirectory, 'visual.js')
  // The session is sealed once; its proxy is replaced if it is ever lost. A page is shown only while both hold.
  let session: VisualSessionLike | undefined
  let proxy: DeadProxy | undefined
  let sealing: Promise<void> | undefined
  let disposed = false
  // The guests sealed on the session, closed if its proxy is ever lost.
  const guests = new Set<VisualContentsLike>()
  const sealed = (): boolean => session !== undefined && proxy !== undefined

  const seal = (): Promise<void> => sealing ??= (async () => {
    // A proxy lost while this seal is still being set up fails the attempt; the next request sets it up again.
    let lostEarly = false
    const next = await adapters.startProxy(() => { if (proxy === next) lose(next); else lostEarly = true })
    try {
      if (!session) { const made = adapters.session(); sealVisualSession(made, store); session = made }
      await pointVisualSessionAtProxy(session, next.port)
      if (disposed) throw new Error('The sandbox was closed.')
      if (lostEarly) throw new Error('The dead proxy was lost while the session was sealed.')
      proxy = next
    } catch (error) { next.close(); throw error }
  })().catch((error: unknown) => { sealing = undefined; throw error })

  // A lost proxy leaves its port free for another program, so nothing more is shown, the pages already running are
  // closed, and the session is pointed at a new proxy at once, or on the next request if that fails.
  const lose = (lost: DeadProxy): void => {
    if (proxy !== lost) return
    proxy = undefined
    sealing = undefined
    for (const guest of guests) guest.close()
    guests.clear()
    if (!disposed) void seal().catch(() => undefined)
  }

  const onContents: ContentsListener = (_event, contents) => {
    contents.on('will-attach-webview', ((event, webPreferences, params) => {
      const embedderTrusted = sealed() && contents === options.mainWebContents()
      if (!admitVisualGuest({ embedderTrusted, webPreferences, params, preload, isAwaitingLoad: url => store.isAwaitingLoad(url) })) event.preventDefault()
    }) as AttachListener)
    if (contents.getType() !== 'webview') return
    // Every guest is a visual's: one on any other session, or before the session is sealed, is closed before it loads.
    if (!sealed() || contents.session !== session) { contents.close(); return }
    sealVisualGuest(contents)
    guests.add(contents)
    contents.once('destroyed', () => { guests.delete(contents) })
  }
  const stopWatching = adapters.contentsCreated(onContents)

  adapters.ipc.handle(VISUAL_PAGE_OPEN, async (event, payload: unknown): Promise<VisualPageResult> => {
    if (!isAuthorizedIpcSender(event, options.senders(), ['main'])) throw new Error('VISUAL_MAIN_WINDOW_REQUIRED')
    const request = visualPageRequestSchema.parse(payload)
    // A key for another host names a paired host's thread: its visuals are there, never in this computer's store.
    const threadId = localVisualThreadId(request.threadId, options.localHostId())
    if (threadId === undefined) return { ok: false, reason: ON_ANOTHER_COMPUTER }
    try { await seal() } catch { return { ok: false, reason: NOT_SEALED, retry: true } }
    return store.open({ ...request, threadId })
  })

  return () => {
    disposed = true
    stopWatching()
    adapters.ipc.removeHandler(VISUAL_PAGE_OPEN)
    proxy?.close()
  }
}
