/** Batch streamed display changes before an adapter clones its threads, not after the copy. */
export class ProviderSnapshotPublisher {
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly emit: () => void) {}

  publish(streaming = false): void {
    if (streaming) {
      this.timer ??= setTimeout(() => { this.timer = undefined; this.publish() }, 16)
      this.timer.unref?.()
      return
    }
    // Commands, permissions and lifecycle boundaries flush the latest state immediately.
    this.cancel()
    this.emit()
  }

  /** A connection reset must not leave a callback that can publish into its replacement. */
  cancel(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
  }
}
