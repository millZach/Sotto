// What a client holds after the messages it was sent, put together the way the desktop's and the iPhone's clients put them
// together (docs/host-protocol.md: "Changed thread records", "Kept parts", "Model catalog revisions", "Detail deltas").
//
// The host coalesces its shell and detail pushes on a 50 ms window (`coalesceAgentStatePublishes` and
// `coalesceThreadDetailPublishes` in `src/main/agents/statePublishers.ts`), so how many of them cross between two points,
// and which states in between they show, depends on timing; only the newest state is promised. The referee therefore
// compares those three kinds of push by what they leave the client holding, and everything else frame by frame. Each push
// is still read strictly as it arrives: one a client could not put back, a delta that does not follow what is held, an
// event that arrives twice or out of order, is a problem the referee reports however the end state looks.
import type { AgentThreadDetail, AgentThreadDetailDelta } from '../../src/shared/agents'
import { applyAgentThreadDetailDelta } from '../../src/shared/agentThreadDetail'
import { withKeptPartsPutBack, type HeldParts } from '../../src/shared/keptParts'
import { createThreadReassembly } from '../../src/shared/threadReassembly'
import { describeDifferences, equal } from './diff'

type Json = Record<string, unknown>

/** The pushes folded into what the client holds rather than compared one by one. */
export const FOLDED_PUSHES: ReadonlySet<string> = new Set(['shell', 'detail', 'detail-delta'])

export interface Held {
  /** The newest shell the client holds, put back whole. Undefined before hello. */
  shell: Json | undefined
  /** Each thread's detail as the client holds it, by thread ID. Null where the host said it has none. */
  details: Record<string, Json | null>
  /** Every thread event the client was sent, in order. */
  events: Json[]
}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const clone = <T>(value: T): T => structuredClone(value)

export class ClientFold {
  private readonly records = createThreadReassembly()
  private parts: HeldParts | null = null
  private catalog: { revision: number; models: unknown; lists: unknown } | null = null
  private lastSeq = -1
  readonly held: Held = { shell: undefined, details: {}, events: [] }
  /**
   * Threads whose detail the host keeps current for this client no longer: let go by an `observe` that left them out, or
   * held from before a hello. A host sends one whole again when it is observed again, at whatever revision, so the next
   * whole is taken as it comes.
   */
  private readonly letGo = new Set<string>()
  /** Each thing a client could not have read, in words, in the order it was found. */
  readonly problems: string[] = []

  private problem(words: string): void { this.problems.push(words) }

  /**
   * Puts a shell's model catalog back by its revision, and remembers one it carries (ADR-0028, October 3 amendment), with
   * the provider mode lists that go beside it (`provider-mode-lists`, November 1 amendment). Each model's modes are then
   * put back from those lists, as the desktop and the iPhone do before anything reads the catalog.
   */
  private catalogOf(shell: Json, where: string): void {
    const host = shell.host
    if (!isObject(host)) return
    if (typeof host.modelsRevision === 'number') {
      if (host.models !== undefined) this.catalog = { revision: host.modelsRevision, models: clone(host.models), lists: clone(host.providerModeLists) }
      else if (this.catalog?.revision === host.modelsRevision) {
        host.models = clone(this.catalog.models)
        if (this.catalog.lists !== undefined) host.providerModeLists = clone(this.catalog.lists)
      } else { this.problem(`${where} names model catalog revision ${host.modelsRevision}, which this connection was never sent.`); return }
    }
    if (!Array.isArray(host.models)) return
    const lists = host.providerModeLists
    for (const model of host.models as Json[]) {
      if (!isObject(model) || model.providerModeList === undefined) continue
      const list = Array.isArray(lists) && typeof model.providerModeList === 'number' ? lists[model.providerModeList] : undefined
      if (list === undefined) { this.problem(`${where} has model ${String(model.id)} name provider mode list ${String(model.providerModeList)}, which the shell does not carry.`); continue }
      model.providerModes = clone(list)
      delete model.providerModeList
    }
    delete host.providerModeLists
  }

  private events(page: unknown, where: string): void {
    if (!isObject(page) || !Array.isArray(page.events)) return
    for (const event of page.events) {
      const seq = isObject(event) ? event.seq : undefined
      if (typeof seq !== 'number') { this.problem(`${where} carries an event without a sequence number.`); continue }
      if (seq <= this.lastSeq) { this.problem(`${where} carries event ${seq} again, or out of order: the client already holds events through ${this.lastSeq}.`); continue }
      this.lastSeq = seq
      this.held.events.push(clone(event as Json))
    }
  }

  /** A hello's answer: the connection's first shell, and with `reply-thread-records` the records the next push is measured from. */
  hello(result: unknown): Json | undefined {
    if (!isObject(result) || !isObject(result.shell)) { this.problem('The hello answer carries no shell.'); return undefined }
    const shell = clone(result.shell)
    this.catalogOf(shell, 'The hello answer')
    this.replyRecords(shell, 'The hello answer')
    this.events(result, 'The hello answer')
    this.held.shell = shell
    for (const threadId of Object.keys(this.held.details)) this.letGo.add(threadId)
    return { ...result, shell: { ...shell, ...(typeof (result.shell as Json).threadRecordsRevision === 'number' ? { threadRecordsRevision: (result.shell as Json).threadRecordsRevision } : {}) } }
  }

