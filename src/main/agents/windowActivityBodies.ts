import type { AgentActivity } from '../../shared/agentActivity'
import { cutActivityBodies, stripAgentSteps } from '../../shared/activityBodies'
import { agentActivitySignature, isAgentThreadDetailDelta } from '../../shared/agentThreadDetail'
import type { AgentActivityDelta, AgentThreadDetail, AgentThreadDetailUpdate } from '../../shared/agents'
import { sottoBrowserToolOfTitle } from '../../shared/sottoBrowserTools'

/** The threads whose cut bodies are kept, the most recently sent last: as many histories as the window keeps. */
const KEPT_THREADS = 16

/** What a record's cut left of its bodies, laid over the record as it is now when its signature has not moved. */
interface KeptCut {
  readonly signature: string
  readonly cut: AgentActivity['cut']
  readonly output?: string | undefined
  readonly text?: string | undefined
  /** Each cut change's diff, by its index in `changes`. */
  readonly diffs?: ReadonlyMap<number, string>
}

/**
 * The records the window is handed whole. A running record, so its output keeps crossing as appends of its new lines
 * (ADR-0025, October 30 amendment) rather than as the whole record again on each one; it is cut by the change that ends
 * it. And three kinds the window reads without opening a row, which a paired host's threads go without: a file change,
 * whose diffs give a turn's lines added and removed; a step in Sotto's browser, whose answer names the action and the
 * page; and reasoning, which an own server's speed card counts while its turn runs.
 */
function keptWhole(record: AgentActivity): boolean {
  return record.status === 'running' || record.kind === 'file-change' || record.kind === 'reasoning'
    || (record.kind === 'tool' && sottoBrowserToolOfTitle(record.title) !== undefined)
}

/**
 * This computer's thread histories as the main window is handed them, with each record's bodies over the limit
 * cut, as a paired host already cuts them for the desktop (ADR-0025, October 18 amendment): the window holds what its rows
 * draw, and reads a record whole (`activityBody`) when one of them opens. On November 20, 2026 the owner's "Locate Control
 * Builder blocks" crossed whole at 25.6 MB on a first open, twice, IPC and then the context bridge (#2737).
 *
 * Some records go whole (`keptWhole`). An append to a record the window holds cut would join a cut body, so it goes as
 * the record cut again, read from where the history stands now.
 *
 * Each read of a history hands over fresh copies of its records, so what a cut left of each record's bodies is kept by
 * its ID and signature for the threads sent most recently, and a thread opened again is not cut again. Only the bodies
 * are kept, each a string of its own rather than a slice that would keep the whole body alive with it: every other field
 * comes from the record as it is now. Which records the window holds cut is kept apart from the bodies, for every thread
 * it was sent, so an append to one is never joined to a cut body.
 */
export class WindowActivityBodies {
  /** By thread, then record: what the window was sent of each record it holds cut, for the threads sent most recently. */
  private readonly kept = new Map<string, Map<string, KeptCut>>()
  /** By thread: the records the window holds cut. IDs alone, so it is kept for every thread the window was sent. */
  private readonly held = new Map<string, Set<string>>()

  constructor(private readonly wholeRecord: (threadId: string, activityId: string) => AgentActivity | null) {}

  /** A thread's history whole, its records' bodies over the limit cut. */
  detail(detail: AgentThreadDetail | null): AgentThreadDetail | null {
    if (detail === null) return null
    this.held.delete(detail.threadId)
    if (detail.activities === undefined) { this.kept.delete(detail.threadId); return detail }
    const before = this.kept.get(detail.threadId)
    const kept = new Map<string, KeptCut>()
    let changed = false
    const activities = detail.activities.map(record => {
      const sent = this.record(detail.threadId, record, before, kept)
      if (sent !== record) changed = true
      return sent
    })
    this.keep(detail.threadId, kept)
    return changed ? { ...detail, activities } : detail
  }

  /** A history or a change to one as the window is sent it; null when a record an append names is no longer there. */
  update(update: AgentThreadDetailUpdate): AgentThreadDetailUpdate | null {
    if (!isAgentThreadDetailDelta(update)) return this.detail(update)
    if (update.activityDeltas.length === 0) return update
    const threadId = update.threadId
    const kept = this.kept.get(threadId)
    let changed = false
    const activityDeltas: AgentActivityDelta[] = []
    for (const item of update.activityDeltas) {
      if ('record' in item) {
        const record = this.record(threadId, item.record, kept, kept)
        if (record !== item.record) changed = true
        activityDeltas.push(record === item.record ? item : { record })
      } else if ('removed' in item) {
        kept?.delete(item.id)
        this.held.get(threadId)?.delete(item.id)
        activityDeltas.push(item)
      } else if (this.held.get(threadId)?.has(item.id)) {
        // Appends are made only for a running record, which is never cut; this holds if one ever is.
        const whole = this.wholeRecord(threadId, item.id)
        if (whole === null) return null
        changed = true
        activityDeltas.push({ record: this.record(threadId, whole, kept, kept) })
      } else activityDeltas.push(item)
    }
    return changed ? { ...update, activityDeltas } : update
  }

