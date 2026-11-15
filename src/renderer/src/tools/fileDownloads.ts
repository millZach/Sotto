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
  /** The downloads main has not answered yet, each with whether the reader stopped it. Main holds a file until it answers. */
  private readonly asked = new Map<string, { stopped: boolean }>()
  private readonly listeners = new Set<() => void>()
  private heard: FilesBridge | undefined
  private unhear: (() => void) | undefined

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  state(threadId: string, path: string): FileDownloadState | undefined { return this.states.get(keyOf(threadId, path)) }

  /**
   * Whether main still has this file's download in hand: going, or stopped and not yet let go, which takes main until
   * the part it was reading arrives. Download waits for that, so a new one never meets the old one's answer.
   */
  busy(threadId: string, path: string): boolean { return this.asked.has(keyOf(threadId, path)) }

  start(bridge: FilesBridge | undefined, threadId: string, path: string): void {
    const key = keyOf(threadId, path)
    if (this.asked.has(key)) return
    if (!bridge?.download) { this.set(key, { status: 'failed', message: null }); return }
    this.hear(bridge)
    const ask = { stopped: false }
    this.asked.set(key, ask)
    this.set(key, { status: 'going', received: 0, size: 0 })
    void Promise.resolve().then(() => bridge.download!({ threadId, path })).then(result => {
      this.asked.delete(key)
      // A file main had already saved when the stop reached it is there, so the line says so rather than that nothing
      // was saved. Any other answer to a stopped download is the stop itself, which the line already says in the
      // window's own words, or said until the reader dismissed it.
      if (result.ok) this.set(key, { status: 'saved', downloadId: result.value.downloadId, name: result.value.name })
      else if (ask.stopped) this.tell()
      else this.set(key, { status: 'failed', message: result.error.message })
    }, () => {
      this.asked.delete(key)
      if (ask.stopped) this.tell()
      else this.set(key, { status: 'failed', message: null })
    })
  }

  stop(bridge: FilesBridge | undefined, threadId: string, path: string): void {
    const key = keyOf(threadId, path)
    const ask = this.asked.get(key)
    if (!ask || this.states.get(key)?.status !== 'going') return
    ask.stopped = true
    this.set(key, { status: 'stopped' })
    void Promise.resolve().then(() => bridge?.stopDownload?.({ threadId, path })).catch(() => undefined)
  }

  /** Forgets a download that is over, so its line goes. */
  dismiss(threadId: string, path: string): void {
    const key = keyOf(threadId, path)
    if (this.states.get(key)?.status === 'going' || !this.states.delete(key)) return
    this.tell()
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
    this.tell()
  }

  private tell(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

export const fileDownloads = new FileDownloadsStore()
