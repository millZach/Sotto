import { randomUUID } from 'node:crypto'
import { BACKGROUND_WORK_LABELS, MAX_BACKGROUND_WORK, MAX_MONITOR_LABEL, type AgentBackgroundWork } from '../../shared/agentMonitoring'

interface Work {
  readonly id: string
  readonly label: string
  readonly type: 'subagent' | 'command'
  readonly startedAt: string
  /** The tool call that started it, so its row can say it ended. */
  readonly toolId: string
  /** Ended, and OpenCode is waking the thread's session to report it; held until that run ends. */
  reporting: boolean
}
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const words = (value: unknown): string | undefined => typeof value === 'string'
  ? value.split(/\r?\n/u)[0]!.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MAX_MONITOR_LABEL) || undefined : undefined
const native = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined

/**
 * One thread's background work on its own OpenCode server, as OpenCode 2.3.0 reports it live (#2635):
 *
 * - A subagent: its `task` tool call succeeds at once, its metadata saying `status: running` and naming the child
 *   session (`sessionID`). The child's own `session.execution.succeeded`, `failed` or `interrupted` is its end.
 * - A shell command moved to the background: its tool call succeeds with `status: running` and a `shellID`, and
 *   `shell.exited` with that ID is its end.
 *
 * OpenCode then wakes the thread's session with a `<subagent>` or `<shell>` report and runs it, so an ended one is held
 * until the session's next run ends, as a Claude Code thread reads Working through its own report. What a subagent starts
 * comes on the child's own session, so it is the subagent's business. Observation only: nothing is saved, and a new
 * server starts with none.
 */
export class OpenCodeBackgroundWork {
  /** By what ends it: `session:<child session>` or `shell:<shell ID>`. */
  private readonly work = new Map<string, Work>()
  /** Endings that came before their call's success, as a quick one can: that call's work has already ended. */
  private readonly endedEarly = new Set<string>()

  /** Whether anything still runs, or is still being reported: the server must not be let go under it. */
  get holds(): boolean { return this.work.size > 0 }

  /** A tool call of the thread's session succeeded. Returns whether it left work in the background. */
  started(toolId: string, input: Record<string, unknown> | undefined, metadata: unknown): boolean {
    const meta = record(metadata)
    if (meta?.status !== 'running' || this.work.size >= MAX_BACKGROUND_WORK) return false
    const child = native(meta.sessionID), shell = native(meta.shellID)
    const key = child ? `session:${child}` : shell ? `shell:${shell}` : undefined
    if (!key || this.work.has(key) || this.endedEarly.delete(key)) return false
    this.work.set(key, child
      ? { id: randomUUID(), label: words(input?.description) ?? BACKGROUND_WORK_LABELS.subagent, type: 'subagent', startedAt: new Date().toISOString(), toolId, reporting: false }
      : { id: randomUUID(), label: words(input?.description) ?? words(input?.command) ?? BACKGROUND_WORK_LABELS.command, type: 'command', startedAt: new Date().toISOString(), toolId, reporting: false })
    return true
  }

  /**
   * A child session's run, or a shell, ended. Returns the tool call that started it, whose row reads how it ended, when
   * it was the thread's.
   */
  ended(key: `session:${string}` | `shell:${string}`): string | undefined {
    const known = this.work.get(key)
    if (!known) {
      this.endedEarly.add(key)
      if (this.endedEarly.size > MAX_BACKGROUND_WORK) this.endedEarly.delete(this.endedEarly.values().next().value!)
      return undefined
    }
    if (known.reporting) return undefined
    known.reporting = true
    return known.toolId
  }

  /** The thread's session finished a run: what it was woken to report has been reported. */
  reported(): boolean {
    let any = false
    for (const [key, known] of this.work) if (known.reporting) { this.work.delete(key); any = true }
    return any
  }

  /** The tool calls whose work still runs: a turn's end leaves their rows running. */
  get runningTools(): Set<string> { return new Set([...this.work.values()].filter(known => !known.reporting).map(known => known.toolId)) }

  get working(): AgentBackgroundWork[] {
    return [...this.work.values()].map(({ id, label, type, startedAt }) => ({ id, label, type, startedAt }))
  }

  /** The tool calls whose work was still running when the server went, which ended with it. */
  clear(): string[] {
    const running = [...this.runningTools]
    this.work.clear(); this.endedEarly.clear()
    return running
  }
}
