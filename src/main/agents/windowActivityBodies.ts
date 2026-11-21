import { isTerminalActivity, type AgentActivity } from '../../shared/agentActivity'
import { cutActivityBodies } from '../../shared/activityBodies'
import { agentActivitySignature, isAgentThreadDetailDelta } from '../../shared/agentThreadDetail'
import type { AgentActivityDelta, AgentThreadDetail, AgentThreadDetailUpdate } from '../../shared/agents'

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
 * This computer's thread histories as the main window is handed them, with each finished record's bodies over the limit
 * cut, as a paired host already cuts them for the desktop (ADR-0025, October 18 amendment): the window holds what its rows
 * draw, and reads a record whole (`activityBody`) when one of them opens. On November 20, 2026 the owner's "Locate Control
 * Builder blocks" crossed whole at 25.6 MB on a first open, twice, IPC and then the context bridge (#2737).
 *
 * A record still running goes whole, so its output keeps crossing as appends of its new lines (ADR-0025, October 30
 * amendment) rather than as the whole record again on each one; it is cut by the change that finishes it. An append to a
 * record the window holds cut would join a cut body, so it goes as the record cut again, read from where the history
 * stands now.
 *
 * Each read of a history hands over fresh copies of its records, so what a cut left of each record's bodies is kept by
 * its ID and signature for the threads sent most recently, and a thread opened again is not cut again. Only the bodies
 * are kept: every other field comes from the record as it is now.
 */
export class WindowActivityBodies {
  /** By thread, then record: what the window was sent of each record it holds cut. */
  private readonly kept = new Map<string, Map<string, KeptCut>>()

  constructor(private readonly wholeRecord: (threadId: string, activityId: string) => AgentActivity | null) {}

  /** A thread's history whole, its finished records' bodies over the limit cut. */
  detail(detail: AgentThreadDetail | null): AgentThreadDetail | null {
    if (detail === null) return null
    if (detail.activities === undefined) { this.kept.delete(detail.threadId); return detail }
    const before = this.kept.get(detail.threadId)
    const kept = new Map<string, KeptCut>()
    let changed = false
    const activities = detail.activities.map(record => {
      const sent = this.record(record, before, kept)
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
    const kept = this.kept.get(update.threadId)
    let changed = false
    const activityDeltas: AgentActivityDelta[] = []
    for (const item of update.activityDeltas) {
      if ('record' in item) {
        const record = this.record(item.record, kept, kept)
        if (record !== item.record) changed = true
        activityDeltas.push(record === item.record ? item : { record })
      } else if ('removed' in item) {
        kept?.delete(item.id)
        activityDeltas.push(item)
      } else if (kept?.has(item.id)) {
        // Appends are made only for a running record, which is never cut; this holds if one ever is.
        const whole = this.wholeRecord(update.threadId, item.id)
        if (whole === null) return null
        changed = true
        activityDeltas.push({ record: this.record(whole, kept, kept) })
      } else activityDeltas.push(item)
    }
    return changed ? { ...update, activityDeltas } : update
  }

  /** A record as the window is sent it: cut, from `before` when its signature has not moved, and noted in `after`. */
  private record(record: AgentActivity, before: Map<string, KeptCut> | undefined, after: Map<string, KeptCut> | undefined): AgentActivity {
    if (!isTerminalActivity(record.status)) { after?.delete(record.id); return record }
    const signature = agentActivitySignature(record)
    const held = before?.get(record.id)
    if (held?.signature === signature) { after?.set(record.id, held); return laid(record, held) }
    const sent = cutActivityBodies(record)
    if (sent === record) { after?.delete(record.id); return record }
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

function keptCut(record: AgentActivity, sent: AgentActivity, signature: string): KeptCut {
  let diffs: Map<number, string> | undefined
  if (sent.changes !== record.changes) sent.changes?.forEach((change, index) => {
    if (change !== record.changes![index]) (diffs ??= new Map()).set(index, change.diff!)
  })
  return { signature, cut: sent.cut,
    ...sent.output !== record.output ? { output: sent.output } : {},
    ...sent.text !== record.text ? { text: sent.text } : {},
    ...diffs ? { diffs } : {} }
}

/** `record` with the bodies its last cut left, which its unchanged signature says it still has. */
function laid(record: AgentActivity, kept: KeptCut): AgentActivity {
  const diffs = kept.diffs
  return { ...record,
    ...kept.output !== undefined ? { output: kept.output } : {},
    ...kept.text !== undefined ? { text: kept.text } : {},
    ...diffs && record.changes ? { changes: record.changes.map((change, index) => diffs.has(index) ? { ...change, diff: diffs.get(index)! } : change) } : {},
    ...kept.cut !== undefined ? { cut: kept.cut } : {} }
}