  /** A record as the window is sent it: cut, from `before` when its signature has not moved, and noted in `after`. */
  private record(threadId: string, record: AgentActivity, before: Map<string, KeptCut> | undefined, after: Map<string, KeptCut> | undefined): AgentActivity {
    const sent = this.sent(record, before, after)
    let held = this.held.get(threadId)
    if (sent.cut !== undefined) { if (!held) this.held.set(threadId, held = new Set()); held.add(record.id) }
    else if (held?.delete(record.id) && held.size === 0) this.held.delete(threadId)
    return sent
  }

  private sent(record: AgentActivity, before: Map<string, KeptCut> | undefined, after: Map<string, KeptCut> | undefined): AgentActivity {
    if (keptWhole(record)) { after?.delete(record.id); return stripAgentSteps(record) }
    const signature = agentActivitySignature(record)
    const kept = before?.get(record.id)
    if (kept?.signature === signature) { after?.set(record.id, kept); return laid(record, kept) }
    const sent = cutActivityBodies(record)
    if (sent.cut === undefined) { after?.delete(record.id); return sent }
    after?.set(record.id, keptCut(record, sent, signature))
    return sent
  }

  private keep(threadId: string, kept: Map<string, KeptCut>): void {
    this.kept.delete(threadId)
    if (kept.size === 0) return
    this.kept.set(threadId, kept)
    for (const oldest of this.kept.keys()) {
      if (this.kept.size <= KEPT_THREADS) break
      this.kept.delete(oldest)
    }
  }
}

/**
 * A cut body as a string of its own. A cut is a slice of its body, and V8 keeps the whole body alive behind a slice, so a
 * kept cut would hold every body it was cut from (Bug Bot on #2753: 931 MB kept for 3 MB of cuts). UTF-16 keeps every
 * code unit as it was, a lone surrogate included.
 */
const own = (value: string): string => Buffer.from(value, 'utf16le').toString('utf16le')

function keptCut(record: AgentActivity, sent: AgentActivity, signature: string): KeptCut {
  let diffs: Map<number, string> | undefined
  if (sent.changes !== record.changes) sent.changes?.forEach((change, index) => {
    if (change !== record.changes![index]) (diffs ??= new Map()).set(index, own(change.diff!))
  })
  return { signature, cut: sent.cut,
    ...sent.output !== record.output && sent.output !== undefined ? { output: own(sent.output) } : {},
    ...sent.text !== record.text && sent.text !== undefined ? { text: own(sent.text) } : {},
    ...diffs ? { diffs } : {} }
}

/** `record` with the bodies its last cut left, which its unchanged signature says it still has. */
function laid(record: AgentActivity, kept: KeptCut): AgentActivity {
  const diffs = kept.diffs
  return { ...stripAgentSteps(record),
    ...kept.output !== undefined ? { output: kept.output } : {},
    ...kept.text !== undefined ? { text: kept.text } : {},
    ...diffs && record.changes ? { changes: record.changes.map((change, index) => diffs.has(index) ? { ...change, diff: diffs.get(index)! } : change) } : {},
    ...kept.cut !== undefined ? { cut: kept.cut } : {} }
}

/** What the window's local host connection reads of this computer's threads. */
export interface LocalThreadHistories {
  threadDetail(threadId: string): AgentThreadDetail | null
  subscribeThreadDetail(listener: (update: AgentThreadDetailUpdate) => void, options: { readonly appends?: boolean }): () => void
  threadActivity(threadId: string, activityId: string): AgentActivity | null
}

/**
 * The local host connection's history reads, as a click in the sidebar makes them: each history and every change to it
 * with its long bodies cut, appends included, and one record whole when its row opens.
 */
export function windowHistories(control: LocalThreadHistories): {
  readonly detail: (threadId: string) => AgentThreadDetail | null
  readonly subscribeDetail: (listener: (update: AgentThreadDetailUpdate) => void) => () => void
  readonly activityBody: (threadId: string, activityId: string) => Promise<AgentActivity | null>
} {
  const bodies = new WindowActivityBodies((threadId, activityId) => control.threadActivity(threadId, activityId))
  return {
    detail: threadId => bodies.detail(control.threadDetail(threadId)),
    // The main window applies appends: a running command's output crosses as its new lines (ADR-0025, October 30 amendment).
    subscribeDetail: listener => control.subscribeThreadDetail(update => { const sent = bodies.update(update); if (sent !== null) listener(sent) }, { appends: true }),
    activityBody: async (threadId, activityId) => {
      const record = control.threadActivity(threadId, activityId)
      return record ? stripAgentSteps(record) : null
    },
  }
}
