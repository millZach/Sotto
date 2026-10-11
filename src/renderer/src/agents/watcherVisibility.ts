import type { AgentState } from '../../../shared/agents'
import { withoutThreads } from '../../../shared/watcherVisibility'

export { visibleWatcherState, watcherThreadVisible } from '../../../shared/watcherVisibility'

/**
 * Watcher's room owns the current Watcher (ADR-0073), so the Threads page and the sidebar beside other pages
 * neither list nor select it: the thread main marks as Watcher, and the one Watcher's room names. Watcher history
 * stays where ordinary threads are. With the gate off, the gate's own filter has already hidden both kinds.
 */
export function withoutRoomWatcher(state: AgentState, enabled: boolean, current: string | null): AgentState
export function withoutRoomWatcher(state: AgentState | null, enabled: boolean, current: string | null): AgentState | null
export function withoutRoomWatcher(state: AgentState | null, enabled: boolean, current: string | null): AgentState | null {
  if (state === null || !enabled) return state
  return withoutThreads(state, new Set(state.host.threads.filter(thread => thread.kind === 'watcher' || thread.id === current).map(thread => thread.id)))
}
