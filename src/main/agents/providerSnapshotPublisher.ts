/** How long a burst of streamed frames is gathered into one copy of the adapter's threads. */
export const PROVIDER_PUBLISH_WINDOW_MS = 16

/**
 * Batch streamed display changes before an adapter clones its threads, not after the copy.
 *
 * The first streamed frame of a burst goes out at once and opens a window; frames inside the window
 * become one publish at its end, with the latest state. A frame that opens something new (a message's
 * first words, a new activity record) is not held behind the window either: `opened` counts what the
 * adapter has, and a count that moved since the last publish sends at once. Later chunks of the same
 * message still coalesce, so the copy rate stays bounded by one per window plus one per new item.
 */
export class ProviderSnapshotPublisher {
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending = false
  /** What `opened` counted at the last publish. */
  private published: number | undefined

  constructor(private readonly emit: () => void, private readonly opened?: () => number) {}

  publish(streaming = false): void {
    if (streaming && this.timer && !this.opens()) { this.pending = true; return }
    // Commands, permissions and lifecycle boundaries flush the latest state immediately, and so does the
    // first frame of a burst. Only a streamed frame keeps a window open behind it.
    this.cancel()
    this.send()
    if (streaming) this.open()
  }

  /** A connection reset must not leave a callback that can publish into its replacement. */
  cancel(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    this.pending = false
  }

  private opens(): boolean { return this.opened !== undefined && this.opened() !== this.published }
  private send(): void {
    this.published = this.opened?.()
    this.emit()
  }
  private open(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      // A burst that continues keeps coalescing: the trailing publish opens the next window.
      if (this.pending) { this.pending = false; this.send(); this.open() }
    }, PROVIDER_PUBLISH_WINDOW_MS)
    this.timer.unref?.()
  }
}

/**
 * What a publisher's `opened` counts for an adapter: the messages its log has recorded and the activity
 * records its threads hold. A message's first words and a new record each move it; a chunk appended to a
 * message already recorded, or a record that only changed, does not.
 */
export function openedCount(log: { recorded(): number }, threads: Iterable<{ activities?: readonly unknown[] | undefined }>): number {
  let count = log.recorded()
  for (const thread of threads) count += thread.activities?.length ?? 0
  return count
}
