import { join } from 'node:path'
import type { SpendingReport } from '../../../shared/pluginAccountCopies'
import type { PluginAccount } from '../../../shared/plugins'
import { everyMonthStart, HeardSpending, monthOf } from './spending'

/** A connected host as shared spending reaches it: its identity, and the two calls where it lists `plugin-meshy-spending`. */
export interface SpendingTarget {
  readonly hostId: string
  readonly kind: 'local' | 'remote'
  readonly service: {
    readonly supportsPluginMeshySpending?: boolean | undefined
    sharePluginMeshySpending?(reports: readonly SpendingReport[]): Promise<SpendingReport[]>
    subscribePluginMeshySpending?(listener: (reports?: readonly SpendingReport[]) => void): () => void
  }
}

/**
 * The desktop's side of shared spending (ADR-0205): one monthly limit for a Meshy account here and on every paired
 * host holding its copy. This computer counts its own 3D models and adds what each host last said its own threads
 * spent, connected or not, so a host away still counts for what it spent before it went. Each host is told what the
 * account spent everywhere but there: here, and on every other host as last heard. It is told on connecting, when
 * this computer's count changes, when another host's does, and when the month turns.
 *
 * What was heard is kept in a small file in this computer's data folder, by the host's identity: counts and account
 * IDs, never a secret. An older host, which does not list `plugin-meshy-spending`, is told nothing and says nothing.
 */
export class MeshySpendingSync {
  private readonly heard: HeardSpending
  /** The connection each host is followed on, and the way to stop following it. */
  private readonly following = new Map<string, { readonly service: SpendingTarget['service']; readonly stop: () => void }>()
  private readonly telling = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  private readonly stopMonths: () => void
  private counted = new Map<string, number>()
  private looking: Promise<void> | undefined
  private lookAgain = false
  private closed = false

  constructor(directory: string, private readonly options: {
    /** This computer's own credits this month, by account ID. */
    readonly own: () => Promise<ReadonlyMap<string, number>>
    readonly accounts: () => Promise<readonly PluginAccount[]>
    /** The remote hosts connected now, read in place. */
    readonly connections: () => Iterable<SpendingTarget>
    /** Told when what a host said changed, for what Settings shows. */
    readonly changed?: () => void
    readonly now?: () => Date
  }) {
    this.heard = new HeardSpending(join(directory, 'plugin-meshy-spending.json'), () => this.now())
    this.stopMonths = everyMonthStart(() => { this.counted = new Map(); this.tellAll() }, () => this.now())
  }

  /** A host connected, new or again: it is followed for its pushes and told what is spent everywhere else. */
  connected(target: SpendingTarget): void {
    if (this.closed || target.kind !== 'remote') return
    const followed = this.following.get(target.hostId)
    if (followed?.service !== target.service) {
      followed?.stop()
      const stop = target.service.subscribePluginMeshySpending?.(reports => { if (reports) void this.hear(target.hostId, reports) }) ?? (() => undefined)
      this.following.set(target.hostId, { service: target.service, stop })
    }
    this.tell(target)
  }

  /**
   * A 3D model here changed: only when this computer's count for an account moved is every host told. Looks asked for
   * while one runs are one more look after it.
   */
  ownChanged(): void {
    if (this.closed) return
    if (this.looking) { this.lookAgain = true; return }
    this.looking = this.options.own().then(credits => {
      const moved = credits.size !== this.counted.size || [...credits].some(([id, count]) => this.counted.get(id) !== count)
      this.counted = new Map(credits)
      if (moved) this.tellAll()
    }, () => undefined).finally(() => { this.looking = undefined; if (this.lookAgain) { this.lookAgain = false; this.ownChanged() } })
  }

  /** Tells every connected host, as when the accounts it holds copies of may have changed. */
  tellAll(): void {
    for (const target of this.options.connections()) this.tell(target)
  }

  /** The account's credits this month: this computer's own and every host's as last heard. */
  async monthCredits(accountId: string): Promise<number> {
    return ((await this.options.own()).get(accountId) ?? 0) + await this.heard.total(accountId)
  }

  /** The hosts, by identity, that said anything of the account for this month. */
  async reportedBy(accountId: string): Promise<string[]> {
    return (await this.heard.heardFrom(accountId)).map(report => report.from)
  }

  close(): void {
    this.closed = true
    this.stopMonths()
    for (const followed of this.following.values()) followed.stop()
    this.following.clear()
  }

  /** Settles once every telling started so far has ended; for tests. */
  async idle(): Promise<void> {
    while (this.telling.size > 0 || this.looking) await Promise.allSettled([...this.telling.values(), this.looking])
  }

  private now(): Date { return this.options.now?.() ?? new Date() }

  /** One telling at a time for a host; a change while one runs is told again straight after it. */
  private tell(target: SpendingTarget): void {
    if (this.closed || target.kind !== 'remote' || target.service.supportsPluginMeshySpending !== true || !target.service.sharePluginMeshySpending) return
    if (this.telling.has(target.hostId)) { this.again.add(target.hostId); return }
    const run = this.share(target).catch(() => undefined).finally(() => {
      this.telling.delete(target.hostId)
      if (!this.again.delete(target.hostId)) return
      for (const current of this.options.connections()) if (current.hostId === target.hostId) { this.tell(current); return }
    })
    this.telling.set(target.hostId, run)
  }

  private async share(target: SpendingTarget): Promise<void> {
    const accounts = (await this.options.accounts()).filter(account => account.plugin === 'meshy')
    const own = await this.options.own()
    const month = monthOf(this.now())
    const reports: SpendingReport[] = []
    for (const account of accounts) reports.push({ accountId: account.id, month, credits: (own.get(account.id) ?? 0) + await this.heard.total(account.id, target.hostId) })
    const answer = await target.service.sharePluginMeshySpending!(reports)
    await this.hear(target.hostId, answer)
  }

  /** What a host said its own threads spent: kept, and when it changed, every other host is told and Settings looks again. */
  private async hear(hostId: string, reports: readonly SpendingReport[]): Promise<void> {
    if (this.closed) return
    const held = new Set((await this.options.accounts().catch(() => [])).filter(account => account.plugin === 'meshy').map(account => account.id))
    if (!await this.heard.hear(hostId, reports.filter(report => held.has(report.accountId))).catch(() => false)) return
    for (const target of this.options.connections()) if (target.hostId !== hostId) this.tell(target)
    this.options.changed?.()
  }
}
