import { z } from 'zod'
import type { SottoBridge } from '../../../shared/contracts'
import { watcherIdentitySchema, type WatcherRefusal, type WatcherThreadTarget } from '../../../shared/watcher'
import { watcherRoomStateSchema, type WatcherBridge, type WatcherRoomState } from '../../../shared/watcherRoom'

/** Where an end-to-end run leaves the projection the room should show, before it reloads the window. */
export const WATCHER_STAND_IN_KEY = 'sotto.e2e.watcherRoom'

export const watcherStandInSeedSchema = z.object({
  state: watcherRoomStateSchema,
  /** The identity `open` reports as created; without one, `open` refuses. */
  created: watcherIdentitySchema.optional(),
  /** Whether the provider confirms a permission change at once; without, the current Watcher stays on its mode. */
  permissionConfirms: z.boolean().optional(),
  /** Watch and Stop watching refuse with this, as main does for a thread it cannot watch. */
  watchRefusal: z.string().optional(),
}).strict()
export type WatcherStandInSeed = z.infer<typeof watcherStandInSeedSchema>

const NOT_HERE: WatcherRefusal = { status: 'refused', code: 'HOST_FEATURE_UNAVAILABLE', message: 'This test run does not stop threads.', retryable: false }
const same = (a: WatcherThreadTarget, b: WatcherThreadTarget): boolean => a.hostId === b.hostId && a.threadId === b.threadId

/**
 * Main's Watcher bridge, stood in for by an end-to-end run that seeds one, so the room's renderer is checked on a
 * fixed projection whatever main's side does. `open` takes the seeded identity as the one main created, and
 * Threads in flight saves the real setting, as main's own `setLimit` does. Permissions, Watch and Stop watching answer
 * as the contract says main does: the remembered mode and the current Watcher's, and a standing watch with the row
 * marked watched, kept until Stop watching. Without a seed there is no stand-in.
 */
export function createE2EWatcherBridge(sotto: SottoBridge | undefined): WatcherBridge | undefined {
  let raw: string | null
  try { raw = localStorage.getItem(WATCHER_STAND_IN_KEY) } catch { return undefined }
  if (raw === null) return undefined
  const seed = watcherStandInSeedSchema.parse(JSON.parse(raw))
  let state: WatcherRoomState = seed.state
  const listeners = new Set<(next: WatcherRoomState) => void>()
  const publish = (patch: Partial<WatcherRoomState>): WatcherRoomState => {
    state = { ...state, ...patch, observedAt: new Date().toISOString() }
    for (const listener of [...listeners]) listener(state)
    return state
  }
  return {
    get: async () => ({ status: 'ok', state }),
    open: async request => {
      if (seed.created === undefined) return { ...NOT_HERE, message: 'This test run starts no Watcher.' }
      return { status: 'ok', state: publish({ current: { ...seed.created, provider: request.provider },
        currentOptions: { modelId: request.modelId, reasoningEffort: request.reasoningEffort ?? null, status: 'idle', connected: true } }) }
    },
    setLimit: async ({ limit }) => {
      const saved = await sotto?.updateSettings({ watcherInFlightLimit: limit })
      return { status: 'ok', state: publish({ inFlightLimit: saved?.watcherInFlightLimit ?? limit }) }
    },
    setPermission: async ({ runtimeMode }) => {
      const confirms = seed.permissionConfirms !== false
      return { status: 'ok', state: publish({ runtimeMode,
        currentOptions: state.currentOptions === null || !confirms ? state.currentOptions : { ...state.currentOptions, runtimeMode } }) }
    },
    watchThread: async ({ target }) => {
      if (seed.watchRefusal !== undefined) return { ...NOT_HERE, code: 'HOST_DISCONNECTED', message: seed.watchRefusal, retryable: true }
      const watches = state.standingWatches ?? []
      const known = state.watchedThreads.some(row => same(row.target, target))
      return { status: 'ok', state: publish({
        standingWatches: watches.some(watch => same(watch.target, target)) ? watches
          : [...watches, { id: crypto.randomUUID(), target, createdAt: new Date().toISOString(), generation: 0 }],
        watchedThreads: known ? state.watchedThreads.map(row => same(row.target, target) ? { ...row, watched: true, paused: false } : row)
          : [...state.watchedThreads, { target, title: target.threadId, watched: true, paused: false, status: 'idle', connected: true, settled: false,
            backgroundWorkCount: 0, waitsOn: [], participation: [] }],
      }) }
    },
    unwatchThread: async ({ target }) => {
      if (seed.watchRefusal !== undefined) return { ...NOT_HERE, code: 'HOST_DISCONNECTED', message: seed.watchRefusal, retryable: true }
      return { status: 'ok', state: publish({
        standingWatches: (state.standingWatches ?? []).filter(watch => !same(watch.target, target)),
        watchedThreads: state.watchedThreads.map(row => same(row.target, target) ? { ...row, watched: false, paused: false } : row),
      }) }
    },
    prepareStopAll: async () => NOT_HERE,
    stopAll: async () => NOT_HERE,
    onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
