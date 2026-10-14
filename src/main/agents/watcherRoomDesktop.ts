import type { WatcherBridge, WatcherRoomState } from '../../shared/watcherRoom'
import type { WatcherService } from './watcher'
import { coalesceAgentStatePublishes, type PublishScheduler } from './control'

type RoomService = Pick<WatcherService, 'subscribe' | 'get' | 'open' | 'prepareStopAll' | 'stopAll'>

/** Owns only the desktop room delivery. Observation, authority and other subscribers stay with Watcher. */
export function createWatcherRoomDesktop(options: {
  watcherEnabled: boolean
  streamingPublishCost: boolean
  watcher?: RoomService | undefined
  setLimit(limit: number): Promise<unknown>
  send(state: WatcherRoomState): boolean
  schedule?: PublishScheduler
}): { bridge: Omit<WatcherBridge, 'onChanged'>; dispose(): void } | undefined {
  if (!options.watcherEnabled) return undefined
  const watcher = options.watcher
  const unavailable = () => ({ status: 'refused', code: 'HOST_FEATURE_UNAVAILABLE',
    message: 'Turn on Run the local host in Settings and restart Sotto to use Watcher.', retryable: true } as const)
  const bridge: Omit<WatcherBridge, 'onChanged'> = {
    get: async () => watcher?.get() ?? unavailable(),
    open: request => watcher?.open(request) ?? Promise.resolve(unavailable()),
    prepareStopAll: async () => watcher?.prepareStopAll() ?? unavailable(),
    stopAll: request => watcher?.stopAll(request.confirmationId) ?? Promise.resolve(unavailable()),
    setLimit: async request => { if (!watcher) return unavailable(); await options.setLimit(request.limit); return watcher.get() },
  }
  // Keep the legacy callback/replies, without captures or a publisher, when either owner is absent.
  if (!options.streamingPublishCost || !watcher) {
    const unsubscribe = watcher?.subscribe(state => options.send(state))
    return { bridge, dispose: () => unsubscribe?.() }
  }
  const publisher = coalesceAgentStatePublishes<WatcherRoomState>(state => { options.send(state) }, options.schedule ? { schedule: options.schedule } : {})
  const unsubscribe = watcher.subscribe(state => publisher.publish(structuredClone(state)))
  const reply = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
    try { return await operation() }
    finally { publisher.flush() }
  }
  return {
    bridge: {
      get: () => reply(() => bridge.get()),
      open: request => reply(() => bridge.open(request)),
      prepareStopAll: () => reply(() => bridge.prepareStopAll()),
      stopAll: request => reply(() => bridge.stopAll(request)),
      setLimit: request => reply(() => bridge.setLimit(request)),
    },
    dispose: () => { unsubscribe(); publisher.dispose() },
  }
}
