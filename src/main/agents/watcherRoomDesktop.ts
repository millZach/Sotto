import type { WatcherBridge, WatcherRoomListChange, WatcherRoomPatch, WatcherRoomState, WatcherRoomUpdate } from '../../shared/watcherRoom'
import type { WatcherService } from './watcher'
import { samePlainData } from './agentStateBroadcast'
import { coalesceAgentStatePublishes, type PublishScheduler } from './control'

type RoomService = Pick<WatcherService, 'subscribe' | 'state' | 'get' | 'open' | 'prepareStopAll' | 'stopAll' | 'setPermission' | 'watchThread' | 'unwatchThread'
  | 'readHandover' | 'continueWithHandover' | 'dismissHandover' | 'startNew' | 'readMergeTurns'>
type RoomBridge = Required<Omit<WatcherBridge, 'onChanged'>>

/**
 * The window's room updates (#1450): each carries what changed since the last one the window was sent, a list's
 * entries by place and a changed record as what changed in it, so a request, receipt or participation rides only when
 * it changes, and a watched thread whose status changed does not carry every participation it has had. A room in which nothing changed but the time
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
      const patch = recordPatch(base.room, room, 'observedAt')
      if (!patch) return
      update = { revision: this.revision + 1, base: base.revision, room: { ...patch.set, observedAt: room.observedAt },
        ...patch.lists ? { lists: patch.lists } : {}, ...patch.removed ? { removed: patch.removed as (keyof WatcherRoomState)[] } : {} }
    }
    this.revision = update.revision
    const resets = this.resets
    if (deliver(update) && resets === this.resets) this.base = { revision: update.revision, room }
  }

  /** The next update is the whole room: the window holds none it can measure from. */
  reset(): void { this.base = null; this.resets++ }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

/**
 * What changed from `before` to `after`, two records, or undefined when nothing did: each field set anew, each list as
 * its change, and the fields that went. `ignored` is never compared.
 */
function recordPatch(before: object, after: object, ignored?: string): WatcherRoomPatch | undefined {
  const held = before as Record<string, unknown>, next = after as Record<string, unknown>
  const set: Record<string, unknown> = {}, lists: Record<string, WatcherRoomListChange> = {}, removed: string[] = []
  let any = false
  for (const key in next) {
    if (key === ignored) continue
    const was = held[key], now = next[key]
    if (was === now && (was !== undefined || Object.hasOwn(held, key))) continue
    if (Array.isArray(was) && Array.isArray(now)) {
      const change = listChange(was, now)
      if (change) { lists[key] = change; any = true }
    } else if (!Object.hasOwn(held, key) || !samePlainData(was, now)) { set[key] = now; any = true }
  }
  for (const key in held) if (key !== ignored && !Object.hasOwn(next, key)) { removed.push(key); any = true }
  if (!any) return undefined
  return { ...Object.keys(set).length ? { set } : {}, ...Object.keys(lists).length ? { lists } : {}, ...removed.length ? { removed } : {} }
}

/**
 * The entries of `after` that differ from the entry at the same place in `before`, or undefined when none does: a
 * record that was a record there as what changed in it, anything else whole.
 */
function listChange(before: readonly unknown[], after: readonly unknown[]): WatcherRoomListChange | undefined {
  const at: [number, unknown][] = [], patch: [number, WatcherRoomPatch][] = []
  for (let index = 0; index < after.length; index++) {
    const entry = after[index], was = before[index]
    if (index < before.length && (entry === was || samePlainData(was, entry))) continue
    const changed = index < before.length && isRecord(was) && isRecord(entry) ? recordPatch(was, entry) : undefined
    if (changed) patch.push([index, changed]); else at.push([index, entry])
  }
  return at.length || patch.length || before.length !== after.length ? { length: after.length, at, ...patch.length ? { patch } : {} } : undefined
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
