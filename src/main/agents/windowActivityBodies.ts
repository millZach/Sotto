import { isTerminalActivity, type AgentActivity } from '../../shared/agentActivity'
import { CutBodies } from '../../shared/activityBodies'
import { isAgentThreadDetailDelta } from '../../shared/agentThreadDetail'
import type { AgentActivityDelta, AgentThreadDetail, AgentThreadDetailUpdate } from '../../shared/agents'

/**
 * This computer's thread histories as the main window is handed them, with each finished record's bodies over the limit
 * cut, as a paired host already cuts them for the desktop (ADR-0025, October 18 amendment): the window holds what its rows
 * draw, and reads a record whole (`activityBody`) when one of them opens. On November 20, 2026 the owner's "Locate Control
 * Builder blocks" crossed whole at 26.3 MB on a first open, twice, IPC and then the context bridge (#2737).
 *
 * A record still running goes whole, so its output keeps crossing as appends of its new lines (ADR-0025, October 30
 * amendment) rather than as the whole record again on each one; it is cut when it finishes, by the change that says so.
 * An append to a record the window holds cut would join a cut body, so it goes as the record cut again, read from where
 * the history stands now.
 */
export class WindowActivityBodies {
  private readonly bodies = new CutBodies()
  /** The records each thread's window holds cut, by thread. */
  private readonly cut = new Map<string, Set<string>>()

  constructor(private readonly current: (threadId: string, activityId: string) => AgentActivity | null) {}

  /** A thread's history whole, its finished records' bodies over the limit cut. */
  detail(detail: AgentThreadDetail | null): AgentThreadDetail | null {
    if (detail === null) return null
    this.cut.delete(detail.threadId)
    if (detail.activities === undefined) return detail
    let changed = false
    const activities = detail.activities.map(record => {
      const sent = this.record(detail.threadId, record)
      if (sent !== record) changed = true
      return sent
    })
    return changed ? { ...detail, activities } : detail
  }

  /** A history or a change to one as the window is sent it; null when a record an append names is no longer there. */
  update(update: AgentThreadDetailUpdate): AgentThreadDetailUpdate | null {
    if (!isAgentThreadDetailDelta(update)) return this.detail(update)
    if (update.activityDeltas.length === 0) return update
    let changed = false
    const activityDeltas: AgentActivityDelta[] = []
    for (const item of update.activityDeltas) {
      if ('record' in item) {
        const record = this.record(update.threadId, item.record)
        if (record !== item.record) changed = true
        activityDeltas.push(record === item.record ? item : { record })
      } else if ('removed' in item) {
        this.cut.get(update.threadId)?.delete(item.id)
        activityDeltas.push(item)
      } else if (this.cut.get(update.threadId)?.has(item.id)) {
        const whole = this.current(update.threadId, item.id)
        if (whole === null) return null
        changed = true
        activityDeltas.push({ record: this.record(update.threadId, whole) })
      } else activityDeltas.push(item)
    }
    return changed ? { ...update, activityDeltas } : update
  }

  /** A record as the window is sent it, noting whether the window now holds it cut. */
  private record(threadId: string, record: AgentActivity): AgentActivity {
    const sent = isTerminalActivity(record.status) ? this.bodies.record(record) : record
    let held = this.cut.get(threadId)
    if (sent.cut !== undefined) { if (!held) this.cut.set(threadId, held = new Set()); held.add(sent.id) }
    else if (held?.delete(sent.id) && held.size === 0) this.cut.delete(threadId)
    return sent
  }
}
