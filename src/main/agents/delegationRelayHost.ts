import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { delegationWorkSchema, type DelegationNews, type DelegationWork } from '../../shared/delegation'
import type { DelegationNewsDetail } from './delegationNews'
import { DELEGATION_RELAY_ANSWER_BYTES_MAX, DELEGATION_RELAY_ANSWER_GRACE_MS, DELEGATION_RELAY_READ_MS, DELEGATION_RELAY_RECORDS_MAX,
  relayAwayWords, type DelegationRelayAsk, type RelayedReply } from '../../shared/delegationRelay'
import { watcherOutcomeSchema, type WatcherOutcome } from '../../shared/watcher'
import { AtomicJsonStore } from '../storage/atomicJsonStore'

/** A desktop connected to this host whose hello accepted `delegation-relay`: the socket's way to push it an ask. */
export interface RelayDesktop {
  readonly clientId: string
  /** Pushes the ask; false when the socket would not take it. */
  push(askId: string, ask: DelegationRelayAsk): boolean
  /** Its hello accepted `delegation-relay-send` too: it takes second briefs (#1316 part 2). */
  readonly sends?: boolean
}
/** Why an ask has no answer: no desktop was connected to send it to, or the answer never came. */
export class RelayUnanswered extends Error {
  constructor(readonly stage: 'away' | 'lost') { super(stage === 'away' ? 'No desktop is connected.' : 'The desktop did not answer.') }
}

