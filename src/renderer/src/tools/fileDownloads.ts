import type { FilesBridge } from '../../../shared/files'

/** How one file's download to this computer stands. Nothing is kept for a file that was never asked for. */
export type FileDownloadState =
  | { readonly status: 'going'; readonly received: number; readonly size: number }
  | { readonly status: 'saved'; readonly downloadId: string; readonly name: string }
  | { readonly status: 'stopped' }
  /** `message` is main's own sentence, or null where the window could not reach main at all. */
  | { readonly status: 'failed'; readonly message: string | null }

const keyOf = (threadId: string, path: string): string => `${threadId}\n${path}`

/**
 * The downloads of files on paired hosts this window asked for (ADR-0120, November 12 amendment), by the thread and the
 * path each was asked with. Kept outside any panel, so a download goes on while Files shows another file and its line is
 * there again when its file is shown again. Main writes the file; the window sees only how far it is and what it was named.
 */
export class FileDownloadsStore {
  private readonly states = new Map<string, FileDownloadState>()
  private readonly listeners = new Set<() => void>()
  private heard: FilesBridge | undefined
  private unhear: (() => void) | undefined

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  state(threadId: string, path: string): FileDownloadState | undefined { return this.states.get(keyOf(threadId, path)) }

  start(bridge: FilesBridge | undefined, threadId: string, path: string): void {
    const key = keyOf(threadId, path)
    if (this.states.get(key)?.status === 'going') return
    if (!bridge?.download) { this.set(key, { status: 'failed', message: null }); return }
    this.hear(bridge)
    this.set(key, { status: 'going', received: 0, size: 0 })
    void Promise.resolve().then(() => bridge.download!({ threadId, path })).then(result => {
      // A stop the reader asked for is said in the window's own words, not as a failure.
      if (this.states.get(key)?.status === 'stopped') return
      this.set(key, result.ok ? { status: 'saved', downloadId: result.value.downloadId, name: result.value.name } : { status: 'failed', message: result.error.message })
    }, () => { if (this.states.get(key)?.status !== 'stopped') this.set(key, { status: 'failed', message: null }) })
  }

  stop(bridge: FilesBridge | undefined, threadId: string, path: string): void {
    const key = keyOf(threadId, path)
    if (this.states.get(key)?.status !== 'going') return
    this.set(key, { status: 'stopped' })
    void Promise.resolve().then(() => bridge?.stopDownload?.({ threadId, path })).catch(() => undefined)
  }

  /** Forgets a download that is over, so its line goes. */
  dismiss(threadId: string, path: string): void {
    const key = keyOf(threadId, path)
    if (this.states.get(key)?.status === 'going' || !this.states.delete(key)) return
    for (const listener of [...this.listeners]) listener()
  }

  /** Progress is heard from the bridge that downloads, once: the window has one, which Files hands on under its own wrapper. */
  private hear(bridge: FilesBridge): void {
    if (this.heard === bridge) return
    this.unhear?.()
    this.heard = bridge
    this.unhear = bridge.onDownloadProgress?.(({ threadId, path, received, size }) => {
      const key = keyOf(threadId, path)
      if (this.states.get(key)?.status === 'going') this.set(key, { status: 'going', received, size })
    })
  }

  private set(key: string, state: FileDownloadState): void {
    this.states.set(key, state)
    for (const listener of [...this.listeners]) listener()
  }
}

export const fileDownloads = new FileDownloadsStore()
