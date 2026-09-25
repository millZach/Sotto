import { randomUUID } from 'node:crypto'

/**
 * One browser grant, shaped like an ADR-0004 policy record so authority reads the same wherever it lives: an
 * action, a resource, a scope, an effect, where it came from, and when it was granted, expires and was revoked.
 * It is held in memory only, because ADR-0029 has browser grants end with the app session; it never reaches
 * `memory.sqlite`, a log or a provider.
 */
export interface BrowserGrant {
  readonly id: string
  /** Opening a page, navigating, clicking and typing in the thread's own pages (ADR-0029), and nothing else. */
  readonly action: 'browser-use'
  readonly resource: '*'
  /** The Sotto thread ID the grant covers; it reaches no other thread. */
  readonly scope: `thread:${string}`
  readonly effect: 'allow'
  /** `settings` while the setting is on and the thread has not been stopped; `user` from the user's own answer in Tools. */
  readonly source: 'settings' | 'user'
  readonly grantedAt: number
  /** Session lifetime: no clock expiry, but it ends with the thread, a Stop, the setting turning off, the browser shutting down or the app. */
  readonly expiresAt: null
  revokedAt: number | null
}

/**
 * The session's browser grants, one per thread at most. `byDefault` reads the live **Let agents use the browser
 * without asking** setting. A `settings` grant exists only while that is true and the thread has not been
 * stopped; it is created lazily on the first `active` check and kept so its `grantedAt` stays stable rather than
 * moving every time it is read. A `user` grant is made only by the user's own answer in Tools and outlives the
 * setting turning off, so only Stop or the thread going away can end it.
 */
/** The actions ADR-0020 holds for an answer, and so the ones a browser grant can answer instead. */
export const grantCovers = (type: string): boolean => type === 'navigate' || type === 'click' || type === 'type'

export class BrowserGrants {
  private readonly grants = new Map<string, BrowserGrant>()
  private readonly stopped = new Set<string>()
  constructor(private readonly byDefault: () => boolean) {}

  /** Records the user's answer for `threadId`, lifting any Stop for it. Answering again keeps the first record. */
  grant(threadId: string, now = Date.now()): BrowserGrant {
    this.stopped.delete(threadId)
    const current = this.grants.get(threadId)
    if (current?.source === 'user' && current.revokedAt === null) return current
    const grant: BrowserGrant = { id: randomUUID(), action: 'browser-use', resource: '*', scope: `thread:${threadId}`, effect: 'allow', source: 'user', grantedAt: now, expiresAt: null, revokedAt: null }
    this.grants.set(threadId, grant)
    return grant
  }

  /** The live grant for `threadId`: the user's own answer, else the setting's while it applies. Null when stopped. */
  active(threadId: string, now = Date.now()): BrowserGrant | null {
    const current = this.grants.get(threadId)
    if (current?.source === 'user' && current.revokedAt === null) return current
    if (this.stopped.has(threadId) || !this.byDefault()) {
      if (current) { current.revokedAt ??= now; this.grants.delete(threadId) }
      return null
    }
    if (current?.source === 'settings') return current
    const grant: BrowserGrant = { id: randomUUID(), action: 'browser-use', resource: '*', scope: `thread:${threadId}`, effect: 'allow', source: 'settings', grantedAt: now, expiresAt: null, revokedAt: null }
    this.grants.set(threadId, grant)
    return grant
  }

  /** Ends whatever is active for `threadId`, whichever its source, and keeps it asking until granted again. Returns whether one was active. */
  stop(threadId: string, now = Date.now()): boolean {
    const grant = this.active(threadId, now)
    this.stopped.add(threadId)
    this.grants.delete(threadId)
    if (!grant) return false
    grant.revokedAt = now
    return true
  }

  /** Every thread this session has a grant or a Stop for, so a change of the setting can reach each. */
  threads(): string[] { return [...new Set([...this.grants.keys(), ...this.stopped])] }

  /** A thread Sotto no longer lists takes its grant with it, without counting as a Stop for a later thread of the same ID. */
  forget(threadId: string): void {
    this.grants.delete(threadId)
    this.stopped.delete(threadId)
  }

  /** Ends every grant: the browser is shutting down with its window or the app. */
  clear(now = Date.now()): string[] {
    const threads = [...this.grants.keys()].filter(threadId => this.active(threadId, now) !== null)
    for (const threadId of threads) this.stop(threadId, now)
    return threads
  }
}
