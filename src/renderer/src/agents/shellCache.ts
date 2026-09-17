import { agentShell, type AgentState } from '../../../shared/agents'

/**
 * The last shell the window saw, kept so the Threads page paints its rows on the first frame after a
 * restart instead of waiting for main to connect its providers and answer.
 *
 * What is kept is what the sidebar draws and nothing else: no thread's messages, no attachment bytes,
 * no draft attachments. A restored shell is handed back marked `stale` and disconnected, so nothing on
 * the page offers an action that needs a live provider until the first real state lands.
 *
 * localStorage is already scoped to this install's renderer origin, so the cache never crosses windows
 * of different user data folders. Nothing is written while Keep local history is off.
 */
export const SHELL_CACHE_KEY = 'sotto:agent-shell:v1'
/** Beyond this the cache is not worth its write; a workspace that large repaints from main instead. */
const MAX_CACHE_BYTES = 1_000_000

export interface ShellCacheStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function storage(): ShellCacheStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

/**
 * The shell as it is safe to keep: what a sidebar row draws, and nothing else. Drafts, follow-ups and
 * delivery evidence are deliberately dropped rather than trimmed — they are durable in main, and a copy
 * from the last run is not evidence of what is on disk now.
 */
export function cacheableShell(state: AgentState): AgentState {
  const shell = agentShell(state)
  return {
    ...shell,
    host: { ...shell.host, threads: shell.host.threads.map(thread => ({ ...thread, activities: [] })) },
    draft: '', draftAttachments: [], threadDrafts: [], threadDraftPersistence: [],
    deliveries: [], deliveredDrafts: [], followups: [], followupReceipts: [],
    stale: true,
  }
}

/** The cached shell, already marked stale and disconnected, or null when there is nothing to paint. */
export function readShellCache(store: ShellCacheStorage | null = storage()): AgentState | null {
  const raw = store?.getItem(SHELL_CACHE_KEY)
  if (!raw) return null
  try {
    const state = JSON.parse(raw) as AgentState
    if (typeof state !== 'object' || state === null || !('host' in state)) return null
    return {
      ...state, stale: true, busy: false, error: null, connection: 'disconnected',
      host: { ...state.host, connected: false,
        providers: state.host.providers?.map(provider => ({ ...provider, connection: 'disconnected' as const })) },
    }
  } catch { return null }
}

/** Keeps the newest shell, or clears the cache when the user is not keeping local history. */
export function writeShellCache(state: AgentState, store: ShellCacheStorage | null = storage()): void {
  if (store === null) return
  if (state.historyEnabled === false) { clearShellCache(store); return }
  try {
    const serialized = JSON.stringify(cacheableShell(state))
    if (serialized.length > MAX_CACHE_BYTES) { clearShellCache(store); return }
    store.setItem(SHELL_CACHE_KEY, serialized)
  } catch { clearShellCache(store) }
}

export function clearShellCache(store: ShellCacheStorage | null = storage()): void {
  try { store?.removeItem(SHELL_CACHE_KEY) } catch { /* a full or blocked store is not an error worth showing */ }
}
