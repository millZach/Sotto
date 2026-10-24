import type { WatcherBridge, WatcherRoomListChange, WatcherRoomState, WatcherRoomUpdate } from '../../shared/watcherRoom'
import type { WatcherService } from './watcher'
import { samePlainData } from './agentStateBroadcast'
import { coalesceAgentStatePublishes, type PublishScheduler } from './control'

type RoomService = Pick<WatcherService, 'subscribe' | 'state' | 'get' | 'open' | 'prepareStopAll' | 'stopAll' | 'setPermission' | 'watchThread' | 'unwatchThread'
  | 'readHandover' | 'continueWithHandover' | 'dismissHandover' | 'startNew' | 'readMergeTurns'>
type RoomBridge = Required<Omit<WatcherBridge, 'onChanged'>>

/**
 * The window's room updates (#1450): each carries what changed since the last one the window was sent, a list's
 * entries by place, so a request or receipt rides only when it changes. A room in which nothing changed but the time
 * it was read at is not sent at all. The rooms held are the ones last sent, read and never written into, as everything
 * the room hands out is (#1327). Only an update `deliver()` reports as sent becomes the base the next is measured
 * from. `reset()` drops the base, so the next update is whole: main calls it when the window reads the whole room, as
 * it does whenever it loads or cannot apply an update. A read while a send is being delivered voids that send as a base.
 */
export class WatcherRoomBroadcast {
  private revision = 0
  private base: { readonly revision: number; readonly room: WatcherRoomState } | null = null
  private resets = 0

  /** Sends `room` measured from the last room sent, or nothing when only its read time changed. */
  send(room: WatcherRoomState, deliver: (update: WatcherRoomUpdate) => boolean): void {
    const base = this.base
    let update: WatcherRoomUpdate
    if (base === null) update = { revision: this.revision + 1, base: null, room }
    else {
      const held = base.room as Record<string, unknown>, next = room as Record<string, unknown>
      const changed: Record<string, unknown> = {}, lists: Record<string, WatcherRoomListChange> = {}, removed: (keyof WatcherRoomState)[] = []
      let any = false
      for (const key in next) {
        if (key === 'observedAt') continue
        const before = held[key], after = next[key]
        if (before === after && (before !== undefined || Object.hasOwn(held, key))) continue
        if (Array.isArray(before) && Array.isArray(after)) {
          const change = listChange(before, after)
          if (change) { lists[key] = change; any = true }
        } else if (!Object.hasOwn(held, key) || !samePlainData(before, after)) { changed[key] = after; any = true }
      }
      for (const key in held) if (!Object.hasOwn(next, key)) { removed.push(key as keyof WatcherRoomState); any = true }
      if (!any) return
      update = { revision: this.revision + 1, base: base.revision, room: { ...changed, observedAt: room.observedAt },
        ...Object.keys(lists).length ? { lists } : {}, ...removed.length ? { removed } : {} }
    }
    this.revision = update.revision
    const resets = this.resets
    if (deliver(update) && resets === this.resets) this.base = { revision: update.revision, room }
  }

  /** The next update is the whole room: the window holds none it can measure from. */
  reset(): void { this.base = null; this.resets++ }
}

/** The entries of `after` that differ from the entry at the same place in `before`, or undefined when none does. */
function listChange(before: readonly unknown[], after: readonly unknown[]): WatcherRoomListChange | undefined {
  const at: [number, unknown][] = []
  for (let index = 0; index < after.length; index++) {
    const entry = after[index]
    if (index >= before.length || entry !== before[index] && !samePlainData(before[index], entry)) at.push([index, entry])
  }
  return at.length || before.length !== after.length ? { length: after.length, at } : undefined
}

/** Owns only the desktop room delivery. Observation, authority and other subscribers stay with Watcher. */
export function createWatcherRoomDesktop(options: {
  watcherEnabled: boolean
  streamingPublishCost: boolean
  watcher?: RoomService | undefined
  send(state: WatcherRoomState | WatcherRoomUpdate): boolean
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
  // Keep the legacy callback/replies, without a publisher or updates, when either owner is absent: the room, whole, on every change.
  if (!options.streamingPublishCost || !watcher) {
    const unsubscribe = watcher?.subscribe(() => options.send(watcher.state()))
    return { bridge, dispose: () => unsubscribe?.() }
  }
  // A Watcher change only marks the room changed (#1450). The room is built when an update goes, at most once a publish
  // window however many changes it saw, from what is true then, and handed to the window at once, so it is never copied.
  const broadcast = new WatcherRoomBroadcast(), changed = {}
  const publisher = coalesceAgentStatePublishes<object>(() => { broadcast.send(watcher.state(), update => options.send(update)) },
    options.schedule ? { schedule: options.schedule } : {})
  const unsubscribe = watcher.subscribe(() => publisher.publish(changed))
  const reply = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
    try { return await operation() }
    finally { publisher.flush() }
  }
  return {
    bridge: {
      // The window reads the whole room when it loads and when it cannot apply an update, so the next update is whole.
      get: () => reply(() => { broadcast.reset(); return bridge.get() }),
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
