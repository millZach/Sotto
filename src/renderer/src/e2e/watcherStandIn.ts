import { z } from 'zod'
import type { SottoBridge } from '../../../shared/contracts'
import { watcherIdentitySchema, type WatcherRefusal } from '../../../shared/watcher'
import { watcherRoomStateSchema, type WatcherBridge, type WatcherRoomState } from '../../../shared/watcherRoom'

/** Where an end-to-end run leaves the projection the room should show, before it reloads the window. */
export const WATCHER_STAND_IN_KEY = 'sotto.e2e.watcherRoom'

export const watcherStandInSeedSchema = z.object({
  state: watcherRoomStateSchema,
  /** The identity `open` reports as created; without one, `open` refuses. */
  created: watcherIdentitySchema.optional(),
}).strict()
export type WatcherStandInSeed = z.infer<typeof watcherStandInSeedSchema>

const NOT_HERE: WatcherRefusal = { status: 'refused', code: 'HOST_FEATURE_UNAVAILABLE', message: 'This test run does not stop threads.', retryable: false }

/**
 * Main's Watcher bridge, stood in for by an end-to-end run that seeds one, so the room's renderer is checked on a
 * fixed projection whatever main's side does. `open` takes the seeded identity as the one main created, and
 * Threads in flight saves the real setting, as main's own `setLimit` does. Without a seed there is no stand-in.
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
    prepareStopAll: async () => NOT_HERE,
    stopAll: async () => NOT_HERE,
    onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
