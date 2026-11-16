import { randomUUID } from 'node:crypto'
import { BACKGROUND_WORK_LABELS, MAX_BACKGROUND_WORK, MAX_MONITOR_LABEL, type AgentBackgroundWork } from '../../shared/agentMonitoring'

/** How one of Cursor's subagents ended, as its row says it: a cancel is the user's stop, a disconnect an outcome nobody saw. */
export type CursorSubagentEnd = 'completed' | 'failed' | 'interrupted' | 'unknown'
const ENDS: Readonly<Record<string, CursorSubagentEnd>> = { completed: 'completed', failed: 'failed', cancelled: 'interrupted', disconnected: 'unknown' }
/** More running subagents than this on one process are not tracked: their requests are refused, as before Cursor named them. */
const MAX_TRACKED = 256

interface Child {
  /** Started by the thread's own session, not by one of its subagents: only these are the thread's background work. */
  readonly root: boolean
  /** The Task tool call that started it, the same ID the session's own tool call updates carry. */
  readonly toolCallId: string | undefined
  /** Sotto's own ID for it as background work, never Cursor's. */
  readonly id: string
  label: string
  readonly startedAt: string
  /** Its Task tool call has returned while it still runs: Cursor moved it to the background. */
  background: boolean
}
const words = (value: unknown): string | undefined => typeof value === 'string'
  ? value.split(/\r?\n/u)[0]!.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MAX_MONITOR_LABEL) || undefined : undefined
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/**
 * One Cursor process's running subagents, as its ACP stream tells a client that says it takes them (the `subagents`
 * client capability): `subagent_spawned` on the session that started one, and `subagent_state_update` on the same session
 * when it really ends. Without that capability Cursor says nothing when a subagent it moved to the background ends; its
 * Task tool call returns as it moves there, with `isBackground`, and that return is all a client would hear.
 *
 * A subagent the thread's own session started is the thread's background work from when its Task tool call returns while
 * it runs until its own ending, the way a Claude Code subagent moved to the background is (ADR-0023). One a subagent
 * started is that subagent's business, kept only so its requests, which come on its own session, reach the thread's
 * cards. Observation only: nothing here is saved, and a new process starts with none.
 */
export class CursorSubagents {
  private readonly children = new Map<string, Child>()

  /** Whether a session is a subagent of this process still running: what it asks is the thread's to answer. */
  owns(sessionId: unknown): boolean { return typeof sessionId === 'string' && this.children.has(sessionId) }

  /** Whether a Task tool call has a subagent still running. */
  running(toolCallId: string): boolean { return this.find(toolCallId) !== undefined }

  /**
   * Reads a `subagent_spawned` or `subagent_state_update` from the thread's own session (`root`) or from a running
   * subagent's. Returns what changed: a root subagent's ending, with its Task tool call and how it ended, or `true` when
   * only the record did, `false` when nothing did.
   */
  apply(update: Record<string, unknown>, root: boolean): { toolCallId: string | undefined; ended: CursorSubagentEnd } | boolean {
    const session = typeof update.subagentSessionId === 'string' && update.subagentSessionId.length <= 512 ? update.subagentSessionId : undefined
    if (!session) return false
    const cursor = record(record(update._meta)?.cursor)
    if (update.sessionUpdate === 'subagent_spawned') {
      if (this.children.has(session) || this.children.size >= MAX_TRACKED) return false
      const toolCallId = typeof cursor?.toolCallId === 'string' && cursor.toolCallId.length <= 512 ? cursor.toolCallId : undefined
      this.children.set(session, { root, toolCallId, id: randomUUID(), label: words(update.task) ?? words(update.name) ?? BACKGROUND_WORK_LABELS.subagent,
        startedAt: new Date().toISOString(), background: false })
      return true
    }
    const ended = update.sessionUpdate === 'subagent_state_update' ? ENDS[String(update.state)] : undefined
    const child = this.children.get(session)
    if (!ended || !child) return false
    this.children.delete(session)
    return child.root ? { toolCallId: child.toolCallId, ended } : true
  }

  /** The Task tool call returned with its subagent still running: that subagent is background work now. */
  backgrounded(toolCallId: string): boolean {
    const child = this.find(toolCallId)
    if (!child || child.background) return false
    child.background = true
    return true
  }

  /** The words Cursor's `cursor/task` gives a subagent, which name it better than its task's first line. */
  describe(toolCallId: string, description: unknown): void {
    const child = this.find(toolCallId); const label = words(description)
    if (child && label) child.label = label
  }

  /** The thread's background work: its own subagents Cursor moved to the background and has not said have ended. */
  get working(): AgentBackgroundWork[] {
    return [...this.children.values()].filter(child => child.root && child.background).slice(0, MAX_BACKGROUND_WORK)
      .map(child => ({ id: child.id, label: child.label, type: 'subagent' as const, startedAt: child.startedAt }))
  }

  /** The process is gone or its turn has ended: nothing it ran is running now. Says whether anything was. */
  clear(): boolean { const any = this.children.size > 0; this.children.clear(); return any }

  private find(toolCallId: string): Child | undefined {
    for (const child of this.children.values()) if (child.root && child.toolCallId === toolCallId) return child
    return undefined
  }
}
