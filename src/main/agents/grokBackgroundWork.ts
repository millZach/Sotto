import { randomUUID } from 'node:crypto'
import { BACKGROUND_WORK_LABELS, MAX_BACKGROUND_WORK, MAX_MONITOR_LABEL, type AgentBackgroundWork } from '../../shared/agentMonitoring'

interface Subagent {
  readonly id: string
  readonly label: string
  readonly startedAt: string
  /** It outlived a turn: background work whatever the thread does next. Until then, a running turn holds it as its own. */
  outlived: boolean
  /** Finished, and Grok will run a turn of its own to report it (`subagent-completed-<id>`). */
  waking: boolean
  /** A turn began after it finished, which takes the report's place if Grok drops it for the user's prompt. */
  superseded: boolean
}
const words = (value: unknown): string | undefined => typeof value === 'string'
  ? value.split(/\r?\n/u)[0]!.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MAX_MONITOR_LABEL) || undefined : undefined
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const native = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined
/** The prompt Grok runs to report a finished subagent, named for it (Grok 1.0.77). */
const REPORT = 'subagent-completed-'
const isoTime = (value: unknown): string | undefined => {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

/**
 * One Grok thread's background work, read from its own process's live stream as Grok Build 1.0.77 sends it (#2633):
 *
 * - A subagent the thread's session starts (`subagent_spawned` with no `parent_subagent_id`) until `subagent_finished`.
 *   Grok answers the prompt while a background subagent runs, so one still running when the turn has ended is the
 *   thread's background work. While the turn runs it is the turn's own action, as a Claude Code subagent the turn waits
 *   on is (ADR-0023). A finish with `will_wake` has Grok start a turn of its own to report the result; the subagent is
 *   held until that turn completes, the way a Claude Code thread reads Working through its own report.
 * - A shell command Grok moved to the background, from `background_tasks`, the whole list of the session's tasks with
 *   each one's status, which Grok sends again whenever one starts or ends: a task listed `running` is a `command`.
 *
 * A subagent's own subagents and shells are its business (they come on its own session, or name their parent subagent).
 * Observation only: nothing here is saved, and a new process starts with none.
 */
export class GrokBackgroundWork {
  private readonly subagents = new Map<string, Subagent>()
  private commands: AgentBackgroundWork[] = []
  /** Sotto's own ID for each native task, so a command keeps its ID from one list to the next. */
  private readonly ids = new Map<string, string>()

  /** Whether anything still runs: the session must not be let go under it. */
  get holds(): boolean { return this.subagents.size > 0 || this.commands.length > 0 }

  /** Reads one update from the thread's own session. Returns whether its background work may have changed. */
  apply(update: Record<string, unknown>): boolean {
    const kind = update.sessionUpdate
    if (kind === 'subagent_spawned') {
      const subagent = native(update.subagent_id)
      if (!subagent || update.parent_subagent_id !== undefined || this.subagents.has(subagent) || this.subagents.size >= MAX_BACKGROUND_WORK) return false
      this.subagents.set(subagent, { id: randomUUID(), label: words(update.description) ?? BACKGROUND_WORK_LABELS.subagent, startedAt: new Date().toISOString(),
        outlived: false, waking: false, superseded: false })
      return true
    }
    if (kind === 'subagent_finished') {
      const subagent = native(update.subagent_id); const known = subagent ? this.subagents.get(subagent) : undefined
      if (!known) return false
      if (update.will_wake === true) known.waking = true; else this.subagents.delete(subagent!)
      return true
    }
    // A turn's end: every subagent still running has outlived it. A finished one is let go when its own report ends, or
    // the turn that began after it finished, in case Grok dropped the report for that prompt.
    if (kind === 'turn_completed') {
      const report = typeof update.prompt_id === 'string' && update.prompt_id.startsWith(REPORT) ? update.prompt_id.slice(REPORT.length) : undefined
      for (const [subagent, known] of this.subagents) {
        if (known.waking && (subagent === report || known.superseded)) this.subagents.delete(subagent)
        else known.outlived = true
      }
      return true
    }
    if (kind === 'user_message_chunk') {
      for (const known of this.subagents.values()) if (known.waking) known.superseded = true
      return true
    }
    if (kind === 'background_tasks' && Array.isArray(update.tasks)) {
      const running = update.tasks.map(record).filter(task => task?.status === 'running' && native(task.task_id)).slice(0, MAX_BACKGROUND_WORK) as Record<string, unknown>[]
      const seen = new Set(running.map(task => task.task_id as string))
      for (const task of this.ids.keys()) if (!seen.has(task)) this.ids.delete(task)
      this.commands = running.map(task => {
        const taskId = task.task_id as string
        let id = this.ids.get(taskId); if (!id) { id = randomUUID(); this.ids.set(taskId, id) }
        const startedAt = isoTime(task.started_at)
        return { id, label: words(task.description) ?? words(task.command) ?? BACKGROUND_WORK_LABELS.command, type: 'command' as const, ...(startedAt ? { startedAt } : {}) }
      })
      return true
    }
    return false
  }

  /** The thread's background work: its running shells, and its subagents except those a running turn may still wait on. */
  working(turnRunning: boolean): AgentBackgroundWork[] {
    const subagents = [...this.subagents.values()].filter(known => known.outlived || !turnRunning)
      .map(({ id, label, startedAt }) => ({ id, label, type: 'subagent' as const, startedAt }))
    return [...subagents, ...this.commands].slice(0, MAX_BACKGROUND_WORK)
  }

}
