import { join } from 'node:path'
import type { SpendingReport } from '../../shared/pluginAccountCopies'
import type { PluginAccount } from '../../shared/plugins'
import { everyMonthStart, HeardSpending, monthOf, ReportRevisions } from './spending'

/** The plugins whose accounts share one monthly limit across computers. */
export type SpendingPlugin = 'meshy' | 'elevenlabs'

/**
 * A connected host as shared spending reaches it: its identity, and the calls where it lists `plugin-meshy-spending`
 * or `plugin-elevenlabs-spending`.
 */
export interface SpendingTarget {
  readonly hostId: string
  readonly kind: 'local' | 'remote'
  readonly service: {
    readonly supportsPluginMeshySpending?: boolean | undefined
    sharePluginMeshySpending?(reports: readonly SpendingReport[]): Promise<SpendingReport[]>
    subscribePluginMeshySpending?(listener: (reports?: readonly SpendingReport[]) => void): () => void
    readonly supportsPluginElevenLabsSpending?: boolean | undefined
    sharePluginElevenLabsSpending?(reports: readonly SpendingReport[]): Promise<SpendingReport[]>
    subscribePluginElevenLabsSpending?(listener: (reports?: readonly SpendingReport[]) => void): () => void
  }
}
type SpendingService = SpendingTarget['service']

/** How one plugin's spending reaches a host, and the file what hosts said of it is kept in. */
interface SpendingLine {
  readonly file: string
  readonly supported: (service: SpendingService) => boolean
  readonly share: ((service: SpendingService, reports: readonly SpendingReport[]) => Promise<SpendingReport[]>)
  readonly subscribe: (service: SpendingService, listener: (reports?: readonly SpendingReport[]) => void) => (() => void) | undefined
}
const LINES: Readonly<Record<SpendingPlugin, SpendingLine>> = {
  meshy: {
    file: 'plugin-meshy-spending.json',
    supported: service => service.supportsPluginMeshySpending === true && service.sharePluginMeshySpending !== undefined,
    share: (service, reports) => service.sharePluginMeshySpending!(reports),
    subscribe: (service, listener) => service.subscribePluginMeshySpending?.(listener),
  },
  elevenlabs: {
    file: 'plugin-elevenlabs-spending.json',
    supported: service => service.supportsPluginElevenLabsSpending === true && service.sharePluginElevenLabsSpending !== undefined,
    share: (service, reports) => service.sharePluginElevenLabsSpending!(reports),
    subscribe: (service, listener) => service.subscribePluginElevenLabsSpending?.(listener),
  },
}

/**
 * The desktop's side of shared spending (ADR-0205): one monthly limit for a Meshy or ElevenLabs account here and on
 * every paired host holding its copy, one of these for each plugin. This computer counts its own and adds what each
 * host last said its own threads spent, connected or not, so a host away still counts for what it spent before it
 * went. Each host is told what the account spent everywhere but there: here, and on every other host as last heard.
 * It is told on connecting, when this computer's count changes, when another host's does, and when the month turns.
 *
 * Counts are whole numbers in the plugin's unit: Meshy's credits, or US cents for ElevenLabs. What was heard is kept
 * in a small file in this computer's data folder, by the host's identity: counts and account IDs, never a secret. An
 * older host, which does not list the plugin's spending feature, is told nothing and says nothing.
 */
export class PluginSpendingSync {
  private readonly line: SpendingLine
  private readonly heard: HeardSpending
  private readonly revisions = new ReportRevisions()
  /** What hosts said that is being written down now. */
  private readonly hearing = new Set<Promise<void>>()
  /** The connection each host is followed on, and the way to stop following it. */
  private readonly following = new Map<string, { readonly service: SpendingService; readonly stop: () => void }>()
  private readonly telling = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  private readonly stopMonths: () => void
  private counted = new Map<string, number>()
  private looking: Promise<void> | undefined
  private lookAgain = false
  private closed = false

  constructor(directory: string, private readonly options: {
    readonly plugin: SpendingPlugin
    /** This computer's own count this month, by account ID, in the plugin's unit. */
    readonly own: () => Promise<ReadonlyMap<string, number>>
    readonly accounts: () => Promise<readonly PluginAccount[]>
    /** The remote hosts connected now, read in place. */
    readonly connections: () => Iterable<SpendingTarget>
    /** Told when what a host said changed, for what Settings shows. */
    readonly changed?: () => void
    readonly now?: () => Date
  }) {
    this.line = LINES[options.plugin]
    this.heard = new HeardSpending(join(directory, this.line.file), () => this.now())
    this.stopMonths = everyMonthStart(() => { this.counted = new Map(); this.tellAll() }, () => this.now())
  }

