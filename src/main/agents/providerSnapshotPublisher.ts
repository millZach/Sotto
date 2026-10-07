/** How long a burst of streamed frames is gathered into one copy of the adapter's threads. */
export const PROVIDER_PUBLISH_WINDOW_MS = 16

/**
 * Batch streamed display changes before an adapter clones its threads, not after the copy.
 *
 * The first streamed frame of a burst goes out at once and opens a publish window; frames inside the window
 * become one publish at its end, with the latest state. An opening change (a message's first words, a new
 * activity record) is not held behind the window either: `countItems` counts what the adapter has, and a count
 * that moved since the last publish sends at once and starts a fresh window. That fresh window lets no second
 * opening change through, so a read that records a hundred messages in one go costs two copies rather than a
 * hundred. Nor does the window a trailing publish starts when that publish brought new items itself, so a flood
 * that goes on across tasks costs one copy a window like any other burst.
 */
export class ProviderSnapshotPublisher {
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending = false
  /** Whether this window lets no opening change cut it short: one already did, or it follows a flood's publish. */
  private cut = false
  /** What `countItems` counted at the last publish. */
  private published: number | undefined

  constructor(private readonly emit: () => void, private readonly countItems: () => number) {}

  publish(streaming = false): void {
    const opening = streaming && this.timer !== undefined && !this.cut && this.bringsNewItem()
    if (streaming && this.timer && !opening) { this.pending = true; return }
    // Commands, permissions and lifecycle boundaries flush the latest state immediately, and so does the
    // first frame of a burst. Only a streamed frame keeps a window open behind it.
    this.cancel()
    this.send()
    if (streaming) this.startWindow(opening)
  }

  /** A connection reset must not leave a callback that can publish into its replacement. */
  cancel(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    this.pending = false
    this.cut = false
  }

  private bringsNewItem(): boolean { return this.countItems() !== this.published }
  private send(): void {
    this.published = this.countItems()
    this.emit()
  }
  private startWindow(cut: boolean): void {
    this.cut = cut
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.cut = false
      // A burst that continues keeps coalescing: the trailing publish opens the next window, which is a flood's
      // when that publish brings new items of its own.
      if (this.pending) { this.pending = false; const flood = this.bringsNewItem(); this.send(); this.startWindow(flood) }
    }, PROVIDER_PUBLISH_WINDOW_MS)
    this.timer.unref?.()
  }
}

/**
 * What a publisher's `countItems` counts for an adapter: the messages its log has recorded and the activity
 * records its threads hold. A message's first words and a new record each move it; a chunk appended to a
 * message already recorded, or a record that only changed, does not. Nor does a new record that pushes the
 * oldest out of a thread already holding the most it keeps, which then waits for the window.
 */
export function adapterItemCount(log: { recorded(): number }, threads: Iterable<{ activities?: readonly unknown[] | undefined }>): number {
  let count = log.recorded()
  for (const thread of threads) count += thread.activities?.length ?? 0
  return count
}