const id = z.string().min(1).max(512)
const recordSchema = z.object({
  /** The ID the delegating thread knows it by: the desktop's delegation ID, or the host's `relayId` when the start's answer was lost. */
  id: z.uuid(), relayId: z.uuid(), delegatingThreadId: id, work: delegationWorkSchema,
  /** A second brief to a thread started before (#1316 part 2); a start has none. */
  action: z.literal('send').optional(),
  /** The desktop's delegation ID, once its answer named one. */
  delegation: z.uuid().optional(),
  /** The delegated thread on the other machine, by that machine's Sotto thread ID, once the desktop named it. */
  thread: id.optional(),
  /** The machine it started on, as the desktop named it. */
  machine: z.string().min(1).max(200).optional(),
  outcome: watcherOutcomeSchema, told: watcherOutcomeSchema.optional(),
  /** The start's answer was lost, or a read could not reach the desktop: read it exactly once the desktop is back. */
  unread: z.literal(true).optional(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict()
type RelayedRecord = z.infer<typeof recordSchema>
/** The record's bound on disk: settled ones go past `DELEGATION_RELAY_RECORDS_MAX`, open ones never do, so this is far above it. */
const fileSchema = z.object({ version: z.literal(1), delegations: z.array(recordSchema).max(100_000),
  /** The name a desktop that relays last saved for this machine, which the away refusal says (Zach, October 27, 2026). */
  name: z.string().min(1).max(64).optional() }).strict()
type RelayFile = z.infer<typeof fileSchema>

/** Outcomes after which a relayed delegation is read no more, unless its read was lost. */
const SETTLED: ReadonlySet<WatcherOutcome> = new Set(['answered', 'failed', 'stopped', 'unknown'])
/** What the delegating thread reads of a relayed delegation while the desktop is away: the last outcome Sotto read, said as such. */
const LAST_READ = 'This computer is not connected now, so this is the outcome Sotto last read there. Sotto reads it again when this computer is back, and sends this thread a wake-up if it changed. Nothing was sent again.'
/** What a start whose answer was lost says (ADR-0058): Sotto cannot tell whether it started, and sends nothing again. */
const LOST_START = 'Sotto asked This computer to start this delegation, but its answer was lost, so Sotto cannot tell whether it started. Nothing will be sent again. Call read_delegation with this delegation once this computer is back to see what happened.'
const LOST_SEND = 'Sotto asked This computer to send this brief, but its answer was lost, so Sotto cannot tell whether it was sent. Nothing will be sent again. Call read_delegation with this delegation once this computer is back to see what happened.'
/** A second brief to a thread on another machine, which the desktop that relays cannot carry: one from before #1316 part 2. */
export const RELAY_SEND_LATER = 'That thread is on another machine, and Sotto cannot send it another brief from here yet. Start a new delegation instead, or ask the user to send it there. Nothing was sent.'
const LOST_CANCEL = 'This computer did not answer, so Sotto cannot tell whether it was stopped. Call read_delegation with this delegation to see where it stands.'
const now = (): string => new Date().toISOString()
/** How many replies wait in memory for their wake-up to be worded. */
const REPLIES_KEPT = 200
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * A headless host's side of the desktop relay (#1316, ADR-0105 decisions 1 and 6, Owl `cross-machine-work`): how a thread
 * here delegates to a thread on another machine. It asks the desktop that relays, over the connection that desktop
 * already keeps here, and keeps its own record of each relayed delegation in `delegation-relay.json`: identities and
 * outcomes only, never a brief or a reply. The delegated thread's own record is the desktop's, and the desktop answers
 * exact reads of it.
 *
 * While no desktop that relays is connected, a start elsewhere is refused by name and nothing is queued. An ask whose
 * answer is lost is never sent again (ADR-0058): its delegation reads `unknown` until the desktop is back, when every
 * open relayed delegation is read exactly, and one the desktop cannot prove stays `unknown`. With several desktops
 * connected, the one connected last relays.
 */
export class HostDelegationRelay {
  private readonly store: AtomicJsonStore<RelayFile>
  private records: RelayedRecord[] = []
  private savedName: string | undefined
  private readonly desktops: RelayDesktop[] = []
  private readonly pending = new Map<string, { readonly desktop: RelayDesktop; readonly resolve: (answer: unknown) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }>()
  private deliver: ((threadId: string, news: DelegationNews) => Promise<void>) | undefined
  private reconciling: Promise<void> | undefined
  /**
   * Answered relayed delegations' replies, by the ID the thread knows, newest last: held in memory only until the wake-up
   * that carries them is worded, as delegation keeps none on disk (ADR-0105 decision 6).
   */
  private readonly replies = new Map<string, NonNullable<DelegationNewsDetail['reply']>>()
  /** Starts still waiting for the desktop's answer, by the thread that asked: news may name what they made before they hear. */
  private readonly starting = new Map<string, Set<Promise<unknown>>>()
  private closed = false

  constructor(directory: string, private readonly options: {
    /** This machine's own name, said when no desktop has told it one. Its host name by default. */
    readonly here?: () => string
    /**
     * Whether a desktop may relay: still paired here with an answers grant, read at every ask (Zach, October 27, 2026). The
     * start goes through the one connected last of those. Absent, every desktop whose hello accepted the feature may.
     */
    readonly counts?: (clientId: string) => boolean
    /** Stable event names only, never a brief, a reply or a thread. */
    readonly log?: (event: 'delegation-relay-answer-lost' | 'delegation-relay-reconciled') => void
  } = {}) {
    this.store = new AtomicJsonStore(join(directory, 'delegation-relay.json'), input => fileSchema.parse(input), (): RelayFile => ({ version: 1, delegations: [] }))
  }

  async load(): Promise<void> {
    const file = await this.store.read().catch((): RelayFile => ({ version: 1, delegations: [] }))
    this.records = file.delegations
    this.savedName = file.name
  }
  /** A relaying desktop's name for this machine: the away refusal says it from now on, after a restart too. */
  async named(desktop: RelayDesktop, name: string): Promise<void> {
    if (!this.desktops.includes(desktop)) return
    const trimmed = name.trim().slice(0, 64)
    if (!trimmed || trimmed === this.savedName) return
    this.savedName = trimmed
    await this.persist()
  }
  close(): void {
    this.closed = true
    for (const [askId, ask] of [...this.pending]) { clearTimeout(ask.timer); this.pending.delete(askId); ask.reject(new RelayUnanswered('lost')) }
  }
  /** How a relayed delegation's news reaches the thread that delegated: as its hidden wake-up, the way delegation's own does. */
  useDelivery(deliver: (threadId: string, news: DelegationNews) => Promise<void>): void { this.deliver = deliver }

  /** This machine's name in the words a thread here is told. */
  hereName(): string { return this.savedName ?? ((this.options.here?.() ?? hostname()).trim().slice(0, 64) || 'this machine') }
  /** The desktop that relays now: the one connected last that may, or none. */
  private relaying(): RelayDesktop | undefined { return this.desktops.findLast(desktop => this.options.counts?.(desktop.clientId) ?? true) }
  /** Whether a desktop that relays is connected now. */
  reachable(): boolean { return this.relaying() !== undefined }
  /** The words for a start elsewhere while no desktop that relays is connected (Zach, October 23, 2026). */
  awayWords(): string { return relayAwayWords(this.hereName()) }

  /** A desktop's hello accepted `delegation-relay`: it relays from now on, and every open relayed delegation is read again. */
  desktopConnected(desktop: RelayDesktop): void {
    if (this.closed) return
    const at = this.desktops.indexOf(desktop)
    if (at !== -1) this.desktops.splice(at, 1)
    this.desktops.push(desktop)
    void this.reconcile()
  }
  /** Its socket closed: an ask still waiting on it has lost its answer. */
  desktopGone(desktop: RelayDesktop): void {
    const at = this.desktops.indexOf(desktop)
    if (at !== -1) this.desktops.splice(at, 1)
    for (const [askId, ask] of [...this.pending]) if (ask.desktop === desktop) { clearTimeout(ask.timer); this.pending.delete(askId); ask.reject(new RelayUnanswered('lost')) }
  }
  /** The desktop's answer to an ask: true when it was one this host is waiting for from that desktop. */
  answered(desktop: RelayDesktop, askId: string, answer: unknown): boolean {
    const ask = this.pending.get(askId)
    if (!ask || ask.desktop.clientId !== desktop.clientId) return false
    this.pending.delete(askId); clearTimeout(ask.timer)
    let size = Infinity
    try { size = Buffer.byteLength(JSON.stringify(answer) ?? '', 'utf8') } catch { /* An answer that cannot be written out is too large to read. */ }
    if (size > DELEGATION_RELAY_ANSWER_BYTES_MAX || !isObject(answer)) ask.reject(new RelayUnanswered('lost'))
    else ask.resolve(answer)
    return true
  }

  /** Asks the desktop that relays and waits for its answer, at most `timeoutMs`. Nothing is ever asked twice. */
  private ask(ask: DelegationRelayAsk, timeoutMs: number): Promise<Record<string, unknown>> {
    const desktop = this.relaying()
    if (!desktop || this.closed) return Promise.reject(new RelayUnanswered('away'))
    const askId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(askId)) reject(new RelayUnanswered('lost')) }, timeoutMs)
      timer.unref?.()
      this.pending.set(askId, { desktop, resolve: answer => resolve(answer as Record<string, unknown>), reject, timer })
      let pushed: boolean
      try { pushed = desktop.push(askId, ask) } catch { pushed = false }
      // A push the socket would not take never went: nothing can have started.
      if (!pushed && this.pending.delete(askId)) { clearTimeout(timer); reject(new RelayUnanswered('away')) }
    })
  }

  /**
   * Starts a delegated thread on another machine for `callerId`, admitted here as the caller's own delegation is. The
   * record is saved before the ask goes, so a lost answer still names what was asked; a refusal leaves nothing behind.
   */
  async start(callerId: string, work: DelegationWork, ask: Omit<Extract<DelegationRelayAsk, { type: 'start' }>, 'type' | 'relayId' | 'threadId'>): Promise<Record<string, unknown>> {
    if (!this.reachable()) throw new RelayUnanswered('away')
    const relayId = randomUUID(), time = now()
    return await this.asking({ id: relayId, relayId, delegatingThreadId: callerId, work, outcome: 'working', createdAt: time, updatedAt: time },
      { type: 'start', relayId, threadId: callerId, ...ask }, ask.waitMs)
  }
  /**
   * Sends another brief to `thread`, a thread `callerId` delegated to through the relay, as the desktop named it (#1316 part
   * 2). The desktop charges it against the same four briefs per thread per user message as any brief. A desktop from
   * before it is told nothing: the call is refused, and nothing is sent.
   */
  async send(callerId: string, work: DelegationWork, thread: string, ask: Omit<Extract<DelegationRelayAsk, { type: 'send' }>, 'type' | 'relayId' | 'threadId'>): Promise<Record<string, unknown>> {
    const desktop = this.relaying()
    if (!desktop) throw new RelayUnanswered('away')
    if (desktop.sends !== true) return { status: 'refused', code: 'UNKNOWN_THREAD', message: RELAY_SEND_LATER }
    const relayId = randomUUID(), time = now()
    return await this.asking({ id: relayId, relayId, delegatingThreadId: callerId, work, action: 'send', thread, outcome: 'working', createdAt: time, updatedAt: time },
      { type: 'send', relayId, threadId: callerId, ...ask, input: { ...ask.input, thread } }, ask.waitMs)
  }
  private async asking(record: RelayedRecord, body: DelegationRelayAsk, waitMs: number): Promise<Record<string, unknown>> {
    const callerId = record.delegatingThreadId
    this.records.push(record)
    this.trim()
    await this.save()
    let answer: Record<string, unknown>
    const asked = this.ask(body, waitMs + DELEGATION_RELAY_ANSWER_GRACE_MS)
    const waiting = this.starting.get(callerId) ?? new Set<Promise<unknown>>()
    waiting.add(asked); this.starting.set(callerId, waiting)
    void asked.catch(() => undefined).finally(() => { waiting.delete(asked); if (!waiting.size && this.starting.get(callerId) === waiting) this.starting.delete(callerId) })
    try { answer = await asked }
    catch (error) {
      if (error instanceof RelayUnanswered && error.stage === 'away') { this.forget(record); await this.persist(); throw error }
      // The counting rule (Zach, October 23): what cannot be told apart from a start counts as one, and is read once the desktop is back.
      this.options.log?.('delegation-relay-answer-lost')
      this.update(record, saved => { saved.outcome = 'unknown'; saved.told = 'unknown'; saved.unread = true })
      await this.persist()
      return { status: 'ok', delegation: { id: record.id, ...record.thread ? { thread: record.thread } : {}, work: record.work, action: record.action ?? 'start', outcome: 'unknown',
        note: record.action === 'send' ? LOST_SEND : LOST_START, createdAt: record.createdAt } }
    }
    const delegation = isObject(answer.delegation) ? answer.delegation : undefined
    if (answer.status !== 'ok' || !delegation || typeof delegation.id !== 'string') { this.forget(record); await this.persist(); return answer }
    // A retry with the same retry key reads the first call's delegation, which this machine already keeps.
    if (this.records.some(item => item !== record && item.delegatingThreadId === callerId && item.delegation === delegation.id)) this.forget(record)
    else this.adopt(record, delegation, answer)
    await this.persist()
    return answer
  }
  /** An answered relayed delegation's reply for the wake-up that tells it, as the desktop sent it; none once worded or never sent. */
  detail(delegationId: string): DelegationNewsDetail | undefined {
    const reply = this.replies.get(delegationId)
    return reply ? { reply } : undefined
  }
  private keepReply(delegationId: string, reply: NonNullable<DelegationNewsDetail['reply']>): void {
    this.replies.delete(delegationId); this.replies.set(delegationId, reply)
    if (this.replies.size > REPLIES_KEPT) this.replies.delete(this.replies.keys().next().value!)
  }
  /** Whether `delegationId` is one of `callerId`'s relayed delegations. */
  holds(callerId: string, delegationId: string): boolean { return this.find(callerId, delegationId) !== undefined }
  /** Whether `threadId` is a thread on another machine that `callerId` delegated to through the relay. */
  holdsThread(callerId: string, threadId: string): boolean { return this.records.some(record => record.delegatingThreadId === callerId && record.thread === threadId) }

  /** Reads a relayed delegation exactly from the desktop, or, while it is away, as Sotto last read it, said as such. */
  async read(callerId: string, delegationId: string): Promise<Record<string, unknown>> {
    const record = this.find(callerId, delegationId)!
    try {
      const answer = await this.ask({ type: 'read', threadId: callerId, ...(record.delegation ? { delegation: record.delegation } : { relayId: record.relayId }) }, DELEGATION_RELAY_READ_MS)
      this.fromRead(record, answer)
      await this.persist()
      return this.asKnown(record, answer)
    } catch {
      this.update(record, saved => { saved.unread = true; saved.told = saved.outcome })
      await this.persist()
      return { status: 'ok', delegation: this.lastRead(record) }
    }
  }
  /** Cancels a relayed delegation on the desktop, as `cancel_delegation` there does. While it is away, nothing is stopped and the call says so. */
  async cancel(callerId: string, delegationId: string): Promise<Record<string, unknown>> {
    const record = this.find(callerId, delegationId)!
    if (!record.delegation) return { status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: `${LOST_CANCEL} Nothing was stopped.` }
    if (!this.reachable()) return { status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: `${this.awayStop()} Nothing was stopped.` }
    try {
      const answer = await this.ask({ type: 'cancel', threadId: callerId, delegation: record.delegation }, DELEGATION_RELAY_READ_MS)
      this.fromRead(record, answer)
      await this.persist()
      return this.asKnown(record, answer)
    } catch { return { status: 'refused', code: 'PROVIDER_UNAVAILABLE', message: LOST_CANCEL } }
  }
  /** `callerId`'s relayed delegations as `read_delegation` lists them, newest twenty, oldest first. */
  list(callerId: string): { id: string; thread?: string; work: DelegationWork; action: 'start' | 'send'; outcome: WatcherOutcome; machine?: string; createdAt: string }[] {
    return this.records.filter(record => record.delegatingThreadId === callerId).slice(-20).map(record => ({ id: record.id, ...(record.thread ? { thread: record.thread } : {}),
      work: record.work, action: record.action ?? 'start' as const, outcome: record.outcome, ...(record.machine ? { machine: record.machine } : {}), createdAt: record.createdAt }))
  }
  /** The machines the desktop lists, or undefined while it is away or does not answer. */
  async machines(): Promise<Record<string, unknown> | undefined> {
    if (!this.reachable()) return undefined
    try { return await this.ask({ type: 'machines' }, DELEGATION_RELAY_READ_MS) } catch { return undefined }
  }

  /**
   * The desktop's news of relayed delegations `threadId` made: each moved outcome is kept and told to the thread as its
   * hidden wake-up, and only once delivered counts as told. Rejects when it could not be delivered, so the desktop offers it again.
   */
  async news(threadId: string, news: DelegationNews, replies: readonly RelayedReply[] = []): Promise<void> {
    if (!this.deliver) throw new Error('This host cannot tell its threads yet.')
    const recordOf = (delegationId: string) => this.records.find(saved => saved.delegatingThreadId === threadId && (saved.delegation === delegationId || saved.id === delegationId))
    // News can come before the answer to the start that made it: it waits for that answer, so it is never dropped (#1316 review).
    if (news.items.some(item => !recordOf(item.delegationId))) await Promise.allSettled([...this.starting.get(threadId) ?? []]).then(async () => { await this.persist() })
    const unknown = news.items.filter(item => !recordOf(item.delegationId))
    const items = news.items.flatMap(item => {
      const record = recordOf(item.delegationId)
      if (!record) return []
      this.update(record, saved => { saved.outcome = item.outcome; delete saved.unread })
      const reply = replies.find(saved => saved.delegationId === item.delegationId)
      if (reply && item.outcome === 'answered') this.keepReply(record.id, { messageId: reply.messageId, text: reply.text, truncated: reply.truncated })
      return record.told === item.outcome && item.heldMinutes === undefined ? [] : [{ record, item: { ...item, delegationId: record.id } }]
    })
    await this.persist()
    await this.tell(threadId, items)
    // What this host holds no record of was not delivered, so it is not taken: the desktop offers it again.
    if (unknown.length) throw new Error('This host holds no record of that delegation.')
  }

  /**
   * Reads every open relayed delegation exactly, once a desktop that relays is connected again (ADR-0058): what the
   * desktop's record says then is what stands, `unknown` included, and each thread is told what moved. Nothing is sent again.
   */
  reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling
    const run = (async () => {
      const open = this.records.filter(record => record.unread === true || !SETTLED.has(record.outcome))
      const moved = new Map<string, { record: RelayedRecord; item: DelegationNews['items'][number] }[]>()
      for (const record of open) {
        if (!this.reachable() || this.closed) break
        try {
          const answer = await this.ask({ type: 'read', threadId: record.delegatingThreadId, ...(record.delegation ? { delegation: record.delegation } : { relayId: record.relayId }) }, DELEGATION_RELAY_READ_MS)
          this.fromRead(record, answer, false)
        } catch { continue }
        if (record.outcome !== 'working' && record.outcome !== record.told) {
          const items = moved.get(record.delegatingThreadId) ?? []
          items.push({ record, item: { delegationId: record.id, threadId: record.thread ?? record.id, outcome: record.outcome } })
          moved.set(record.delegatingThreadId, items)
        }
      }
      await this.persist()
      for (const [threadId, items] of moved) await this.tell(threadId, items).catch(() => undefined)
      if (open.length) this.options.log?.('delegation-relay-reconciled')
    })().finally(() => { this.reconciling = undefined })
    this.reconciling = run
    return run
  }

  private async tell(threadId: string, items: readonly { record: RelayedRecord; item: DelegationNews['items'][number] }[]): Promise<void> {
    if (!items.length || !this.deliver) return
    await this.deliver(threadId, { source: 'delegation', items: items.map(({ item }) => item) })
    for (const { record, item } of items) record.told = item.outcome
    await this.persist()
  }
  /** What a read or cancel answered: the desktop's outcome, or `unknown` when it holds nothing it can prove. */
  private fromRead(record: RelayedRecord, answer: Record<string, unknown>, tells = true): void {
    const delegation = isObject(answer.delegation) ? answer.delegation : undefined
    const outcome = watcherOutcomeSchema.safeParse(delegation?.outcome)
    if (answer.status === 'ok' && delegation && outcome.success) {
      this.adopt(record, delegation, answer, tells)
      // A read after a reconnect carries the reply, which the wake-up it leads to then carries too.
      const reply = isObject(delegation.reply) ? delegation.reply : undefined
      if (!tells && outcome.data === 'answered' && reply && typeof reply.messageId === 'string' && typeof reply.text === 'string')
        this.keepReply(record.id, { messageId: reply.messageId, text: reply.text, truncated: reply.truncated === true })
    }
    else if (answer.status === 'refused' || (answer.status === 'ok' && !outcome.success)) this.update(record, saved => { saved.outcome = 'unknown'; if (tells) saved.told = 'unknown'; delete saved.unread })
  }
  /** Keeps what a desktop's answer names of a delegation: its ID there, its thread, its outcome, and where it started. */
  private adopt(record: RelayedRecord, delegation: Record<string, unknown>, answer: Record<string, unknown>, tells = true): void {
    const outcome = watcherOutcomeSchema.safeParse(delegation.outcome)
    const placement = isObject(answer.placement) ? answer.placement : undefined
    this.update(record, saved => {
      if (typeof delegation.id === 'string' && z.uuid().safeParse(delegation.id).success) {
        saved.delegation = delegation.id
        // The ID the thread was told first stands: a lost answer's relayId, or the desktop's own.
        if (saved.id === saved.relayId && !saved.unread && saved.told === undefined) saved.id = delegation.id
      }
      if (typeof delegation.thread === 'string' && id.safeParse(delegation.thread).success) saved.thread = delegation.thread
      if (typeof placement?.name === 'string' && placement.name.trim()) saved.machine = placement.name.trim().slice(0, 200)
      saved.outcome = outcome.success ? outcome.data : 'unknown'
      // A call's own result tells the thread; a read after a reconnect does not, so what moved is sent as news.
      if (tells) saved.told = saved.outcome
      delete saved.unread
    })
  }
  /** The desktop's answer, with the delegation named as this thread knows it. */
  private asKnown(record: RelayedRecord, answer: Record<string, unknown>): Record<string, unknown> {
    return isObject(answer.delegation) ? { ...answer, delegation: { ...answer.delegation, id: record.id } } : answer
  }
  private lastRead(record: RelayedRecord): Record<string, unknown> {
    return { id: record.id, ...(record.thread ? { thread: record.thread } : {}), work: record.work, action: record.action ?? 'start', outcome: record.outcome, note: LAST_READ, createdAt: record.createdAt }
  }
  private awayStop(): string { return `This computer isn't connected to ${this.hereName()}, so Sotto could not stop this delegation there.` }
  private find(callerId: string, delegationId: string): RelayedRecord | undefined {
    return this.records.find(record => record.delegatingThreadId === callerId && (record.id === delegationId || record.delegation === delegationId))
  }
  private update(record: RelayedRecord, change: (record: RelayedRecord) => void): void { change(record); record.updatedAt = now() }
  private forget(record: RelayedRecord): void { this.records = this.records.filter(item => item !== record) }
  /** Keeps the newest, dropping only settled ones, oldest first: one still open, or whose read was lost, is never forgotten (#1316 review). */
  private trim(): void {
    let excess = this.records.length - DELEGATION_RELAY_RECORDS_MAX
    if (excess <= 0) return
    this.records = this.records.filter(record => excess <= 0 || !SETTLED.has(record.outcome) || record.unread === true || excess-- <= 0)
  }
  private save(): Promise<void> { return this.store.writeLatest(() => ({ version: 1, delegations: this.records, ...this.savedName ? { name: this.savedName } : {} })) }
  private persist(): Promise<void> { return this.save().catch(() => undefined) }
}
