import { randomUUID } from 'node:crypto'
import { BACKGROUND_WORK_LABELS, MAX_BACKGROUND_WORK, MAX_MONITOR_LABEL, type AgentBackgroundWork, type BackgroundWorkType } from '../../shared/agentMonitoring'
import type { MuseItem } from './museActivity'

interface Open {
  readonly turnId: string
  /** What it counts as, or undefined for a workflow's own agent, which only keeps its row running. */
  readonly type: BackgroundWorkType | undefined
  readonly label: string
  readonly startedAt: string
  readonly id: string
  /** Its turn completed while it ran: it is background work until its own completion. */
  background: boolean
}
const words = (value: unknown): string | undefined => typeof value === 'string'
  ? value.split(/\r?\n/u)[0]!.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MAX_MONITOR_LABEL) || undefined : undefined
/** A tool call's model-written arguments, which Muse sends verbatim as JSON; never a value a shell expanded. */
const argument = (args: unknown, name: string): unknown => {
  if (typeof args !== 'string') return undefined
  try { const parsed: unknown = JSON.parse(args); return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[name] : undefined } catch { return undefined }
}
/** MSP's `ItemStatus`: only `inProgress` is open, and every other value, an unknown one included, is terminal. */
const OPEN = 'inProgress'
/** How many items' newest revisions are remembered, so a late older one is never taken over a newer one. */
const REVISIONS_KEPT = 1_024

/**
 * What one Muse thread's turns leave running, read from its own host's live stream as Muse Code 1.4.20 sends it (#2636):
 *
 * - A `toolCall` still `inProgress` when its turn completes: a command that yielded and runs on (`command`).
 * - A `workflow` still `inProgress` then: a workflow Muse launched and runs on (`workflow`). Its agents carry its
 *   `workflowRunId` and are its own: they keep their rows running but are not counted beside it.
 * - A `subagent` outside a workflow still open then (`subagent`).
 *
 * Each item's own completion is its end, after which Muse starts a turn of its own to report it. An item that opens after
 * its turn completed, as a workflow's agents can, is background from the start. Only a turn that completed leaves work
 * running; a failed or stopped turn's items settle with it. Item revisions only go up (MSP's replace-iff-higher), so a
 * late older one is never taken. Live only: a history read can only end work, and a new host starts with none.
 */
export class MuseBackgroundWork {
  private readonly open = new Map<string, Open>()
  private readonly revisions = new Map<string, number>()
  private readonly completed = new Set<string>()

  /** Whether any still runs: the host must not be let go under it. */
  get holds(): boolean { return [...this.open.values()].some(open => open.background && open.type !== undefined) }

  /** Reads one live item event. Returns whether the thread's background work may have changed. */
  item(item: MuseItem): boolean {
    const known = this.revisions.get(item.itemId)
    if (known !== undefined && item.revision <= known) return false
    const raw = item as unknown as Record<string, unknown>
    const child = item.kind === 'subagent' && raw.workflowRunId !== undefined
    const type: BackgroundWorkType | undefined = item.kind === 'toolCall' ? 'command' : item.kind === 'workflow' ? 'workflow' : item.kind === 'subagent' && !child ? 'subagent' : undefined
    if (!type && !child) return false
    this.revisions.delete(item.itemId); this.revisions.set(item.itemId, item.revision)
    if (this.revisions.size > REVISIONS_KEPT) this.revisions.delete(this.revisions.keys().next().value!)
    if (item.status !== OPEN) return this.close(item.itemId)
    if (this.open.has(item.itemId) || this.open.size >= MAX_BACKGROUND_WORK * 4) return false
    const label = type === 'command' ? words(argument(raw.args, 'description')) ?? words(argument(raw.args, 'command'))
      : type === 'workflow' ? words(raw.entryId) ?? words(raw.fallbackText) : words(raw.objective) ?? words(raw.fallbackText)
    const turnId = item.turnId ?? ''
    const background = this.completed.has(turnId)
    this.open.set(item.itemId, { turnId, type, label: label ?? BACKGROUND_WORK_LABELS[type ?? 'subagent'], startedAt: new Date().toISOString(), id: randomUUID(), background })
    return background && type !== undefined
  }

  /**
   * The thread's turn ended. Completed, what it opened and has not closed runs on in the background; failed or stopped,
   * its items settle with it, and work earlier turns left keeps to its own ending.
   */
  turnEnded(turnId: string, completed: boolean): boolean {
    let changed = false
    if (completed) {
      this.completed.add(turnId)
      if (this.completed.size > 256) this.completed.delete(this.completed.values().next().value!)
    }
    for (const [itemId, open] of this.open) {
      if (open.turnId !== turnId || open.background) continue
      if (completed) { open.background = true; changed ||= open.type !== undefined } else this.open.delete(itemId)
    }
    return changed
  }

  /** A history read served these items: one it shows ended has ended, however its completion was missed live. */
  history(items: readonly MuseItem[]): boolean {
    let changed = false
    for (const item of items) if (item.status !== OPEN && this.open.has(item.itemId)) changed = this.close(item.itemId) || changed
    return changed
  }

  /** The items whose rows a completed turn leaves running, by item ID, a workflow's own agents included. */
  running(turnId: string): Set<string> {
    return new Set([...this.open].filter(([, open]) => open.turnId === turnId).map(([itemId]) => itemId))
  }

  get working(): AgentBackgroundWork[] {
    return [...this.open.values()].filter(open => open.background && open.type !== undefined).slice(0, MAX_BACKGROUND_WORK)
      .map(({ id, type, label, startedAt }) => ({ id, type: type!, label, startedAt }))
  }

  /** The host is gone: the items it was running, by item ID, which no completion will reach now. */
  clear(): string[] {
    const items = [...this.open.keys()]
    this.open.clear(); this.completed.clear(); this.revisions.clear()
    return items
  }

  private close(itemId: string): boolean {
    const open = this.open.get(itemId)
    if (!open) return false
    this.open.delete(itemId)
    return open.background && open.type !== undefined
  }
}
