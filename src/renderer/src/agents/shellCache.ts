import { agentShell, hostForThread, type AgentHostSnapshot, type AgentModel, type AgentState } from '../../../shared/agents'

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
 * Every catalog on the shell, the host's own and each client host's, trimmed to the models its own threads
 * reference. A restored shell is stale and disconnected: nothing that offers a model needs one beyond what
 * a thread already carries until the real state lands (`ThreadOptions.canCreateWith` already refuses every
 * model but a thread's own while disconnected). The account's full catalog, hundreds of models on some
 * accounts, repaints from main once connected. The host's own catalog keeps every thread's model, whichever
 * host the thread is on: the Agents room and the browser read the active thread's model from it directly.
 */
function trimCatalogsToReferencedModels(host: AgentHostSnapshot): AgentHostSnapshot {
  const referenced = new Map<readonly AgentModel[], Set<string>>([[host.models, new Set(host.threads.map(thread => thread.modelId))]])
  for (const thread of host.threads) {
    const models = hostForThread(host, thread).models
    let ids = referenced.get(models)
    if (!ids) referenced.set(models, ids = new Set())
    ids.add(thread.modelId)
  }
  const trimmed = new Map<readonly AgentModel[], AgentModel[]>()
  const trim = (models: readonly AgentModel[]): AgentModel[] => {
    const cached = trimmed.get(models)
    if (cached) return cached
    const ids = referenced.get(models) ?? new Set<string>()
    const result = models.filter(model => ids.has(model.id))
    trimmed.set(models, result)
    return result
  }
  return { ...host, models: trim(host.models), clientHosts: host.clientHosts?.map(entry => ({ ...entry, models: trim(entry.models) })) }
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
    host: trimCatalogsToReferencedModels({ ...shell.host, threads: shell.host.threads.map(thread => ({ ...thread, activities: [], monitoring: undefined, backgroundWork: undefined })) }),
    draft: '', draftAttachments: [], threadDrafts: [], threadDraftPersistence: [],
    deliveries: [], deliveredDrafts: [], followups: [], followupReceipts: [],
    // Attention is live: what needed the user last time is not what needs them now, and a restored
    // queue would let the review narrate and navigate before main has said anything.
    queue: [], pendingRequest: '', notice: '', speech: { id: 0, text: '' },
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
      // No lane survives a restart: a cached busy mark would dim a pane nothing is working on.
      ...state, stale: true, globalLaneBusy: false, busyThreadIds: undefined, error: null, connection: 'disconnected',
      host: { ...state.host, connected: false,
        threads: state.host.threads.map(thread => ({ ...thread, monitoring: undefined, backgroundWork: undefined })),
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