  /** A `shell` read's answer, which a client starts again from. */
  shellRead(result: unknown): Json | undefined {
    if (!isObject(result)) return undefined
    const shell = clone(result)
    this.catalogOf(shell, 'The shell answer')
    const revision = shell.threadRecordsRevision
    this.replyRecords(shell, 'The shell answer')
    this.held.shell = shell
    return { ...shell, ...(typeof revision === 'number' ? { threadRecordsRevision: revision } : {}) }
  }

  private replyRecords(shell: Json, where: string): void {
    const host = shell.host
    if (typeof shell.threadRecordsRevision !== 'number' || !isObject(host)) return
    // Its records are held under that revision, and parts start again: the push after it keeps nothing.
    if (this.records({ revision: shell.threadRecordsRevision, base: null, changed: host.threads }) === undefined) this.problem(`${where}'s thread records cannot be held.`)
    this.parts = null
    // It names what the next push is measured from, which is the connection's business, not the state's.
    delete shell.threadRecordsRevision
  }

  /** A command's answer, its thread records put back from what is held (`command-changed-thread-records`); nothing moves. */
  commandAnswer(result: unknown): unknown {
    if (!isObject(result) || !isObject(result.host)) return result
    const shell = clone(result)
    this.catalogOf(shell, 'A command answer')
    if (shell.threadRecords !== undefined) {
      const threads = this.records.peek(shell.threadRecords)
      if (threads === undefined) this.problem('A command answer carries thread records measured from records this connection does not hold.')
      else { (shell.host as Json).threads = threads; delete shell.threadRecords }
    }
    return shell
  }

  /** One push. Shells and details move what is held; any other push is answered unchanged, for comparing as it came. */
  push(frame: Json): void {
    if (frame.event === 'shell') this.shellPush(frame)
    else if (frame.event === 'detail') this.detailPush(frame)
    else if (frame.event === 'detail-delta') this.deltaPush(frame)
  }

  private shellPush(frame: Json): void {
    if (!isObject(frame.state) || !isObject(frame.state.host)) { this.problem('A shell push carries no state.'); return }
    const raw = clone(frame.state) as Json & { host: Json }
    const threads = isObject(frame.threads) ? frame.threads : undefined
    const whole = withKeptPartsPutBack<Json & { host: Json }>(raw, threads?.base, this.parts)
    if (whole === undefined) { this.problem(`A shell push keeps parts measured from revision ${String(threads?.base)}, which is not the push this client applied last.`); return }
    this.catalogOf(whole, 'A shell push')
    this.events(frame.eventPage, 'A shell push')
    if (threads) {
      const list = this.records(threads)
      if (list === undefined) { this.problem(`A shell push carries thread records from base ${String(threads.base)} that this client cannot put back.`); return }
      this.parts = { revision: threads.revision as number, top: whole, host: whole.host }
      this.held.shell = { ...whole, host: { ...whole.host, threads: list } }
    } else {
      this.parts = null
      this.held.shell = whole
    }
  }

  /** The client sends `observe` with these threads: each it held and leaves out is let go. */
  observing(threadIds: readonly string[]): void {
    for (const threadId of Object.keys(this.held.details)) if (!threadIds.includes(threadId)) this.letGo.add(threadId)
  }

  private detailPush(frame: Json): void {
    if (typeof frame.threadId !== 'string') { this.problem('A detail push names no thread.'); return }
    const held = this.letGo.delete(frame.threadId) ? undefined : this.held.details[frame.threadId]
    // A host never sends a whole thread at a revision the client holds or older: a thread it holds is sent again only once
    // it has moved on (#2699), since a revision names what the thread holds.
    if (isObject(frame.detail) && held && typeof held.revision === 'number' && typeof frame.detail.revision === 'number' && frame.detail.revision <= held.revision) {
      if (frame.detail.revision < held.revision) this.problem(`A detail push for thread ${frame.threadId} carries revision ${frame.detail.revision}, which is older than revision ${held.revision}, which the client holds.`)
      else if (!equal(frame.detail, held)) this.problem(`A detail push for thread ${frame.threadId} carries revision ${held.revision} again, which the client holds, with something else in it: ${describeDifferences(held, frame.detail).slice(0, 3).join('; ')}.`)
      else this.problem(`A detail push for thread ${frame.threadId} carries revision ${held.revision} again, which the client holds, unchanged.`)
      return
    }
    this.held.details[frame.threadId] = isObject(frame.detail) ? clone(frame.detail) : null
  }

  private deltaPush(frame: Json): void {
    const threadId = frame.threadId, delta = frame.delta as AgentThreadDetailDelta | undefined
    if (typeof threadId !== 'string' || !isObject(delta)) { this.problem('A detail delta names no thread or carries no delta.'); return }
    const held = this.held.details[threadId]
    if (!held) { this.problem(`A detail delta for thread ${threadId} arrived before the client held its detail.`); return }
    if (delta.revision <= (held.revision as number)) { this.problem(`A detail delta to revision ${delta.revision} arrived for thread ${threadId}, whose revision ${String(held.revision)} the client already holds.`); return }
    const applied = applyAgentThreadDetailDelta(held as unknown as AgentThreadDetail, delta)
    if (applied === null) { this.problem(`A detail delta from revision ${delta.baseRevision} does not follow revision ${String(held.revision)} of thread ${threadId}, which the client holds.`); return }
    // The fields a delta does not carry, such as a step window's, stay as the detail had them.
    this.held.details[threadId] = { ...held, ...clone(applied) } as Json
  }

  /** A copy of what is held now. */
  snapshot(): Held { return clone(this.held) }
}
