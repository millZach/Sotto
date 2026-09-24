import { useEffect, useRef } from 'react'
import type { AgentState, AgentThread } from '../../../shared/agents'
import { useProactivePanelsEnabled } from '../state/gitSettings'
import { toolsPanelStore, type ToolsPanelStore } from './toolsPanelStore'

/** T3 Code's measure of a large change: a turn that changed at least this many files, or this many lines. */
export const PROACTIVE_CHANGES_MIN_FILES = 3
export const PROACTIVE_CHANGES_MIN_LINES = 50
/** How long after a turn ends its folder's next status read may still count as that turn's. */
const PROACTIVE_CHANGES_WAIT_MS = 60_000

type Counts = { readonly files: number; readonly lines: number }
type Turn = { readonly before: Counts; ended: { readonly at: number; readonly readAt: string | null } | null }

const counts = (thread: AgentThread): Counts => {
  const git = thread.worktree?.git
  return { files: git?.changedFiles ?? 0, lines: (git?.insertions ?? 0) + (git?.deletions ?? 0) }
}

/**
 * Which threads just finished a turn that changed many files, read from the Git status on their records: the
 * counts when the turn started against the counts the host reads after it ends. A turn counts once; a status read
 * after the turn ended that shows a small change, or none within a minute, closes it. Pure, so it is tested alone.
 */
export class ProactiveChangesWatch {
  private readonly turns = new Map<string, Turn>()
  observe(threads: readonly AgentThread[], now: number): string[] {
    const due: string[] = []
    const present = new Set<string>()
    for (const thread of threads) {
      present.add(thread.id)
      // A paired host's folder is on that machine; Changes does not read it, so nothing opens for it.
      if (thread.remoteHost) continue
      const turn = this.turns.get(thread.id)
      if (thread.status === 'running') {
        if (!turn || turn.ended) this.turns.set(thread.id, { before: counts(thread), ended: null })
        continue
      }
      if (!turn) continue
      const readAt = thread.worktree?.git?.readAt ?? null
      turn.ended ??= { at: now, readAt }
      if (now - turn.ended.at > PROACTIVE_CHANGES_WAIT_MS) { this.turns.delete(thread.id); continue }
      const after = counts(thread)
      if (after.files - turn.before.files >= PROACTIVE_CHANGES_MIN_FILES || after.lines - turn.before.lines >= PROACTIVE_CHANGES_MIN_LINES) {
        due.push(thread.id)
        this.turns.delete(thread.id)
      } else if (readAt !== turn.ended.readAt) this.turns.delete(thread.id)
    }
    for (const id of this.turns.keys()) if (!present.has(id)) this.turns.delete(id)
    return due
  }
  reset(): void { this.turns.clear() }
}

/**
 * Proactive panels (off unless turned on in Settings): after a turn of the thread the Tools panel would show
 * changed many files, Changes opens on its own, the way T3 Code opens its diff. Only a closed panel opens, and
 * only for that thread, so a panel the user has open on another surface or pinned elsewhere is never taken over;
 * keyboard focus stays where it was.
 */
export function useProactiveChanges(state: AgentState, focusedThreadId: string | null, store: ToolsPanelStore = toolsPanelStore): void {
  const enabled = useProactivePanelsEnabled()
  const watch = useRef<ProactiveChangesWatch | null>(null)
  watch.current ??= new ProactiveChangesWatch()
  const threads = state.host.threads
  useEffect(() => {
    if (!enabled) { watch.current!.reset(); return }
    const due = watch.current!.observe(threads, Date.now())
    if (focusedThreadId !== null && due.includes(focusedThreadId)) store.showChangesProactively(focusedThreadId)
  }, [enabled, threads, focusedThreadId, store])
}
