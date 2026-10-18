import { capabilitiesForThread, isThreadProviderConnected, type AgentHostSnapshot, type AgentThread } from '../../shared/agents'
import { isThreadArchived, isThreadClosed, isWorkspaceThreadSettled } from '../../shared/threadActivity'
import { WATCHER_QUIET_MS, watcherObservationKey, type WatcherObservation } from '../../shared/watcherOverview'
import type { WatcherEvidence, WatcherRecord, WatcherThreadTarget } from '../../shared/watcher'
import { WATCHER_BATCH_MS, WATCHER_BATCH_MAX_MS, type WatcherEvent, type WatcherNews } from '../../shared/watcherNews'
import { pullRequestKey } from '../../shared/gitPullRequests'
import { WatcherEvidenceStore, observationDigest, targetKey, type CheckpointObservation, type PullRequestObservation } from './watcherEvidence'
import { eventSlot, foldWatcherEvents, foldWatcherNews, requestRevision } from './watcherNews'
import type { HiddenWakeUpOutcome } from './hiddenWakeUp'

const RETRY_LIMIT = 8
const RETRY_MAX_MS = 60_000
/** A thread whose own facts Watcher has not been told: the digest of none. */
const NOTHING_TOLD = observationDigest([])
/**
 * How long a Git-backed thread's turn end waits for the Git read its finish starts. The workspace reads the working
 * copy again 1.5 seconds after a turn's work settles; the read lands just after the two-second batch otherwise, and
 * would wait for the next turn's end. A read that changes the thread's own facts ends the wait early.
 */
const TURN_END_SETTLE_MS = 5_000
/**
 * How often, at most, an update that changes nothing the pass reacts to at once makes it look over every thread. The
 * coordinator publishes up to every 16 ms while threads stream, and news waits WATCHER_BATCH_MS before it goes.
 */
export const WATCHER_OBSERVE_MS = 250
/**
 * How often, at most, a pass also looks at the threads Watcher does not watch. Their facts only answer Watcher's own
 * reads, which look at every thread first, and the Quiet group, which waits twenty minutes.
 */
export const WATCHER_SWEEP_MS = 5_000
const TURN_ENDS: ReadonlySet<WatcherEvent['kind']> = new Set(['turn-finished', 'turn-failed', 'work-settled'])
/** How many hidden wake-ups in a row may miss Watcher before only news that needs it makes another (hiddenWakeUp.ts). */
export const WAKE_UP_TRIES = 3

interface Progress { fingerprint: string; connected: boolean; connectedAt: number; progressAt: number; quiet: boolean; links?: Set<string>; cancel?: () => void }
/** Opaque progress only: no plan, message, tool input or output text crosses the host projection. */
export function watcherProgressFingerprint(thread: AgentThread): string {
  return observationDigest([thread.status, thread.lastTurn, thread.messages.map(message => [message.id, message.text.length]),
    thread.activities?.map(activity => [activity.id, activity.status, activity.startedAt, activity.completedAt, activity.text?.length, activity.output?.length, activity.steps?.map(step => [step.status, step.text.length]), activity.agents?.map(agent => [agent.id, agent.status, agent.progress, agent.message?.length]) ]), thread.subagentSummary, thread.backgroundWork?.map(work => [work.id, work.type]), thread.monitoring?.map(work => work.id), thread.requests.map(card => [card.id, card.kind])])
}
/**
 * Whether a receipt for one of Watcher's own sends is news to it: the send failed, was refused or may not have gone. An
 * ordinary delivered receipt is not; Watcher made the send and reads its receipts with read_operation when it wants them.
 */
export function receiptNeedsWatcher(operation: Pick<WatcherRecord['operations'][number], 'deliveryState' | 'refusalCode' | 'creationUncertain'>): boolean {
  return operation.deliveryState === 'failed' || operation.deliveryState === 'uncertain'
    || operation.deliveryState === 'accepted' && (operation.creationUncertain === true || operation.refusalCode !== undefined)
}
/**
 * The work a finished turn is still waiting on: background work (Claude's background tasks), the roster's working
 * sub-agents (Codex's `subAgentActivity`) and monitoring. Claude's background sub-agents sit in both of the first two, so
 * the larger of those counts, never their sum. Sub-agents a restart left unknown may still be running, so they count with
 * the working ones: a finish with any of this is not done and is owed work-settled news, and zero is the only settled answer.
 */
export function watcherBackgroundWorkCount(thread: AgentThread): number {
  return Math.max(thread.backgroundWork?.length ?? 0, (thread.subagentSummary?.working ?? 0) + (thread.subagentSummary?.unknown ?? 0)) + (thread.monitoring?.length ?? 0)
}
const finishedTurn = (thread: AgentThread) => thread.status !== 'running' && thread.lastTurn && ['completed', 'failed'].includes(thread.lastTurn.status) ? thread.lastTurn : undefined
const BUSY_TURN_ID = /^[a-f0-9]{64}\.([a-f0-9]{64})$/u
/** The turn a work-settled event is for: one per request, watched thread, generation and finished turn. */
const workSettledScope = (requestId: string, target: WatcherThreadTarget, generation: number, turnId: string | undefined) =>
  observationDigest(['work-settled', requestId, target, generation, turnId ?? null])
