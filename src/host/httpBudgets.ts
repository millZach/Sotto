/** The window a request budget is counted over. */
export const HTTP_WINDOW_MS = 60_000
/** The most buckets kept at once; the oldest goes first, so callers naming new buckets cannot grow it without end. */
const BUCKETS_MAX = 1024

/**
 * Requests a minute per bucket, for a listener that answers HTTP: the host's socket listener (one bucket per endpoint class
 * and caller) and the loopback listener that serves thread file pages (one bucket for every page). Plain Node, so the
 * headless host can use it.
 */
export class HttpBudgets {
  private readonly buckets = new Map<string, { window: number; count: number }>()
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Counts one request against a bucket, dropping buckets whose minute has passed. Undefined past its limit, when the
   * request is not counted; otherwise a refund, for a request that turns out not to count.
   */
  spend(bucket: string, limit: number): (() => void) | undefined {
    const now = this.now()
    for (const [key, entry] of this.buckets) if (now - entry.window >= HTTP_WINDOW_MS) this.buckets.delete(key)
    const entry = this.buckets.get(bucket) ?? { window: now, count: 0 }
    if (!this.buckets.has(bucket) && this.buckets.size >= BUCKETS_MAX) this.buckets.delete(this.buckets.keys().next().value!)
    this.buckets.set(bucket, entry)
    if (entry.count >= limit) return undefined
    entry.count++
    return () => { entry.count-- }
  }
}
