import type { WatcherBridge, WatcherRoomState } from '../../shared/watcherRoom'
import type { WatcherService } from './watcher'
import { clonePlainData } from './cloneHostSnapshot'
import { coalesceAgentStatePublishes, type PublishScheduler } from './control'

type RoomService = Pick<WatcherService, 'subscribe' | 'get' | 'open' | 'prepareStopAll' | 'stopAll' | 'setPermission' | 'watchThread' | 'unwatchThread'
  | 'readHandover' | 'continueWithHandover' | 'dismissHandover' | 'startNew' | 'readMergeTurns'>
type RoomBridge = Required<Omit<WatcherBridge, 'onChanged'>>

/** Owns only the desktop room delivery. Observation, authority and other subscribers stay with Watcher. */
export function createWatcherRoomDesktop(options: {
  watcherEnabled: boolean
  streamingPublishCost: boolean
  watcher?: RoomService | undefined
  send(state: WatcherRoomState): boolean
  schedule?: PublishScheduler
}): { bridge: RoomBridge; dispose(): void } | undefined {
  if (!options.watcherEnabled) return undefined
  const watcher = options.watcher
  const unavailable = () => ({ status: 'refused', code: 'HOST_FEATURE_UNAVAILABLE',
    message: 'Turn on Run the local host in Settings and restart Sotto to use Watcher.', retryable: true } as const)
  const bridge: RoomBridge = {
    get: async () => watcher?.get() ?? unavailable(),
    open: request => watcher?.open(request) ?? Promise.resolve(unavailable()),
    prepareStopAll: async () => watcher?.prepareStopAll() ?? unavailable(),
    stopAll: request => watcher?.stopAll(request.confirmationId) ?? Promise.resolve(unavailable()),
    setPermission: request => watcher?.setPermission(request) ?? Promise.resolve(unavailable()),
    watchThread: request => watcher?.watchThread(request) ?? Promise.resolve(unavailable()),
    unwatchThread: request => watcher?.unwatchThread(request) ?? Promise.resolve(unavailable()),
    readHandover: async () => watcher?.readHandover() ?? unavailable(),
    continueWithHandover: async request => watcher?.continueWithHandover(request) ?? unavailable(),
    dismissHandover: async () => watcher?.dismissHandover() ?? unavailable(),
    startNew: () => watcher?.startNew() ?? Promise.resolve(unavailable()),
    readMergeTurns: async () => watcher?.readMergeTurns() ?? unavailable(),
  }
  // Keep the legacy callback/replies, without captures or a publisher, when either owner is absent.
  if (!options.streamingPublishCost || !watcher) {
    const unsubscribe = watcher?.subscribe(state => options.send(state))
    return { bridge, dispose: () => unsubscribe?.() }
  }
  const publisher = coalesceAgentStatePublishes<WatcherRoomState>(state => { options.send(state) }, options.schedule ? { schedule: options.schedule } : {})
  // The room state is plain schema data, so it is copied as such: containers copied and strings kept, not serialized again.
  const unsubscribe = watcher.subscribe(state => publisher.publish(clonePlainData(state)))
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
      setPermission: request => reply(() => bridge.setPermission(request)),
      watchThread: request => reply(() => bridge.watchThread(request)),
      unwatchThread: request => reply(() => bridge.unwatchThread(request)),
      readHandover: () => bridge.readHandover(),
      continueWithHandover: request => reply(() => bridge.continueWithHandover(request)),
      dismissHandover: () => reply(() => bridge.dismissHandover()),
      startNew: () => reply(() => bridge.startNew()),
      // A read changes nothing, so it waits for no publish.
      readMergeTurns: () => bridge.readMergeTurns(),
    },
    dispose: () => { unsubscribe(); publisher.dispose() },
  }
}
