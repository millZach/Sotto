import { capabilitiesForThread, isThreadProviderConnected, type AgentHostSnapshot, type AgentThread } from '../../shared/agents'
import { isThreadArchived, isThreadClosed, isWorkspaceThreadSettled } from '../../shared/threadActivity'
import { WATCHER_QUIET_MS, watcherObservationKey, type WatcherObservation } from '../../shared/watcherOverview'
import type { WatcherEvidence, WatcherRecord, WatcherThreadTarget } from '../../shared/watcher'
import { WATCHER_BATCH_MS, WATCHER_BATCH_MAX_MS, type WatcherEvent, type WatcherNews } from '../../shared/watcherNews'
import { pullRequestKey } from '../../shared/gitPullRequests'
import { WatcherEvidenceStore, observationDigest, targetKey, type CheckpointObservation, type PullRequestObservation } from './watcherEvidence'
import { foldWatcherEvents, foldWatcherNews, requestRevision } from './watcherNews'

const RETRY_LIMIT = 8
const RETRY_MAX_MS = 60_000

interface Progress { fingerprint: string; connected: boolean; connectedAt: number; progressAt: number; quiet: boolean; links?: Set<string>; cancel?: () => void }
/** Opaque progress only: no plan, message, tool input or output text crosses the host projection. */
export function watcherProgressFingerprint(thread: AgentThread): string {
  return observationDigest([thread.status, thread.lastTurn, thread.messages.map(message => [message.id, message.text.length]),
    thread.activities?.map(activity => [activity.id, activity.status, activity.startedAt, activity.completedAt, activity.text?.length, activity.output?.length, activity.steps?.map(step => [step.status, step.text.length]), activity.agents?.map(agent => [agent.id, agent.status, agent.progress, agent.message?.length]) ]), thread.backgroundWork?.map(work => [work.id, work.type]), thread.monitoring?.map(work => work.id), thread.requests.map(card => [card.id, card.kind])])
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
  snapshot: () => AgentHostSnapshot; record: () => WatcherRecord
  progress?: (target: WatcherThreadTarget) => string | undefined
  /**
   * Which hosts report their threads' background work counts, read once per pass: the answer it returns is asked for each
   * host. Absent means every host does; one that does not reads as unknown.
   */
  reportsWork?: () => (hostId: string) => boolean
  /** The Watcher start or send a thread's newest turn answers, so its news can name that operation. */
  answers?: (target: WatcherThreadTarget, thread: AgentThread, record: WatcherRecord) => string | undefined
  restoredEvents?: () => readonly WatcherEvent[]
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
  /** Finished turns, per request and generation, that left background work running: each is owed one work-settled event. */
  private readonly owedWorkSettled = new Set<string>()
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
  /** The reads the synchronous pass under way shares; see `withPassReads`. */
  private pass: { snapshot?: AgentHostSnapshot; record?: WatcherRecord; reportsWork?: (hostId: string) => boolean } | undefined
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
  private active(thread: AgentThread): boolean { return thread.status === 'running' || thread.lastTurn?.status === 'running' || Boolean(thread.backgroundWork?.length || thread.monitoring?.length) }
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
   * most once. Each of those reads copies whole state (a paired host's shell, the record) or lists every host, so a pass
   * that asked again for every thread, operation or event grew with all of them (#1023). Nothing in a pass changes them;
   * a pass already under way shares its reads, and the next pass, after any wait, reads afresh.
   */
  private withPassReads<T>(read: () => T): T {
    if (this.pass) return read()
    this.pass = {}
    try { return read() } finally { this.pass = undefined }
  }
  private snapshot(): AgentHostSnapshot { return this.pass ? this.pass.snapshot ??= this.options.snapshot() : this.options.snapshot() }
  private record(): WatcherRecord { return this.pass ? this.pass.record ??= this.options.record() : this.options.record() }
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
    // Observations and new events cannot shorten an outstanding persistence backoff.
    if (this.retryAt && this.cancelBatch) return
    if (!this.cancelBatch) this.firstPending = this.now()
    this.cancelBatch?.()
    const delay = this.retryAt ? this.retryAt - this.now() : Math.min(WATCHER_BATCH_MS, this.firstPending + WATCHER_BATCH_MAX_MS - this.now())
    this.cancelBatch = this.schedule(() => { this.cancelBatch = undefined; this.flush() }, Math.max(0, delay))
  }
  private flush(): void {
    const { events, watcher } = this.withPassReads(() => ({ events: this.canDeliver() ? this.stillDue(this.pending) : [], watcher: this.record().current?.target }))
    if (events.length) this.pending = []
    if (this.closed || !events.length && !this.rememberPending.size) return
    const news = watcher && events.length ? foldWatcherNews(undefined, { source: 'watcher', watcher, events, omitted: 0 }) : undefined
    this.tail = this.tail.catch(() => undefined).then(async () => {
      if (this.closed) return
      let failed = false
      // A fresh pass after the wait: the state may have moved, but one recheck reads it once for every event.
      const valid = news && { ...news, events: this.withPassReads(() => this.stillDue(news.events)) }
      if (valid?.events.length) {
        try {
          // Recheck after the serialized lane; recipient refusal is held, not retried by a timer.
          if (this.canDeliver()) {
            await this.options.deliver(valid)
            if (this.closed) return
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
  private observePass(): void {
    if (!this.started || this.closed) return
    const snapshot = this.snapshot(), stamp = new Date(this.now()).toISOString()
    const targets = new Set<string>(), watched = new Set(this.watchedTargets().map(targetKey))
    for (const thread of snapshot.threads) {
      if (thread.kind === 'watcher' || thread.kind === 'watcher-history' || !snapshot.hostId) continue
      const target = { hostId: thread.hostId ?? snapshot.hostId, threadId: thread.id }, key = targetKey(target)
      targets.add(key)
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
        const changedEvidence = this.evidence.observeThread(thread, target, stamp)
        if (changedEvidence) this.evidenceChanged(target, before, added)
        const turn = thread.lastTurn, finished = finishedTurn(thread)
        // A finish is news only for a watched thread, so no other thread's finish costs its extras.
        if (finished && watched.has(key)) {
          // The news names the delegation this turn answers, when there is one. The name is an identity, never words.
          const operationId = this.options.answers?.(target, thread, this.record())
          const answers = operationId ? { operationId } : {}
          // A host that does not report the counts sends no count: unknown, never none running. Unknown sub-agents count, so
          // a finish while they are unresolved says the turn is not done and is owed work-settled news.
          this.event(finished.status === 'failed' ? 'turn-failed' : 'turn-finished', target, [finished.id, finished.status],
            { turnId: finished.id, ...answers, ...this.reportsWork(target.hostId) ? { backgroundWorkCount: watcherBackgroundWorkCount(thread) } : {},
              evidenceIds: this.evidence.read(target).filter(item => item.turnId === finished.id).map(item => item.id) })
          if (this.workSettled(thread, target.hostId)) this.event('work-settled', target, [finished.id], { turnId: finished.id, ...answers, backgroundWorkCount: 0 })
        }
        for (const card of thread.requests) this.event('needs-user', target, [card.id, requestRevision(card)],
          { requestCardId: card.id, requestCardKind: card.kind, revision: requestRevision(card), ...(turn ? { turnId: turn.id } : {}) })
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
        progress.quiet = true
        this.event('quiet', target, progress.progressAt, { ...(live.lastTurn ? { turnId: live.lastTurn.id } : {}) })
        this.options.changed?.()
      }, Math.max(0, Math.max(progress.progressAt, progress.connectedAt) + WATCHER_QUIET_MS - this.now()))
    }
    for (const [key, progress] of this.progress) if (!targets.has(key)) { progress.cancel?.(); this.progress.delete(key) }
    this.evidence.removeMissing(targets)
    for (const { participant } of this.workers(true)) if (participant.state === 'taken-over') this.event('taken-over', participant.target, participant.takeover)
    for (const operation of this.record().operations) if (['accepted', 'failed'].includes(operation.deliveryState)) {
      const revision = observationDigest([operation.deliveryState, operation.refusalCode, operation.creationUncertain])
      this.event('delivery-changed', operation.target, [operation.id, revision], { operationId: operation.id, revision })
    }
    this.pending = this.stillDue(this.pending)
    if (!this.pending.length && !this.rememberPending.size) { this.cancelBatch?.(); this.cancelBatch = undefined }
    this.batch()
    // Withdrawal is advisory; the queue also rechecks before claim and at the provider writer.
    this.tail = this.tail.catch(() => undefined).then(() => this.closed ? undefined : this.options.prune()).catch(() => this.options.failed?.())
  }
  private knownEvidenceIds(target: WatcherThreadTarget): string[] {
    return this.evidence.knownIdentities(target)
  }
  private evidenceChanged(target: WatcherThreadTarget, before: readonly string[] = [], added = false): void {
    const evidenceIds = this.evidence.read(target).map(item => item.id).sort()
    // A changed or removed already-observed fact is real news, including an unlink during incomplete recovery.
    const identities = this.evidence.identities(target)
    if (added || before.some(id => !identities.has(id))) for (const { request, participant } of this.workers()) {
      if (targetKey(participant.target) !== targetKey(target)) continue
      const latest = this.latestEvidence.get(observationDigest(['evidence-changed', request.id, target, participant.generation]))
      if (latest) delete latest.restoredRefs
    }
    this.event('evidence-changed', target, evidenceIds, { evidenceIds, revision: observationDigest(evidenceIds) })
  }
  pairedEvidence(hostId: string, facts: readonly WatcherEvidence[]): void {
    if (!this.started || this.closed) return
    const changed = new Map<string, WatcherThreadTarget>(), before = new Map<string, string[]>()
    for (const fact of facts) {
      if (fact.target.hostId !== hostId) continue
      const key = targetKey(fact.target)
      if (!before.has(key)) before.set(key, this.knownEvidenceIds(fact.target))
      if (this.evidence.paired(fact)) changed.set(key, fact.target)
    }
    for (const [key, target] of changed) this.evidenceChanged(target, before.get(key))
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
    if (this.evidence.checkpoint(target, read)) this.evidenceChanged(target, before)
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
      return !!operation && event.revision === observationDigest([operation.deliveryState, operation.refusalCode, operation.creationUncertain])
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
  close(): void { this.closed = true; this.cancelBatch?.(); for (const progress of this.progress.values()) progress.cancel?.(); this.pending = []; this.rememberPending.clear() }
  async drained(): Promise<void> { await this.tail }
}
