import type { HostReceipt } from '../shared/hostProtocol'

/**
 * A settled receipt answers a retried command for this long, which covers a reconnect after a lost
 * acknowledgement; after it the entry is dropped, so a host that runs for weeks never fills up.
 */
const RECEIPT_LIFETIME_MS = 5 * 60_000
const RECEIPT_LIMIT = 10_000

export interface CommandReceipt { digest: string; receipt: HostReceipt; task: Promise<unknown>; settledAt?: number }
export interface CommandReceiptOptions { lifetimeMs?: number; limit?: number; now?: () => number }

/**
 * Each paired client's commands by the client's own request ID, so sending one again replays its result instead of
 * acting twice. A headless host's two listeners share one (ADR-0053): a desktop that moves between its SSH connection
 * and its tailnet connection, and retries a command whose acknowledgement the move lost, is answered from here.
 */
export class CommandReceipts {
  private readonly entries = new Map<string, CommandReceipt>()
  private readonly lifetime: number
  private readonly limit: number
  private readonly now: () => number

  constructor(options: CommandReceiptOptions = {}) {
    this.lifetime = options.lifetimeMs ?? RECEIPT_LIFETIME_MS
    this.limit = options.limit ?? RECEIPT_LIMIT
    this.now = options.now ?? Date.now
  }

  get(clientId: string, requestId: string): CommandReceipt | undefined { return this.entries.get(clientId + ':' + requestId) }

  /**
   * Drops receipts settled longer ago than the replay window, then the oldest settled one if still full, and says
   * whether there is room. Only pending work is busy.
   */
  makeRoom(): boolean {
    const now = this.now()
    for (const [key, entry] of this.entries) if (entry.settledAt !== undefined && now - entry.settledAt > this.lifetime) this.entries.delete(key)
    if (this.entries.size < this.limit) return true
    for (const [key, entry] of this.entries) if (entry.settledAt !== undefined) { this.entries.delete(key); return true }
    return false
  }

  /** Keeps a command's receipt, marked settled when its task ends either way. */
  record(clientId: string, requestId: string, entry: CommandReceipt): void {
    this.entries.set(clientId + ':' + requestId, entry)
    const settle = (): void => { entry.settledAt = this.now() }
    void entry.task.then(settle, settle)
  }
}
