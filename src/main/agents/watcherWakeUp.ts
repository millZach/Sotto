import { capabilitiesForThread, isThreadProviderConnected, type AgentHostSnapshot, type AgentThread } from '../../shared/agents'
import { isThreadClosed, isWorkspaceThreadSettled } from '../../shared/threadActivity'
import { WATCHER_QUIET_MS, watcherObservationKey, type WatcherObservation } from '../../shared/watcherOverview'
import type { WatcherRecord, WatcherThreadTarget } from '../../shared/watcher'
import { WATCHER_BATCH_MS, WATCHER_BATCH_MAX_MS, type WatcherEvent, type WatcherNews } from '../../shared/watcherNews'
import { pullRequestKey } from '../../shared/gitPullRequests'
import { WatcherEvidenceStore, observationDigest, targetKey, type CheckpointObservation, type PullRequestObservation } from './watcherEvidence'
import { foldWatcherEvents, foldWatcherNews, requestRevision } from './watcherNews'

const RETRY_LIMIT = 8
const RETRY_MAX_MS = 60_000

interface Progress { fingerprint: string; connected: boolean; connectedAt: number; progressAt: number; quiet: boolean; cancel?: () => void }
export interface WatcherWakeOptions {
  snapshot: () => AgentHostSnapshot; record: () => WatcherRecord
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
  constructor(private readonly options: WatcherWakeOptions) {
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? ((callback, delay) => { const timer = setTimeout(callback, delay); timer.unref?.(); return () => clearTimeout(timer) })
  }
  start(): void {
    if (this.closed || this.started) return
    this.started = true
    for (const id of this.options.record().wakeEventIds ?? []) {
      this.seen.add(id)
      const match = /^([a-f0-9]{64})\.([a-f0-9]{64})\.([a-f0-9]{64})$/u.exec(id)
      if (match) this.latestEvidence.set(match[1]!, { fingerprint: match[2]!, id })
    }
    for (const event of this.options.restoredEvents?.() ?? []) {
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
  private workers(includeClosed = false) {
    const record = this.options.record()
    return record.requests.filter(request => (request.state === 'active' || includeClosed && request.state === 'closed') && targetKey(request.watcher) === (record.current ? targetKey(record.current.target) : ''))
      .flatMap(request => request.participants.map(participant => ({ request, participant })))
  }
  private watchedWorkers() {
    return this.workers().filter(({ participant }) => participant.state === 'participating' && !participant.automationStopped)
  }
  private watchedTargets(): Set<string> { return new Set(this.watchedWorkers().map(({ participant }) => targetKey(participant.target))) }
  watchedThreadIds(): string[] {
    const hostId = this.options.snapshot().hostId
    return [...new Set(this.watchedWorkers().filter(({ participant }) => participant.target.hostId === hostId)
      .map(({ participant }) => participant.target.threadId))]
  }
  news(): WatcherEvent[] { return this.recent.filter(event => this.due(event)) }
  private event(kind: WatcherEvent['kind'], target: WatcherThreadTarget, identity: unknown, extra: Partial<WatcherEvent> = {}): void {
    for (const { request, participant } of this.workers(kind === 'taken-over').filter(item => targetKey(item.participant.target) === targetKey(target))) {
      if (kind !== 'taken-over' && (participant.state !== 'participating' || participant.automationStopped)) continue
      if (kind === 'taken-over' && participant.state !== 'taken-over') continue
      const stableId = observationDigest([kind, request.id, target, participant.generation, identity])
      let id = stableId
      if (kind === 'evidence-changed') {
        const scope = observationDigest([kind, request.id, target, participant.generation]), fingerprint = observationDigest(identity)
        const previous = this.latestEvidence.get(scope)
        if (previous?.fingerprint === fingerprint) { delete previous.restoredRefs; continue }
        // Missing source observations at restart are unknown; the waiting queue supplies text-free references.
        if (previous?.restoredRefs && this.knownEvidenceIds(target).every(id => previous.restoredRefs!.has(id))) continue
        // Preserve the latest state across restart; a return to an earlier state is a new occurrence.
        id = [scope, fingerprint, observationDigest([stableId, previous?.id ?? null])].join('.')
        const legacyId = !previous ? [stableId, observationDigest([kind, request.id, target, participant.generation,
          this.evidence.read(target).map(item => item.id)])].find(candidate => this.seen.has(candidate)) : undefined
        this.latestEvidence.delete(scope); this.latestEvidence.set(scope, { fingerprint, id, ...(legacyId ? { legacyId } : {}) })
        while (this.latestEvidence.size > 2_000) this.latestEvidence.delete(this.latestEvidence.keys().next().value!)
        // Older saved IDs remain readable and deduplicate only the first reconciled observation.
        if (legacyId) continue
      } else if (this.seen.has(id)) continue
      const event: WatcherEvent = { ...extra, kind, target, requestId: request.id, generation: participant.generation,
        observedAt: new Date(this.now()).toISOString(), id }
      this.seen.add(event.id)
      // Seen identities are bounded in memory and persisted only after a successful queue save.
      while (this.seen.size > 2_000) this.seen.delete(this.seen.values().next().value!)
      if (this.retryFailures >= RETRY_LIMIT) { this.retryFailures = 0; this.retryAt = 0 }
      this.recent = foldWatcherEvents(this.recent, [event]).slice(-400)
      this.pending = foldWatcherEvents(this.pending, [event]).filter(item => this.due(item))
      this.batch()
    }
  }
  private canDeliver(): boolean {
    const watcher = this.options.record().current?.target
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
    const events = this.canDeliver() ? this.pending.filter(event => this.due(event)) : [], watcher = this.options.record().current?.target
    if (events.length) this.pending = []
    if (this.closed || !events.length && !this.rememberPending.size) return
    const news = watcher && events.length ? foldWatcherNews(undefined, { source: 'watcher', watcher, events, omitted: 0 }) : undefined
    this.tail = this.tail.catch(() => undefined).then(async () => {
      if (this.closed) return
      let failed = false
      const valid = news && { ...news, events: news.events.filter(event => this.due(event)) }
      if (valid?.events.length) {
        try {
          // Recheck after the serialized lane; recipient refusal is held, not retried by a timer.
          if (this.canDeliver()) {
            await this.options.deliver(valid)
            if (this.closed) return
            for (const event of valid.events) this.rememberPending.add(event.id)
            while (this.rememberPending.size > 1_000) this.rememberPending.delete(this.rememberPending.values().next().value!)
          } else this.pending = foldWatcherEvents(events, this.pending).filter(event => this.due(event))
        } catch {
          if (this.closed) return
          // Keep the full batch behind the delivery limit; later observations and withdrawal still win.
          this.pending = foldWatcherEvents(events, this.pending).filter(event => this.due(event))
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
  observe(): void {
    if (!this.started || this.closed) return
    const snapshot = this.options.snapshot(), stamp = new Date(this.now()).toISOString()
    const targets = new Set<string>(), watched = this.watchedTargets()
    for (const thread of snapshot.threads) {
      if (thread.kind === 'watcher' || thread.kind === 'watcher-history' || !snapshot.hostId) continue
      const target = { hostId: thread.hostId ?? snapshot.hostId, threadId: thread.id }, key = targetKey(target)
      targets.add(key)
      const connected = this.connected(snapshot, thread)
      const previous = this.progress.get(key)
      const fingerprint = observationDigest([thread.status, thread.lastTurn, thread.messages.map(message => [message.id, message.text.length]),
        thread.activities?.map(activity => [activity.id, activity.status, activity.startedAt, activity.completedAt, activity.text?.length, activity.output?.length, activity.steps?.map(step => [step.status, step.text.length]), activity.agents?.map(agent => [agent.id, agent.status, agent.progress, agent.message?.length]) ]), thread.backgroundWork?.map(work => [work.id, work.type]), thread.monitoring?.map(work => work.id), thread.requests.map(card => [card.id, card.kind])])
      const changedProgress = !previous || previous.fingerprint !== fingerprint
      const progress: Progress = previous ?? { fingerprint, connected, connectedAt: this.now(), progressAt: this.now(), quiet: false }
      if (connected && !progress.connected) { progress.connectedAt = this.now(); progress.progressAt = this.now(); progress.quiet = false }
      if (changedProgress) { progress.fingerprint = fingerprint; progress.progressAt = this.now(); progress.quiet = false }
      progress.connected = connected
      this.progress.set(key, progress)
      const observed: WatcherObservation = { observedAt: stamp, fresh: connected && capabilitiesForThread(snapshot, thread).observe,
        connectedAt: new Date(progress.connectedAt).toISOString(), lastProgressAt: new Date(progress.progressAt).toISOString() }
      const facts = this.evidence.read(target, connected, this.now())
      const landing = facts.find(item => item.freshness === 'fresh' && ['merge-observed', 'auto-merge-observed', 'landing-action'].includes(item.fact))
      if (landing) observed.landing = { source: landing.source === 'github' ? 'github' : 'user-landing-action', observedAt: landing.observedAt, fresh: true }
      this.observations.set(watcherObservationKey(thread), observed)
      if (connected) {
        const before = this.knownEvidenceIds(target)
        const changedEvidence = this.evidence.observeThread(thread, target, stamp)
        if (changedEvidence) this.evidenceChanged(target, before)
        const turn = thread.lastTurn
        if (thread.status !== 'running' && turn && ['completed', 'failed'].includes(turn.status)) this.event(turn.status === 'failed' ? 'turn-failed' : 'turn-finished', target,
          [turn.id, turn.status], { turnId: turn.id, backgroundWorkCount: (thread.backgroundWork?.length ?? 0) + (thread.monitoring?.length ?? 0), evidenceIds: this.evidence.read(target).filter(item => item.turnId === turn.id).map(item => item.id) })
        for (const card of thread.requests) this.event('needs-user', target, [card.id, requestRevision(card)],
          { requestCardId: card.id, requestCardKind: card.kind, revision: requestRevision(card), ...(turn ? { turnId: turn.id } : {}) })
      }
      const eligible = watched.has(key) && observed.fresh && this.active(thread) && !thread.requests.length && !isThreadClosed(thread)
        && !isWorkspaceThreadSettled(thread, snapshot.projects.find(project => project.id === thread.projectId))
      if (!eligible || changedProgress) { progress.cancel?.(); delete progress.cancel }
      if (eligible && !progress.quiet && !progress.cancel) progress.cancel = this.schedule(() => {
        delete progress.cancel
        // Fresh live state and ownership, not the old snapshot closed over by a timer.
        const current = this.options.snapshot(), live = current.threads.find(item => item.id === target.threadId && (item.hostId ?? current.hostId) === target.hostId)
        if (!live || !this.connected(current, live) || !this.active(live) || live.requests.length || !this.watchedTargets().has(key)) return
        progress.quiet = true
        this.event('quiet', target, progress.progressAt, { ...(live.lastTurn ? { turnId: live.lastTurn.id } : {}) })
        this.options.changed?.()
      }, Math.max(0, Math.max(progress.progressAt, progress.connectedAt) + WATCHER_QUIET_MS - this.now()))
    }
    for (const [key, progress] of this.progress) if (!targets.has(key)) { progress.cancel?.(); this.progress.delete(key) }
    this.evidence.removeMissing(targets)
    for (const { participant } of this.workers(true)) if (participant.state === 'taken-over') this.event('taken-over', participant.target, participant.takeover)
    for (const operation of this.options.record().operations) if (['accepted', 'failed'].includes(operation.deliveryState)) {
      const revision = observationDigest([operation.deliveryState, operation.refusalCode, operation.creationUncertain])
      this.event('delivery-changed', operation.target, [operation.id, revision], { operationId: operation.id, revision })
    }
    this.pending = this.pending.filter(event => this.due(event))
    if (!this.pending.length && !this.rememberPending.size) { this.cancelBatch?.(); this.cancelBatch = undefined }
    this.batch()
    // Withdrawal is advisory; the queue also rechecks before claim and at the provider writer.
    this.tail = this.tail.catch(() => undefined).then(() => this.closed ? undefined : this.options.prune()).catch(() => this.options.failed?.())
  }
  private knownEvidenceIds(target: WatcherThreadTarget): string[] {
    return this.evidence.read(target).filter(item => !(item.availability === 'unavailable' && item.reason === 'checks-unavailable')).map(item => item.id)
  }
  private evidenceChanged(target: WatcherThreadTarget, before: readonly string[] = []): void {
    const evidenceIds = this.evidence.read(target).map(item => item.id).sort()
    // A changed or removed already-observed fact is real news, including an unlink during incomplete recovery.
    if (before.some(id => !evidenceIds.includes(id))) for (const { request, participant } of this.workers()) {
      if (targetKey(participant.target) !== targetKey(target)) continue
      const latest = this.latestEvidence.get(observationDigest(['evidence-changed', request.id, target, participant.generation]))
      if (latest) delete latest.restoredRefs
    }
    this.event('evidence-changed', target, evidenceIds, { evidenceIds, revision: observationDigest(evidenceIds) })
  }
  pullRequest(read: PullRequestObservation): void {
    if (!this.started || this.closed) return
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
  checkpoint(read: CheckpointObservation): void {
    if (!this.started || this.closed) return
    const snapshot = this.options.snapshot()
    if (!snapshot.hostId) return
    const target = { hostId: snapshot.hostId, threadId: read.threadId }
    const before = this.knownEvidenceIds(target)
    if (this.evidence.checkpoint(target, read)) this.evidenceChanged(target, before)
    this.options.changed?.()
  }
  due(event: WatcherEvent): boolean {
    if (!this.started || this.closed) return false
    const record = this.options.record(), request = record.requests.find(item => item.id === event.requestId)
    if (!record.current || !request || request.state !== 'active' && !(event.kind === 'taken-over' && request.state === 'closed') || targetKey(record.current.target) !== targetKey(request.watcher)) return false
    const participant = request.participants.find(item => targetKey(item.target) === targetKey(event.target))
    if (!participant || participant.generation !== event.generation || participant.automationStopped) return false
    if (event.kind === 'taken-over') return participant.state === 'taken-over'
    if (participant.state !== 'participating') return false
    const snapshot = this.options.snapshot(), thread = snapshot.threads.find(item => item.id === event.target.threadId && (item.hostId ?? snapshot.hostId) === event.target.hostId)
    if (!thread || isThreadClosed(thread) || isWorkspaceThreadSettled(thread, snapshot.projects.find(project => project.id === thread.projectId))) return false
    if (event.kind === 'delivery-changed') {
      const operation = record.operations.find(item => item.id === event.operationId)
      return !!operation && event.revision === observationDigest([operation.deliveryState, operation.refusalCode, operation.creationUncertain])
    }
    if (event.kind === 'evidence-changed') {
      const scope = observationDigest([event.kind, event.requestId, event.target, event.generation])
      const latest = this.latestEvidence.get(scope)
      if (!latest || latest.id !== event.id && latest.legacyId !== event.id) return false
      if (latest.restoredRefs && this.knownEvidenceIds(event.target).every(id => latest.restoredRefs!.has(id))) return true
      const current = observationDigest(this.evidence.read(event.target).map(item => item.id).sort())
      return event.revision === current || Boolean(latest.legacyId === event.id && event.evidenceIds
        && event.revision === observationDigest(event.evidenceIds) && current === observationDigest([...event.evidenceIds].sort()))
    }
    if (!this.connected(snapshot, thread)) return false
    if (event.kind === 'needs-user') return thread.requests.some(card => card.id === event.requestCardId && requestRevision(card) === event.revision)
    if (event.kind === 'quiet') return !!this.progress.get(targetKey(event.target))?.quiet && this.active(thread) && !thread.requests.length
    return !!thread.lastTurn && thread.lastTurn.id === event.turnId && thread.status !== 'running' && thread.lastTurn.status === (event.kind === 'turn-failed' ? 'failed' : 'completed')
  }
  close(): void { this.closed = true; this.cancelBatch?.(); for (const progress of this.progress.values()) progress.cancel?.(); this.pending = []; this.rememberPending.clear() }
  async drained(): Promise<void> { await this.tail }
}