  /** A host connected, new or again: it is followed for its pushes and told what is spent everywhere else. */
  connected(target: SpendingTarget): void {
    if (this.closed || target.kind !== 'remote') return
    const followed = this.following.get(target.hostId)
    if (followed?.service !== target.service) {
      followed?.stop()
      const stop = this.line.subscribe(target.service, reports => { if (reports) this.track(this.hear(target.hostId, reports)) }) ?? (() => undefined)
      this.following.set(target.hostId, { service: target.service, stop })
    }
    this.tell(target)
  }

  /**
   * A 3D model or sound here changed: only when this computer's count for an account moved is every host told. Looks
   * asked for while one runs are one more look after it.
   */
  ownChanged(): void {
    if (this.closed) return
    if (this.looking) { this.lookAgain = true; return }
    this.looking = this.options.own().then(counts => {
      const moved = counts.size !== this.counted.size || [...counts].some(([id, count]) => this.counted.get(id) !== count)
      this.counted = new Map(counts)
      if (moved) this.tellAll()
    }, () => undefined).finally(() => { this.looking = undefined; if (this.lookAgain) { this.lookAgain = false; this.ownChanged() } })
  }

  /** Tells every connected host, as when the accounts it holds copies of may have changed. */
  tellAll(): void {
    for (const target of this.options.connections()) this.tell(target)
  }

  /**
   * The account's count this month: this computer's own and every host's as last heard. Throws `SpendingUnknown`
   * while what hosts said cannot be read or was not written down.
   */
  async monthTotal(accountId: string): Promise<number> {
    return ((await this.options.own()).get(accountId) ?? 0) + await this.others(accountId)
  }

  /** What every host last said the account spent this month, without this computer's own. Throws as `monthTotal` does. */
  others(accountId: string): Promise<number> {
    return this.heard.total(accountId)
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
    while (this.telling.size > 0 || this.looking || this.hearing.size > 0) await Promise.allSettled([...this.telling.values(), this.looking, ...this.hearing])
  }

  private now(): Date { return this.options.now?.() ?? new Date() }

  private track(heard: Promise<void>): void {
    this.hearing.add(heard)
    void heard.finally(() => { this.hearing.delete(heard) })
  }

  /** One telling at a time for a host; a change while one runs is told again straight after it. */
  private tell(target: SpendingTarget): void {
    if (this.closed || target.kind !== 'remote' || !this.line.supported(target.service)) return
    if (this.telling.has(target.hostId)) { this.again.add(target.hostId); return }
    const run = this.share(target).catch(() => undefined).finally(() => {
      this.telling.delete(target.hostId)
      if (!this.again.delete(target.hostId)) return
      for (const current of this.options.connections()) if (current.hostId === target.hostId) { this.tell(current); return }
    })
    this.telling.set(target.hostId, run)
  }

  private async share(target: SpendingTarget): Promise<void> {
    const accounts = (await this.options.accounts()).filter(account => account.plugin === this.options.plugin)
    const own = await this.options.own()
    const month = monthOf(this.now())
    const reports: SpendingReport[] = []
    for (const account of accounts) reports.push({ accountId: account.id, month, credits: (own.get(account.id) ?? 0) + await this.heard.total(account.id, target.hostId), session: this.revisions.session, revision: 0 })
    // Numbered once counted, so each host can tell this desktop's newer report from an older one.
    const revision = this.revisions.next()
    for (const report of reports) report.revision = revision
    const answer = await this.line.share(target.service, reports)
    await this.hear(target.hostId, answer)
  }

  /**
   * What a host said its own threads spent: kept, and when it changed, every other host is told and Settings looks
   * again. A report older than the one held from the same run of that host is let go, so an answer that lands after a
   * newer push cannot put back a lower count (Sol's review). A count that could not be written down leaves the record
   * behind, and nothing is counted until a later one is.
   */
  private async hear(hostId: string, reports: readonly SpendingReport[]): Promise<void> {
    if (this.closed) return
    const held = new Set((await this.options.accounts().catch(() => [])).filter(account => account.plugin === this.options.plugin).map(account => account.id))
    if (!await this.heard.hear(hostId, reports.filter(report => held.has(report.accountId))).catch(() => false)) return
    for (const target of this.options.connections()) if (target.hostId !== hostId) this.tell(target)
    this.options.changed?.()
  }
}

/**
 * A count in dollars as it crosses the wire: whole US cents, rounded up so the limit is never under-counted. A hair of
 * floating-point error above a whole cent, as a sum of prices leaves, is not taken for another cent.
 */
export function centsOf(dollars: number): number {
  return Math.max(0, Math.ceil(dollars * 100 - 1e-6))
}

/** Each account's dollars this month as whole cents, for a report. */
export function centsByAccount(dollars: ReadonlyMap<string, number>): Map<string, number> {
  return new Map([...dollars].map(([accountId, amount]) => [accountId, centsOf(amount)]))
}
