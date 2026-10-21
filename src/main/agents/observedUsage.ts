import type { UsageTokens } from '../../shared/threadUsage'
import type { UsageTokenObservation } from '../../shared/usageDashboard'
import { nativeUsageKey } from './nativeUsage'

/** What an adapter knows about one model call's tokens beyond the numbers: when, and whether it arrived live. */
export interface ObservedUsageFacts {
  readonly phase: 'live' | 'replay'
  readonly at?: string | undefined
  /** The provider's own turn or step the call belongs to, when it names one. */
  readonly group?: string | undefined
  /** When that turn or step began, as the provider or a live start said: what lets work after Clear usage count. */
  readonly groupStartedAt?: string | undefined
}
const dated = (value: string | undefined): string | undefined => value !== undefined && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined

/**
 * Usage observations from a provider that keeps no ledger in Sotto: Muse and OpenCode, counted in Sotto threads only
 * (ADR-0083, October 21, 2026). Each model call is published once per sighting under an identity the provider itself keeps
 * for it, hashed with the thread, so a call seen live and again when a session is read back is one row in the store.
 * Nothing is kept here: the Usage store owns the numbers. Built only where Usage is on, so with it off no listener exists.
 */
export class ObservedUsage {
  private readonly listeners = new Set<(record: UsageTokenObservation) => void>()
  constructor(private readonly provider: 'muse' | 'opencode') {}
  subscribe(listener: (record: UsageTokenObservation) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  /** One model call: `identity` is the provider's own stable name for it, never anything it said. */
  publish(threadId: string, identity: string, modelId: string, tokens: UsageTokens, facts: ObservedUsageFacts): void {
    if (!this.listeners.size || !Object.values(tokens).some(value => value !== undefined)) return
    const at = dated(facts.at), startedAt = facts.group !== undefined ? dated(facts.groupStartedAt) : undefined
    const record: UsageTokenObservation = {
      providerId: this.provider, threadId, recordKey: nativeUsageKey(this.provider, 'row', threadId, identity),
      ...(facts.group !== undefined ? { groupKey: nativeUsageKey(this.provider, 'group', threadId, facts.group) } : {}),
      modelId: modelId || 'unknown', tokens, ...(at ? { at } : {}), ...(startedAt ? { groupStartedAt: startedAt } : {}), phase: facts.phase,
      partial: tokens.input === undefined || tokens.output === undefined,
    }
    for (const listener of this.listeners) {
      try { listener({ ...record, tokens: { ...tokens } }) } catch { /* Accounting never changes native delivery. */ }
    }
  }
}
