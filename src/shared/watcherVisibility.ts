import type { AgentState, AgentThread } from './agents'

/** Current and earlier Watcher conversations belong to the same feature. */
export function watcherThreadVisible(thread: Pick<AgentThread, 'kind'>, enabled: boolean): boolean {
  return enabled || (thread.kind !== 'watcher' && thread.kind !== 'watcher-history')
}

/** Filter the view without changing main's saved Watcher records. Missing panes follow ordinary layout behavior. */
export function visibleWatcherState(state: AgentState, enabled: boolean): AgentState
export function visibleWatcherState(state: AgentState | null, enabled: boolean): AgentState | null
export function visibleWatcherState(state: AgentState | null, enabled: boolean): AgentState | null {
  if (state === null || enabled) return state
  return withoutThreads(state, new Set(state.host.threads.filter(thread => !watcherThreadVisible(thread, enabled)).map(thread => thread.id)))
}

/**
 * The state with these threads left out of view: their rows, their drafts and deliveries, and the selection and
 * composer when either names one of them. Main's records are untouched.
 */
export function withoutThreads(state: AgentState, hidden: ReadonlySet<string>): AgentState {
  if (hidden.size === 0 || !state.host.threads.some(thread => hidden.has(thread.id))) return state
  const hiddenDraft = state.draftThreadId !== null && hidden.has(state.draftThreadId)
  const visible = {
    ...state,
    host: { ...state.host, threads: state.host.threads.filter(thread => !hidden.has(thread.id)) },
    ...(state.activeThreadId !== null && hidden.has(state.activeThreadId) ? { activeThreadId: null, activeProjectId: null } : {}),
    ...(hiddenDraft ? { draft: '', draftThreadId: null, draftRequestId: null, draftAttachments: [], composing: false } : {}),
  }
  for (const key of ['threadDrafts', 'deliveries', 'deliveredDrafts', 'obsoleteDrafts', 'followups', 'followupReceipts', 'threadDraftPersistence', 'unconfirmedSettings'] as const) {
    const records = visible[key]
    if (records) (visible as Record<string, unknown>)[key] = records.filter(item => !hidden.has(item.threadId))
  }
  return visible
}