export interface WatcherWakeOptions {
  snapshot: () => AgentHostSnapshot
  /** The Watcher record, read only: the record is replaced on every change and never edited, so it is not copied. */
  record: () => Readonly<WatcherRecord>
  progress?: (target: WatcherThreadTarget) => string | undefined
  /**
   * Which hosts report their threads' background work counts, read once per pass: the answer it returns is asked for each
   * host. Absent means every host does; one that does not reads as unknown.
   */
  reportsWork?: () => (hostId: string) => boolean
  /** The Watcher start or send a thread's newest turn answers, so its news can name that operation. */
  answers?: (target: WatcherThreadTarget, thread: AgentThread, record: Readonly<WatcherRecord>) => string | undefined
  restoredEvents?: () => readonly WatcherEvent[]
  /** Whether Watcher's queue holds its hidden wake-up (hiddenWakeUp.ts). While it does, news waits here for the next one. */
  wakeUpQueued?: () => boolean
  canDeliver: (target: WatcherThreadTarget) => boolean
  deliver: (news: WatcherNews) => Promise<void>; prune: () => Promise<void>
  remember: (ids: string[]) => Promise<void>; changed?: () => void; failed?: () => void
  now?: () => number; schedule?: (callback: () => void, delay: number) => () => void
}
/** Event subscriptions and cancellable deadlines only. It owns no provider writer, roster or GitHub poll. */
export class WatcherWakeUp {
  readonly evidence = new WatcherEvidenceStore()
  readonly observations = new Map<string, WatcherObservation>()
  private readonly progress = new Map<string, Progress>()
  private readonly seen = new Set<string>()
  private readonly latestEvidence = new Map<string, { fingerprint: string; id: string; legacyId?: string; restoredRefs?: Set<string> }>()
  private readonly rememberPending = new Set<string>()
  /** Each thread's own facts (working copy, Git, checkpoints) as Watcher was last told them, so a turn's end says only what differs. */
  private readonly toldLocal = new Map<string, string>()
  /** Each evidence event's thread's own facts when it was made: what Watcher is told of them once a wake-up carries it. */
  private readonly localAt = new Map<string, string>()
  /** Finished turns, per request and generation, that left background work running: each is owed one work-settled event. */
  private readonly owedWorkSettled = new Set<string>()
  /** Git-backed threads whose untold turn end waits for its Git read: until when, and their own facts when it ended. */
  private readonly settling = new Map<string, { target: WatcherThreadTarget; until: number; local: string }>()
  /** Evidence events a pull request's change made, which need Watcher's attention as a turn end does. */
  private readonly waking = new Set<string>()
  /**
   * Set while evidenceChanged makes an event for news that needs Watcher, so the event is marked before it is batched:
   * `fresh` for a pull request's own change, `inherited` for evidence that only keeps earlier waiting news current.
   */
  private evidenceWakes: false | 'fresh' | 'inherited' = false
  /**
   * Hidden wake-ups in a row that did not reach Watcher (hiddenWakeUp.ts). After one, the next is made only on a retry:
   * news that needs Watcher came since the last was made, or Watcher came to rest, or the miss was unknown, the last two
   * only while fewer than WAKE_UP_TRIES missed. Retries are counted, and a made wake-up consumes only those counted before
   * its news was taken, so one counted while it was being saved is not lost.
   */
  private misses = 0
  private retries = 0
  private consumedRetries = 0
  /** Whether Watcher rested at the last pass, so a pass can see it come to rest. */
  private watcherResting: boolean | undefined
  /** Events an unknown send let go of: observed again, they are not news that came since. */
  private readonly reobserved = new Set<string>()
  private pending: WatcherEvent[] = []
  private recent: WatcherEvent[] = []
  private cancelBatch: (() => void) | undefined
  private firstPending = 0
  private deliveryAvailable = false
  private retryFailures = 0
  private retryAt = 0
  private started = false
  private closed = false
  private readonly now: () => number
  private readonly schedule: NonNullable<WatcherWakeOptions['schedule']>
  private tail: Promise<unknown> = Promise.resolve()
  /** When the last pass ran, what it reacts to at once as it stood then, and the pass owed once WATCHER_OBSERVE_MS is up. */
  private observedAt = -Infinity
  private observedEdges: { record: Readonly<WatcherRecord>; threads: string } | undefined
  private cancelObserve: (() => void) | undefined
  /** When a pass last looked at every thread, watched or not. */
  private sweptAt = -Infinity
  /** The reads the synchronous pass under way shares; see `withPassReads`. */
  private pass: { snapshot?: AgentHostSnapshot; record?: Readonly<WatcherRecord>; reportsWork?: (hostId: string) => boolean } | undefined
  constructor(private readonly options: WatcherWakeOptions) {
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, delay); timer.unref?.(); return () => clearTimeout(timer) })
  }
  start(): void {
    if (this.closed || this.started) return
    this.started = true
    const restored = this.options.restoredEvents?.() ?? []
    // A saved or queued finish that left background work running names the work-settled event it is owed, so a restart keeps it.
    for (const id of [...this.options.record().wakeEventIds ?? [], ...restored.map(event => event.id)]) {
      const busy = BUSY_TURN_ID.exec(id)?.[1]
      if (busy) this.oweWorkSettled(busy)
    }
    for (const id of this.options.record().wakeEventIds ?? []) {
      this.seen.add(id)
      const match = /^([a-f0-9]{64})\.([a-f0-9]{64})\.([a-f0-9]{64})$/u.exec(id)
      if (match) this.latestEvidence.set(match[1]!, { fingerprint: match[2]!, id })
    }
    for (const event of restored) {
      this.seen.add(event.id)
      // Which evidence needed Watcher is kept in memory only; evidence in a wake-up that was made is counted as having done.
      if (event.kind === 'evidence-changed') this.wake(event.id)
      if (event.kind !== 'evidence-changed' || !event.evidenceIds?.length) continue
      const fingerprint = observationDigest([...event.evidenceIds].sort())
      if (event.revision !== fingerprint && event.revision !== observationDigest(event.evidenceIds)) continue
      const scope = observationDigest([event.kind, event.requestId, event.target, event.generation])
      const latest = this.latestEvidence.get(scope)
      if (latest && (latest.id !== event.id && latest.legacyId !== event.id
        || latest.fingerprint !== fingerprint && latest.fingerprint !== observationDigest(event.evidenceIds))) continue
      this.latestEvidence.set(scope, { ...latest ?? { fingerprint, id: event.id,
        .../^[a-f0-9]{64}$/u.test(event.id) ? { legacyId: event.id } : {} }, restoredRefs: new Set(event.evidenceIds) })
      this.seen.add(event.id)
      while (this.latestEvidence.size > 2_000) this.latestEvidence.delete(this.latestEvidence.keys().next().value!)
    }
    this.observe()
  }
  ready(): boolean { return this.started && !this.closed }
  private connected(snapshot: AgentHostSnapshot, thread: AgentThread): boolean {
    return snapshot.connected && thread.clientConnected !== false && isThreadProviderConnected(snapshot, thread)
  }
  /** Unknown roster entries keep work unsettled, but only provider-confirmed working agents can become quiet. */
  private active(thread: AgentThread): boolean { return thread.status === 'running' || thread.lastTurn?.status === 'running' || Boolean(thread.subagentSummary?.working || thread.backgroundWork?.length || thread.monitoring?.length) }
  /**
   * The thread's work is confirmed ended: nothing running and nothing unknown. A sub-agent a restart left unknown may still
   * be running, so it keeps the turn unsettled until its provider says how it ended. A host that does not report the counts
   * leaves them unknown, so its threads never settle.
   */
  private workSettled(thread: AgentThread, hostId: string): boolean {
    return this.reportsWork(hostId) && watcherBackgroundWorkCount(thread) === 0
  }
  private reportsWork(hostId: string): boolean {
    const read = () => this.options.reportsWork?.() ?? (() => true)
    return (this.pass ? this.pass.reportsWork ??= read() : read())(hostId)
  }
  /**
   * Runs `read` as one synchronous pass that reads the merged snapshot, the Watcher record and which hosts report work at
   * most once. The snapshot copies a paired host's shell and the host list reads every host, so a pass that asked again
   * for every thread, operation or event grew with all of them (#1023); the record is read without a copy, but sharing it
   * keeps one pass to one record. Nothing in a pass changes them;
   * a pass already under way shares its reads, and the next pass, after any wait, reads afresh.
   */
  private withPassReads<T>(read: () => T): T {
    if (this.pass) return read()
    this.pass = {}
    try { return read() } finally { this.pass = undefined }
  }
  private snapshot(): AgentHostSnapshot { return this.pass ? this.pass.snapshot ??= this.options.snapshot() : this.options.snapshot() }
  private record(): Readonly<WatcherRecord> { return this.pass ? this.pass.record ??= this.options.record() : this.options.record() }
  /** Records a finished turn whose work is still running, so it is owed one work-settled event when that work ends. */
  private oweWorkSettled(scope: string): void {
    this.owedWorkSettled.delete(scope); this.owedWorkSettled.add(scope)
    while (this.owedWorkSettled.size > 2_000) this.owedWorkSettled.delete(this.owedWorkSettled.values().next().value!)
  }
  private workers(includeClosed = false) {
    const record = this.record()
    const watches = record.current ? (record.watches ?? []).filter(watch => !watch.remoteOrigin) : []
    const standing = watches.map(watch => {
      const request: WatcherRecord['requests'][number] = { id: watch.id, watcher: record.current!.target, rootUserMessageId: `standing:${watch.id}`,
        standingWatchId: watch.id, state: 'active', createdAt: watch.createdAt, closedAt: null, participants: [] }
      const participant: WatcherRecord['requests'][number]['participants'][number] = { requestId: watch.id, target: watch.target,
        startedBy: 'user', generation: watch.generation, state: 'participating', promptCount: 0 }
      return { request, participant }
    })
    return [...standing, ...record.requests.filter(request => (request.state === 'active' || includeClosed && request.state === 'closed') && targetKey(request.watcher) === (record.current ? targetKey(record.current.target) : ''))
      .flatMap(request => request.participants.map(participant => ({ request, participant })))
      .filter(({ participant }) => !watches.some(watch => targetKey(watch.target) === targetKey(participant.target)))]
  }
  private watchedTargets(): WatcherThreadTarget[] {
    return [...new Map(this.workers().filter(({ participant }) => participant.state === 'participating' && !participant.automationStopped)
      .map(({ participant }) => [targetKey(participant.target), participant.target])).values()]
  }
  watchedThreadIds(hostId: string): string[] {
    return this.watchedTargets().filter(target => target.hostId === hostId).map(target => target.threadId)
  }
  private project(snapshot: AgentHostSnapshot, thread: AgentThread) {
    return snapshot.projects.find(project => project.id === thread.projectId && (project.hostId ?? snapshot.hostId) === (thread.hostId ?? snapshot.hostId))
  }
  news(): WatcherEvent[] { return this.withPassReads(() => this.recent.filter(event => this.due(event))) }
  /**
   * Whether news needs Watcher's attention: anything but evidence, or evidence of a pull request's link, state, checks,
   * review or merge changing. Evidence of a thread's own facts alone does not; it only rides with news that does. Which
   * evidence woke is kept in memory only, as Watcher's news is: a restart observes it all afresh.
   */
  needsAttention(events: readonly WatcherEvent[]): boolean {
    return events.some(event => event.kind !== 'evidence-changed' || this.waking.has(event.id))
  }
  /**
   * Watcher's hidden wake-up left its queue whole (hiddenWakeUp.ts), holding these events. Told: Watcher has them. Failed
   * or withdrawn: what is still true waits again, to go in the next one. Unknown: the send may have gone, and is never
   * sent twice, so its news is forgotten and observed afresh, as after a restart. Anything but told is a miss, or a
   * withdrawal, and none of it is remembered as told.
   */
  settled(events: readonly WatcherEvent[], outcome: HiddenWakeUpOutcome): void {
    if (!this.started || this.closed) return
    if (outcome !== 'told') for (const event of events) this.rememberPending.delete(event.id)
    // An unconsumed retry already says news that needs Watcher came since that one was made, which is news it did not carry.
    if (outcome === 'told') this.misses = 0
    else if (outcome === 'withdrawn') this.retries++
    else {
      this.misses++
      // Observed afresh, as after a restart, it goes again by itself, a bounded number of times. A sure failure waits for
      // news that needs Watcher, or for Watcher to come to rest.
      if (outcome === 'unknown' && this.misses < WAKE_UP_TRIES) this.retries++
    }
    if (outcome === 'unknown') { this.forget(events); this.observe(); return }
    if (outcome !== 'told') this.withPassReads(() => this.returned(events))
    this.batch()
  }
  /**
   * News that went back unsent waits again, ahead of what came since, which wins where both say the same. Evidence whose
   * facts moved on since, as a thread's own facts do, is told again as they stand now, with a turn end still waiting.
   * A pull request's change still needs Watcher: evidence that replaced it carries it, and so does its retelling.
   */
  private returned(events: readonly WatcherEvent[]): void {
    const later = new Map(this.pending.map(event => [eventSlot(event), event])), again = new Map<string, { target: WatcherThreadTarget; wakes: boolean }>()
    for (const event of events) {
      if (event.kind !== 'evidence-changed') continue
      const replaced = later.get(eventSlot(event)), wakes = this.waking.has(event.id)
      // Not told after all, so Watcher's last word of the thread's own facts is no longer this one.
      this.toldLocal.delete(targetKey(event.target))
      if (replaced?.kind === 'evidence-changed') { if (wakes) this.wake(replaced.id) }
      else if (!this.due(event)) {
        again.set(targetKey(event.target), { target: event.target, wakes: wakes || again.get(targetKey(event.target))?.wakes === true })
      }
    }
    this.pending = this.stillDue(foldWatcherEvents(events, this.pending))
    for (const [key, { target, wakes }] of again) {
      if (!this.pending.some(event => event.kind === 'evidence-changed' && targetKey(event.target) === key)) this.evidenceChanged(target, [], false, wakes ? 'again' : false)
    }
  }
  /** Watcher is told this evidence's thread's own facts: a wake-up was made with it. */
  private toldLocalAs(event: WatcherEvent): void {
    const key = targetKey(event.target), local = this.localAt.get(event.id)
    this.toldLocal.delete(key)
    if (local !== undefined) this.toldLocal.set(key, local)
    while (this.toldLocal.size > 2_000) this.toldLocal.delete(this.toldLocal.keys().next().value!)
  }
  private wake(id: string): void {
    this.waking.delete(id); this.waking.add(id)
    while (this.waking.size > 2_000) this.waking.delete(this.waking.values().next().value!)
  }
  /**
   * Forgets that these events were told, so what is still true is observed afresh and told in a new wake-up; what is no
   * longer true stays untold. As a restart does: a quiet episode already told is open again, and a pull request's facts
   * are told as they stand.
   */
  private forget(events: readonly WatcherEvent[]): void {
    const pullRequests = new Map<string, WatcherThreadTarget>()
    for (const event of events) {
      this.seen.delete(event.id); this.rememberPending.delete(event.id)
      this.reobserved.delete(event.id); this.reobserved.add(event.id)
      while (this.reobserved.size > 2_000) this.reobserved.delete(this.reobserved.values().next().value!)
      if (event.kind === 'evidence-changed') {
        const scope = observationDigest(['evidence-changed', event.requestId, event.target, event.generation])
        if (this.latestEvidence.get(scope)?.id === event.id) this.latestEvidence.delete(scope)
        this.toldLocal.delete(targetKey(event.target))
        if (this.waking.has(event.id)) pullRequests.set(targetKey(event.target), event.target)
      }
      if (event.kind === 'work-settled') this.oweWorkSettled(workSettledScope(event.requestId, event.target, event.generation, event.turnId))
      if (event.kind === 'quiet') {
        const progress = this.progress.get(targetKey(event.target))
        if (progress) { progress.quiet = false; progress.cancel?.(); delete progress.cancel }
      }
    }
    this.recent = this.recent.filter(event => !events.some(item => item.id === event.id))
    for (const target of pullRequests.values()) this.evidenceChanged(target, [], false, 'again')
  }
  /**
   * The events still due. Work-settled news whose work started again before delivery is not sent; its turn is owed it
   * again, so it comes once the work truly reaches zero.
   */
  private stillDue(events: readonly WatcherEvent[]): WatcherEvent[] {
    return events.filter(event => {
      if (this.due(event)) return true
      if (event.kind === 'work-settled') { this.seen.delete(event.id); this.oweWorkSettled(workSettledScope(event.requestId, event.target, event.generation, event.turnId)) }
      return false
    })
  }
  private event(kind: WatcherEvent['kind'], target: WatcherThreadTarget, identity: unknown, extra: Partial<WatcherEvent> = {}): void {
    if (!this.started || this.closed) return
    for (const { request, participant } of this.workers(kind === 'taken-over').filter(item => targetKey(item.participant.target) === targetKey(target))) {
      if (kind !== 'taken-over' && (participant.state !== 'participating' || participant.automationStopped)) continue
      if (kind === 'taken-over' && participant.state !== 'taken-over') continue
      const stableId = observationDigest([kind, request.id, target, participant.generation, identity])
      let id = stableId
      // One work-settled event per turn that finished with background work running. A finish observed busy carries its
      // scope in its ID, so the saved ID alone tells a restart which turn still owes one.
      const settleScope = kind === 'turn-finished' || kind === 'turn-failed' || kind === 'work-settled'
        ? workSettledScope(request.id, target, participant.generation, extra.turnId) : undefined
      if (kind === 'work-settled' && !this.owedWorkSettled.has(settleScope!)) continue
      const busyId = settleScope && kind !== 'work-settled' ? `${stableId}.${settleScope}` : undefined
      if (kind === 'evidence-changed') {
        const scope = observationDigest([kind, request.id, target, participant.generation]), fingerprint = observationDigest(identity)
        const previous = this.latestEvidence.get(scope)
        if (previous?.fingerprint === fingerprint) { delete previous.restoredRefs; continue }
        // Missing source observations at restart are unknown; the waiting queue supplies text-free references.
        if (previous?.restoredRefs) continue
        // Preserve the latest state across restart; a return to an earlier state is a new occurrence.
        id = [scope, fingerprint, observationDigest([stableId, previous?.id ?? null])].join('.')
        const legacyId = !previous ? [stableId, observationDigest([kind, request.id, target, participant.generation,
          this.evidence.read(target).map(item => item.id)])].find(candidate => this.seen.has(candidate)) : undefined
        this.latestEvidence.delete(scope); this.latestEvidence.set(scope, { fingerprint, id, ...(legacyId ? { legacyId } : {}) })
        while (this.latestEvidence.size > 2_000) this.latestEvidence.delete(this.latestEvidence.keys().next().value!)
        // Older saved IDs remain readable and deduplicate only the first reconciled observation.
        if (legacyId) continue
      } else if (this.seen.has(id) || busyId && this.seen.has(busyId)) continue
      // Only a finish delivered as busy is owed: one already delivered as done stays done if work shows up later.
      else if (busyId && extra.backgroundWorkCount) { id = busyId; this.oweWorkSettled(settleScope!) }
      if (kind === 'work-settled') this.owedWorkSettled.delete(settleScope!)
      const event: WatcherEvent = { ...extra, kind, target, requestId: request.id, generation: participant.generation,
        observedAt: new Date(this.now()).toISOString(), id }
      this.seen.add(event.id)
      if (kind === 'evidence-changed' && this.evidenceWakes) this.wake(event.id)
      // News that needs Watcher in itself, and was not just let go of, may make a wake-up after one that missed.
      if ((kind !== 'evidence-changed' || this.evidenceWakes === 'fresh') && !this.reobserved.has(event.id)) this.retries++
      if (kind === 'evidence-changed') {
        this.localAt.set(event.id, this.evidence.digest(target, 'local'))
        while (this.localAt.size > 2_000) this.localAt.delete(this.localAt.keys().next().value!)
      }
      // Seen identities are bounded in memory and persisted only after a successful queue save.
      while (this.seen.size > 2_000) this.seen.delete(this.seen.values().next().value!)
      if (this.retryFailures >= RETRY_LIMIT) { this.retryFailures = 0; this.retryAt = 0 }
      this.recent = foldWatcherEvents(this.recent, [event]).slice(-400)
      this.pending = this.stillDue(foldWatcherEvents(this.pending, [event]))
      this.batch()
    }
  }
  private canDeliver(): boolean {
    const watcher = this.record().current?.target
    return !!watcher && this.options.canDeliver(watcher)
  }
  private batch(): void {
    const available = this.canDeliver()
    if (available !== this.deliveryAvailable) {
      this.deliveryAvailable = available
      this.retryFailures = 0; this.retryAt = 0
      this.cancelBatch?.(); this.cancelBatch = undefined
    }
    if (this.closed || !this.pending.length && !this.rememberPending.size
      || !available && !this.rememberPending.size || this.retryFailures >= RETRY_LIMIT) {
      this.cancelBatch?.(); this.cancelBatch = undefined
      return
    }
    // News waits in memory while it may not make a wake-up: a thread's own facts with nothing that needs Watcher beside
    // them, anything while Watcher's hidden wake-up is still in its queue, and anything after a miss until a retry is due.
    if (!this.rememberPending.size && !this.worthTelling(this.pending)) { this.cancelBatch?.(); this.cancelBatch = undefined; return }
    // Observations and new events cannot shorten an outstanding persistence backoff.
    if (this.retryAt && this.cancelBatch) return
    if (!this.cancelBatch) this.firstPending = this.now()
    this.cancelBatch?.()
    // A turn end waiting for its Git read holds only its own thread's news; everything else keeps the batch's own limits.
    const held = this.heldForGitRead(), free = this.pending.some(event => !this.waitsForGitRead(event, held))
    const delay = this.retryAt ? this.retryAt - this.now() : free || !held.size ? Math.min(WATCHER_BATCH_MS, this.firstPending + WATCHER_BATCH_MAX_MS - this.now())
      : Math.min(...held.values()) - this.now()
    this.cancelBatch = this.schedule(() => { this.cancelBatch = undefined; this.flush() }, Math.max(0, delay))
  }
  /**
   * Whether these events may make Watcher's next hidden wake-up (hiddenWakeUp.ts): some of them need Watcher, none is in
   * its queue, and none missed since the last that reached it, or a retry is due.
   */
  private worthTelling(events: readonly WatcherEvent[]): boolean {
    return events.length > 0 && this.needsAttention(events) && (this.misses === 0 || this.retries > this.consumedRetries) && this.options.wakeUpQueued?.() !== true
  }
  /** A turn end, and the thread's own facts that ride with it, wait for that thread's Git read; nothing else does. */
  private waitsForGitRead(event: WatcherEvent, held: ReadonlyMap<string, number>): boolean {
    return held.has(targetKey(event.target)) && (TURN_ENDS.has(event.kind) || event.kind === 'evidence-changed')
  }
  /**
   * The threads whose waiting turn end still holds their own news for its Git read, and until when: none once the read
   * has changed the thread's own facts, once its time is up, or when no turn end of that thread is waiting.
   */
  private heldForGitRead(): Map<string, number> {
    const held = new Map<string, number>()
    for (const [key, wait] of this.settling) {
      if (wait.until <= this.now() || this.evidence.digest(wait.target, 'local') !== wait.local) { this.settling.delete(key); continue }
      if (this.pending.some(event => targetKey(event.target) === key && TURN_ENDS.has(event.kind))) held.set(key, wait.until)
    }
    return held
  }
  private flush(): void {
    const { held, due, watcher } = this.withPassReads(() => ({ held: this.heldForGitRead(), due: this.canDeliver() ? this.stillDue(this.pending) : [], watcher: this.record().current?.target }))
    const ready = due.filter(event => !this.waitsForGitRead(event, held))
    const events = this.worthTelling(ready) ? ready : []
    if (events.length) this.pending = due.filter(event => this.waitsForGitRead(event, held))
    if (this.closed) return
    // Only news still waiting for its thread's Git read is left: it goes when that wait ends.
    if (!events.length && !this.rememberPending.size) { if (held.size) this.batch(); return }
    const news = watcher && events.length ? foldWatcherNews(undefined, { source: 'watcher', watcher, events, omitted: 0 }) : undefined
    // The retries this wake-up answers: those counted by now. One counted while it is saved is for the next.
    const retries = this.retries
    this.tail = this.tail.catch(() => undefined).then(async () => {
      if (this.closed) return
      let failed = false
      // A fresh pass after the wait: the state may have moved, but one recheck reads it once for every event.
      const valid = news && { ...news, events: this.withPassReads(() => this.stillDue(news.events)) }
      // What went stale while it waited may leave a thread's own facts alone, which wake no one: they wait with the rest.
      if (valid?.events.length && !this.needsAttention(valid.events)) {
        const kept = valid.events; valid.events = []
        this.withPassReads(() => this.returned(kept))
      }
      if (valid?.events.length) {
        try {
          // Recheck after the serialized lane; recipient refusal is held, not retried by a timer. One hidden wake-up at a time.
          if (this.canDeliver() && this.options.wakeUpQueued?.() !== true) {
            await this.options.deliver(valid)
            if (this.closed) return
            this.consumedRetries = Math.max(this.consumedRetries, retries)
            for (const event of valid.events) if (event.kind === 'evidence-changed') this.toldLocalAs(event)
            for (const event of valid.events) this.rememberPending.add(event.id)
            while (this.rememberPending.size > 1_000) this.rememberPending.delete(this.rememberPending.values().next().value!)
          } else this.pending = this.withPassReads(() => this.stillDue(foldWatcherEvents(events, this.pending)))
        } catch {
          if (this.closed) return
          // Keep the full batch behind the delivery limit; later observations and withdrawal still win.
          this.pending = this.withPassReads(() => this.stillDue(foldWatcherEvents(events, this.pending)))
          failed = this.canDeliver()
        }
      }
      const ids = [...this.rememberPending]
      if (ids.length) {
        try {
          await this.options.remember(ids)
          for (const id of ids) this.rememberPending.delete(id)
        } catch { if (!this.closed) failed = true }
      }
      if (this.closed) return
      if (failed) {
        this.cancelBatch?.(); this.cancelBatch = undefined
        this.retryFailures++
        this.retryAt = this.now() + Math.min(RETRY_MAX_MS, WATCHER_BATCH_MS * 2 ** (this.retryFailures - 1))
        this.options.failed?.()
      } else { this.retryFailures = 0; this.retryAt = 0 }
      this.batch()
    })
  }
  observe(): void { this.withPassReads(() => this.observePass()) }
  /** A pass over every thread, watched or not, for a read of Watcher's that may name any of them. */
  observeAll(): void { this.sweptAt = -Infinity; this.observe() }
  /**
   * The pass for an update. It runs at once when a turn, a request card, background work, a connection or the record
   * moved, since a turn that finishes as the next one starts is seen only in the update between them. Otherwise, as
   * while a thread streams, it runs at most every WATCHER_OBSERVE_MS, and once more after the last update, followed by
   * `after`. A pass that runs sooner, as one for a later update does, takes the owed one's place and `after` with it,
   * since its caller publishes what it found.
   */
  observeSoon(after: () => void): void {
    if (!this.started || this.closed) return
    this.withPassReads(() => {
      const wait = this.observedAt + WATCHER_OBSERVE_MS - this.now(), edges = this.observedEdges
      if (wait <= 0 || !edges || edges.record !== this.record() || edges.threads !== this.threadEdges(this.snapshot())) { this.observePass(); return }
      this.cancelObserve ??= this.schedule(() => { this.cancelObserve = undefined; this.observe(); after() }, wait)
    })
  }
  /**
   * Each watched thread's and Watcher's own turn, request cards, background work and connection: what a pass must not
   * miss between two looks. Other threads make no news, so a change of theirs waits for the next sweep.
   */
  private threadEdges(snapshot: AgentHostSnapshot): string {
    let edges = String(snapshot.connected)
    const watched = new Set(this.watchedTargets().map(targetKey))
    for (const thread of snapshot.threads) {
      if (thread.kind !== 'watcher' && !watched.has(targetKey({ hostId: thread.hostId ?? snapshot.hostId ?? '', threadId: thread.id }))) continue
      edges += `|${thread.hostId ?? ''}/${thread.id}:${thread.status}:${thread.lastTurn?.id ?? ''}:${thread.lastTurn?.status ?? ''}:${watcherBackgroundWorkCount(thread)}:${thread.clientConnected ?? ''}:${thread.requests.map(card => card.id).join(',')}`
    }
    return edges
  }
  private observePass(): void {
    if (!this.started || this.closed) return
    const snapshot = this.snapshot(), stamp = new Date(this.now()).toISOString()
    this.cancelObserve?.(); this.cancelObserve = undefined
    this.observedAt = this.now(); this.observedEdges = { record: this.record(), threads: this.threadEdges(snapshot) }
    const targets = new Set<string>(), watched = new Set(this.watchedTargets().map(targetKey))
    const sweep = this.now() - this.sweptAt >= WATCHER_SWEEP_MS
    if (sweep) this.sweptAt = this.now()
    for (const thread of snapshot.threads) {
      if (thread.kind === 'watcher' || thread.kind === 'watcher-history' || !snapshot.hostId) continue
      const target = { hostId: thread.hostId ?? snapshot.hostId, threadId: thread.id }, key = targetKey(target)
      targets.add(key)
      // A thread Watcher does not watch makes no news: its facts are brought up to date by a sweep, not on every pass,
      // and it holds no quiet deadline.
      if (!sweep && !watched.has(key)) { const unwatched = this.progress.get(key); unwatched?.cancel?.(); if (unwatched) delete unwatched.cancel; continue }
      const connected = this.connected(snapshot, thread)
      const previous = this.progress.get(key)
      const fingerprint = this.options.progress?.(target) ?? watcherProgressFingerprint(thread)
      const changedProgress = !previous || previous.fingerprint !== fingerprint
      const progress: Progress = previous ?? { fingerprint, connected, connectedAt: this.now(), progressAt: this.now(), quiet: false }
      if (connected && !progress.connected) { progress.connectedAt = this.now(); progress.progressAt = this.now(); progress.quiet = false }
      if (changedProgress) { progress.fingerprint = fingerprint; progress.progressAt = this.now(); progress.quiet = false }
      progress.connected = connected
      this.progress.set(key, progress)
      const observed: WatcherObservation = { observedAt: stamp, fresh: connected && capabilitiesForThread(snapshot, thread).observe,
        connectedAt: new Date(progress.connectedAt).toISOString(), lastProgressAt: new Date(progress.progressAt).toISOString() }
      const facts = this.evidence.read(target, connected, this.now())
      if (connected) {
        const before = this.knownEvidenceIds(target)
        const links = new Set([...thread.pullRequests ?? [], ...thread.worktree?.git?.pullRequest ? [thread.worktree.git.pullRequest] : []].flatMap(pr => { const key = pullRequestKey(pr.url); return key ? [key] : [] }))
        const added = progress.links !== undefined && [...links].some(link => !progress.links!.has(link))
        progress.links = links
        before.push(...facts.filter(item => item.source === 'github' && item.url && !links.has(pullRequestKey(item.url) ?? '')).map(item => item.id))
        // Every thread keeps its facts current; only a watched one's news is worked out, since no one else is told it.
        const told = watched.has(key)
        const pullRequests = told ? this.evidence.digest(target, 'pull-request') : ''
        const changedEvidence = this.evidence.observeThread(thread, target, stamp)
        if (told) {
          const turn = thread.lastTurn, finished = finishedTurn(thread)
          const ends = () => this.pending.filter(event => targetKey(event.target) === key && TURN_ENDS.has(event.kind)).map(event => event.id)
          const endsBefore = new Set(ends())
          let settles = false
          if (finished) {
            // The news names the delegation this turn answers, when there is one. The name is an identity, never words.
            const operationId = this.options.answers?.(target, thread, this.record())
            const answers = operationId ? { operationId } : {}
            // A host that does not report the counts sends no count: unknown, never none running. Unknown sub-agents count, so
            // a finish while they are unresolved says the turn is not done and is owed work-settled news.
            this.event(finished.status === 'failed' ? 'turn-failed' : 'turn-finished', target, [finished.id, finished.status],
              { turnId: finished.id, ...answers, ...this.reportsWork(target.hostId) ? { backgroundWorkCount: watcherBackgroundWorkCount(thread) } : {},
                evidenceIds: this.evidence.read(target).filter(item => item.turnId === finished.id).map(item => item.id) })
            if (this.workSettled(thread, target.hostId)) {
              const settling = () => this.pending.filter(event => event.kind === 'work-settled' && targetKey(event.target) === key).map(event => event.id)
              const waiting = new Set(settling())
              this.event('work-settled', target, [finished.id], { turnId: finished.id, ...answers, backgroundWorkCount: 0 })
              settles = settling().some(id => !waiting.has(id))
            }
          }
          // A turn end of a thread with a Git working copy waits, briefly, for the read its finish starts (TURN_END_SETTLE_MS).
          if (thread.worktree?.git && ends().some(id => !endsBefore.has(id)) && !((this.settling.get(key)?.until ?? 0) > this.now())) {
            this.settling.delete(key)
            this.settling.set(key, { target, until: this.now() + TURN_END_SETTLE_MS, local: this.evidence.digest(target, 'local') })
            while (this.settling.size > 2_000) this.settling.delete(this.settling.keys().next().value!)
            this.batch()
          }
          for (const card of thread.requests) this.event('needs-user', target, [card.id, requestRevision(card)],
            { requestCardId: card.id, requestCardKind: card.kind, revision: requestRevision(card), ...(turn ? { turnId: turn.id } : {}) })
          // After the turn's own news, so a turn's end carries what its working copy became. A turn that finished with work
          // still running ends again when that work settles, which carries what the work changed since. A new turn end also
          // carries the thread's own facts when they differ from what Watcher was told, though nothing changed in this pass.
          const untold = ends().some(id => !endsBefore.has(id)) && (this.toldLocal.get(key) ?? NOTHING_TOLD) !== this.evidence.digest(target, 'local')
          if (changedEvidence || settles || untold) this.evidenceChanged(target, before, added, added || pullRequests !== this.evidence.digest(target, 'pull-request'))
        }
      }
      const landing = this.evidence.read(target, connected, this.now()).find(item => item.freshness === 'fresh' && ['merge-observed', 'auto-merge-observed', 'landing-action'].includes(item.fact))
      if (landing) observed.landing = { source: landing.source === 'github' ? 'github' : 'user-landing-action', observedAt: landing.observedAt, fresh: true }
      this.observations.set(watcherObservationKey(thread), observed)
      const eligible = watched.has(key) && observed.fresh && this.active(thread) && !thread.requests.length && !isThreadClosed(thread)
        && !isWorkspaceThreadSettled(thread, this.project(snapshot, thread))
      if (!eligible || changedProgress) { progress.cancel?.(); delete progress.cancel }
      if (eligible && !progress.quiet && !progress.cancel) progress.cancel = this.schedule(() => {
        delete progress.cancel
        // Fresh live state and ownership, not the old snapshot closed over by a timer.
        const current = this.options.snapshot(), live = current.threads.find(item => item.id === target.threadId && (item.hostId ?? current.hostId) === target.hostId)
        if (!live || !this.connected(current, live) || !this.active(live) || live.requests.length || isThreadClosed(live)
          || isWorkspaceThreadSettled(live, this.project(current, live)) || !this.watchedTargets().some(item => targetKey(item) === key)) return
        // Progress in an update whose pass is still owed is progress all the same: that pass starts the deadline again.
        if ((this.options.progress?.(target) ?? watcherProgressFingerprint(live)) !== progress.fingerprint) return
        progress.quiet = true
        this.event('quiet', target, progress.progressAt, { ...(live.lastTurn ? { turnId: live.lastTurn.id } : {}) })
        this.options.changed?.()
      }, Math.max(0, Math.max(progress.progressAt, progress.connectedAt) + WATCHER_QUIET_MS - this.now()))
    }
    for (const [key, progress] of this.progress) if (!targets.has(key)) { progress.cancel?.(); this.progress.delete(key) }
    this.evidence.removeMissing(targets)
    for (const { participant } of this.workers(true)) if (participant.state === 'taken-over') this.event('taken-over', participant.target, participant.takeover)
    // A receipt for Watcher's own send wakes it only when the send did not plainly go: failed, refused or uncertain.
    for (const operation of this.record().operations) if (receiptNeedsWatcher(operation)) {
      const revision = observationDigest([operation.deliveryState, operation.refusalCode, operation.creationUncertain])
      this.event('delivery-changed', operation.target, [operation.id, revision], { operationId: operation.id, revision })
    }
    // Watcher coming to rest after a wake-up that missed is a retry, a bounded number of times.
    const watcher = this.record().current?.target
    const own = watcher && snapshot.threads.find(thread => thread.id === watcher.threadId && (thread.hostId ?? snapshot.hostId) === watcher.hostId)
    const resting = !!own && own.status !== 'running' && own.lastTurn?.status !== 'running' && !own.requests.length
    if (resting && this.watcherResting === false && this.misses > 0 && this.misses < WAKE_UP_TRIES) this.retries++
    this.watcherResting = resting
    this.pending = this.stillDue(this.pending)
    if (!this.pending.length && !this.rememberPending.size) { this.cancelBatch?.(); this.cancelBatch = undefined }
    this.batch()
    // Withdrawal is advisory; the queue also rechecks before claim and at the provider writer.
    this.tail = this.tail.catch(() => undefined).then(() => this.closed ? undefined : this.options.prune()).catch(() => this.options.failed?.())
  }
  private knownEvidenceIds(target: WatcherThreadTarget): string[] {
    return this.evidence.knownIdentities(target)
  }
  /**
   * A thread's facts changed. A pull request's link, state, checks, review or auto-merge is news at once (`wake`). The
   * thread's own facts (working copy, Git, checkpoints) change on nearly every tool call, so they are held: they ride
   * with a turn's end still waiting to be told, keep news already waiting current, and otherwise wait for the next
   * turn's end, which drops them when nothing differs from what Watcher was last told. A turn that finished with
   * background work running ends twice: what changed during that work rides with its work-settled news. `again` tells a
   * pull request's facts afresh, as after a restart: they need Watcher, but are no news that came since.
   */
  private evidenceChanged(target: WatcherThreadTarget, before: readonly string[] = [], added = false, wake: boolean | 'again' = true): void {
    const evidenceIds = this.evidence.read(target).map(item => item.id).sort()
    // A changed or removed already-observed fact is real news, including an unlink during incomplete recovery.
    const identities = this.evidence.identities(target)
    if (added || before.some(id => !identities.has(id))) for (const { request, participant } of this.workers()) {
      if (targetKey(participant.target) !== targetKey(target)) continue
      const latest = this.latestEvidence.get(observationDigest(['evidence-changed', request.id, target, participant.generation]))
      if (latest) delete latest.restoredRefs
    }
    let marks = wake !== false
    if (wake === false) {
      // Only news waiting here is kept current. Watcher's hidden wake-up never changes, and a turn's end it carries was told
      // with the facts it had; what changed since rides with the next turn's end.
      const key = targetKey(target), held = this.pending.filter(event => targetKey(event.target) === key)
      const waiting = held.filter(event => event.kind === 'evidence-changed')
      const ending = held.some(event => TURN_ENDS.has(event.kind))
      if (!waiting.length && !(ending && (this.toldLocal.get(key) ?? NOTHING_TOLD) !== this.evidence.digest(target, 'local'))) return
      // Keeping a pull request's waiting news current keeps it news that needs Watcher, but no news that came since.
      marks = waiting.some(event => this.waking.has(event.id))
    }
    // A pull request's change needs Watcher; the thread's own facts only ride with what does (needsAttention).
    this.evidenceWakes = marks ? wake === true ? 'fresh' : 'inherited' : false
    try { this.event('evidence-changed', target, evidenceIds, { evidenceIds, revision: observationDigest(evidenceIds) }) } finally { this.evidenceWakes = false }
  }
  pairedEvidence(hostId: string, facts: readonly WatcherEvidence[]): void {
    if (!this.started || this.closed) return
    const changed = new Map<string, WatcherThreadTarget>(), before = new Map<string, string[]>(), pullRequests = new Map<string, string>()
    for (const fact of facts) {
      if (fact.target.hostId !== hostId) continue
      const key = targetKey(fact.target)
      if (!before.has(key)) { before.set(key, this.knownEvidenceIds(fact.target)); pullRequests.set(key, this.evidence.digest(fact.target, 'pull-request')) }
      if (this.evidence.paired(fact)) changed.set(key, fact.target)
    }
    for (const [key, target] of changed) this.evidenceChanged(target, before.get(key), false, pullRequests.get(key) !== this.evidence.digest(target, 'pull-request'))
  }
  pullRequest(read: PullRequestObservation): void {
    if (this.closed) return
    const snapshot = this.options.snapshot()
    if (!snapshot.hostId) return
    for (const thread of snapshot.threads) if ([...thread.pullRequests ?? [], ...thread.worktree?.git?.pullRequest ? [thread.worktree.git.pullRequest] : []]
      .some(pr => pullRequestKey(pr.url) === pullRequestKey(read.url))) {
      const target = { hostId: thread.hostId ?? snapshot.hostId, threadId: thread.id }
      const before = this.knownEvidenceIds(target)
      if (this.evidence.pullRequest(target, read)) this.evidenceChanged(target, before)
    }
    this.options.changed?.()
  }
  restoreCheckpoint(read: CheckpointObservation): void {
    if (!this.started || this.closed) return
    const hostId = this.options.snapshot().hostId
    if (!hostId) return
    const target = { hostId, threadId: read.threadId }, id = this.evidence.checkpointIdentity(target, read)
    const referenced = this.workers().some(({ request, participant }) => targetKey(participant.target) === targetKey(target)
      && this.latestEvidence.get(observationDigest(['evidence-changed', request.id, target, participant.generation]))?.restoredRefs?.has(id))
    if (!referenced) return
    this.evidence.checkpoint(target, read)
    this.evidenceChanged(target)
  }
  checkpoint(read: CheckpointObservation): void {
    if (this.closed) return
    const snapshot = this.options.snapshot()
    if (!snapshot.hostId) return
    const target = { hostId: snapshot.hostId, threadId: read.threadId }
    const before = this.knownEvidenceIds(target)
    // A checkpoint is the thread's own working copy: it rides with its turn's end, never a wake-up of its own.
    if (this.evidence.checkpoint(target, read)) this.evidenceChanged(target, before, false, false)
    this.options.changed?.()
  }
  /**
   * Whether each of these events may still go, asked as one pass: main prunes its queued wake-ups after every pass, and
   * asking for each queued event alone read the merged snapshot and the record once per event (#1070).
   */
  dueAll(events: readonly WatcherEvent[]): boolean[] { return this.withPassReads(() => events.map(event => this.due(event))) }
  due(event: WatcherEvent): boolean {
    if (!this.started || this.closed) return false
    const record = this.record(), standing = this.workers().find(item => item.request.standingWatchId === event.requestId)
    const request = standing?.request ?? record.requests.find(item => item.id === event.requestId)
    if (!record.current || !request || request.state !== 'active' && !(event.kind === 'taken-over' && request.state === 'closed') || targetKey(record.current.target) !== targetKey(request.watcher)) return false
    const participant = standing?.participant ?? request.participants.find(item => targetKey(item.target) === targetKey(event.target))
    if (!participant || participant.generation !== event.generation || participant.automationStopped) return false
    if (event.kind === 'taken-over') return participant.state === 'taken-over'
    if (participant.state !== 'participating') return false
    const snapshot = this.snapshot(), thread = snapshot.threads.find(item => item.id === event.target.threadId && (item.hostId ?? snapshot.hostId) === event.target.hostId)
    if (!thread || isThreadArchived(thread) || !standing && (isThreadClosed(thread) || isWorkspaceThreadSettled(thread, this.project(snapshot, thread)))) return false
    if (event.kind === 'delivery-changed') {
      const operation = record.operations.find(item => item.id === event.operationId)
      return !!operation && receiptNeedsWatcher(operation) && event.revision === observationDigest([operation.deliveryState, operation.refusalCode, operation.creationUncertain])
    }
    if (event.kind === 'evidence-changed') {
      const scope = observationDigest([event.kind, event.requestId, event.target, event.generation])
      const latest = this.latestEvidence.get(scope)
      if (!latest || latest.id !== event.id && latest.legacyId !== event.id) return false
      if (latest.restoredRefs) return true
      const current = observationDigest(this.evidence.read(event.target).map(item => item.id).sort())
      return event.revision === current || Boolean(latest.legacyId === event.id && event.evidenceIds
        && event.revision === observationDigest(event.evidenceIds) && current === observationDigest([...event.evidenceIds].sort()))
    }
    if (!this.connected(snapshot, thread)) return false
    if (event.kind === 'needs-user') return thread.requests.some(card => card.id === event.requestCardId && requestRevision(card) === event.revision)
    if (event.kind === 'quiet') return !!this.progress.get(targetKey(event.target))?.quiet && this.active(thread) && !thread.requests.length
    // Work that started again withdraws it; stillDue keeps the turn owed it.
    if (event.kind === 'work-settled') return finishedTurn(thread)?.id === event.turnId && this.workSettled(thread, event.target.hostId)
    return !!thread.lastTurn && thread.lastTurn.id === event.turnId && thread.status !== 'running' && thread.lastTurn.status === (event.kind === 'turn-failed' ? 'failed' : 'completed')
  }
  close(): void { this.closed = true; this.cancelBatch?.(); this.cancelObserve?.(); this.cancelObserve = undefined; for (const progress of this.progress.values()) progress.cancel?.(); this.pending = []; this.rememberPending.clear() }
  async drained(): Promise<void> { await this.tail }
}
