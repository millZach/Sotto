import { randomUUID } from 'node:crypto'

/**
 * One page-opening grant, shaped like an ADR-0004 policy record so authority reads the same wherever it lives:
 * an action, a resource, a scope, an effect, where it came from, and when it was granted, expires and was revoked.
 * It is held in memory only, because ADR-0020 has browser grants end with the app session; it never reaches
 * `memory.sqlite`, a log or a provider.
 */
export interface PageOpeningGrant {
  readonly id: string
  /** Opening a page for the thread, and navigating that thread's pages. Clicks and typing are never covered. */
  readonly action: 'browser-open-pages'
  readonly resource: '*'
  /** The Sotto thread ID the answer was given for; the grant reaches no other thread. */
  readonly scope: `thread:${string}`
  readonly effect: 'allow'
  /** Only the user's own answer in Tools creates one. Supervision, memory and provider confirmations cannot. */
  readonly source: 'user'
  readonly grantedAt: number
  /** Session lifetime: no clock expiry, but it ends with the thread, a Stop, the browser shutting down or the app. */
  readonly expiresAt: null
  revokedAt: number | null
}

/**
 * The session's page-opening grants, one per thread at most. A grant is created only from the user's answer to a
 * page-opening request and is consulted only before an open or a navigation, so it can never widen into clicks,
 * typing or observation of a page the user opened.
 */
export class PageOpeningGrants {
  private readonly grants = new Map<string, PageOpeningGrant>()

  /** Records the user's answer for `threadId`. Answering again keeps the first grant rather than stacking another. */
  grant(threadId: string, now = Date.now()): PageOpeningGrant {
    const current = this.active(threadId)
    if (current) return current
    const grant: PageOpeningGrant = { id: randomUUID(), action: 'browser-open-pages', resource: '*', scope: `thread:${threadId}`, effect: 'allow', source: 'user', grantedAt: now, expiresAt: null, revokedAt: null }
    this.grants.set(threadId, grant)
    return grant
  }

  /** The live grant for `threadId`, or null. A revoked record never allows. */
  active(threadId: string): PageOpeningGrant | null {
    const grant = this.grants.get(threadId)
    return grant && grant.revokedAt === null && grant.scope === `thread:${threadId}` ? grant : null
  }

  /** Ends the thread's grant. Returns whether there was one to end. */
  revoke(threadId: string, now = Date.now()): boolean {
    const grant = this.active(threadId)
    this.grants.delete(threadId)
    if (!grant) return false
    grant.revokedAt = now
    return true
  }

  /** Ends every grant: the browser is shutting down with its window or the app. */
  clear(now = Date.now()): string[] {
    const threads = [...this.grants.keys()].filter(threadId => this.active(threadId) !== null)
    for (const threadId of threads) this.revoke(threadId, now)
    return threads
  }
}
