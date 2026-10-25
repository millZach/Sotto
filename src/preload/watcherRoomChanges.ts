import { WATCHER_CHANGED, WATCHER_GET, applyWatcherRoomUpdate, watcherRoomResultSchema, type WatcherBridge, type WatcherRoomHeld, type WatcherRoomState,
  type WatcherRoomUpdate } from '../shared/watcherRoom'

/** What this needs of Electron's `ipcRenderer`: the preload's own adapter, or the real one in the Electron room benchmark. */
export interface WatcherRoomRenderer {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}
type RendererListener = (event: unknown, ...args: unknown[]) => void

/**
 * Watcher's room update is state of the same kind (#1336): main's Watcher builds it on every publish from its own records,
 * which it validated when it read or wrote them, and the room schema transforms nothing (every object is strict, and the
 * one trim is of kept notes already trimmed when they were kept), so the full parse could only hand back what came in.
 * It ran over every request, receipt, watch and news item several times a second while threads streamed. What the page
 * reads before anything else is checked: the time it orders updates by and the watched threads. Every invoke result that
 * carries the room, and everything the page sends, keeps its schema.
 */
const trustedWatcherRoom: { safeParse(value: unknown): { success: true; data: WatcherRoomState } | { success: false } } = {
  safeParse: value => typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as { observedAt?: unknown }).observedAt === 'string' && Array.isArray((value as { watchedThreads?: unknown }).watchedThreads)
    ? { success: true, data: value as WatcherRoomState }
    : { success: false },
}

/** An update rather than a room (#1450): what the streaming-publish-cost answer sends. Its parts are checked as it is applied. */
const isWatcherRoomUpdate = (value: unknown): value is WatcherRoomUpdate => typeof value === 'object' && value !== null && !Array.isArray(value)
  && typeof (value as { revision?: unknown }).revision === 'number' && ((value as { base?: unknown }).base === null || typeof (value as { base?: unknown }).base === 'number')
  && typeof (value as { room?: unknown }).room === 'object' && (value as { room?: unknown }).room !== null && !Array.isArray((value as { room?: unknown }).room)
  && ((value as { lists?: unknown }).lists === undefined || typeof (value as { lists?: unknown }).lists === 'object' && (value as { lists?: unknown }).lists !== null)
  && ((value as { removed?: unknown }).removed === undefined || Array.isArray((value as { removed?: unknown }).removed))

/**
 * Watcher's room as the page sees it: always whole (#1450). Main sends the room itself without the streaming-publish-cost
 * answer, and with it updates measured from the last it sent, which this puts back into the whole room before any listener
 * sees it, one assembly for every listener. An update it cannot apply, measured from a room it does not hold, as after a
 * reload, changes nothing it holds: it reads the whole room once, which also tells main to send the next update whole,
 * and hands that room on. While the read is out, an update it cannot apply was sent before main took the read, and the
 * read's answer covers it; a whole room main sent after it is held, and updates measured from it apply as ever. One that
 * cannot apply after such a whole room is read again once the read answers, so the window always ends with main's room.
 * The read's answer is handed on like any room: it may be older than what main sent since, and the page orders rooms by
 * the number main gives each build (`newerWatcherRoom`), so it keeps the newer.
 */
export function watcherRoomChanges(renderer: WatcherRoomRenderer): WatcherBridge['onChanged'] {
  const listeners = new Set<(state: WatcherRoomState) => void>()
  // `whole`: a whole room has come since the read went out. `again`: an update after it could not apply.
  let held: WatcherRoomHeld | null = null, reading = false, whole = false, again = false
  const deliver = (state: WatcherRoomState): void => { for (const listener of [...listeners]) listener(state) }
  const read = (): void => {
    held = null
    if (reading) { again ||= whole; return }
    reading = true; whole = false; again = false
    const answered = (): void => { reading = false; if (again && listeners.size) read() }
    void renderer.invoke(WATCHER_GET).then(value => watcherRoomResultSchema.parse(value)).then(result => {
      if (result.status === 'ok' && listeners.size) deliver(result.state)
      answered()
    }, answered)
  }
  const received: RendererListener = (_event, ...args) => {
    if (args.length !== 1) return
    const payload = args[0]
    if (!isWatcherRoomUpdate(payload)) {
      const room = trustedWatcherRoom.safeParse(payload)
      if (room.success) deliver(room.data)
      return
    }
    const next = applyWatcherRoomUpdate(held, payload)
    if (next === null || !trustedWatcherRoom.safeParse(next.room).success) { read(); return }
    if (payload.base === null) whole = true
    held = next
    deliver(next.room)
  }
  return listener => {
    if (!listeners.size) renderer.on(WATCHER_CHANGED, received)
    const own = (state: WatcherRoomState) => listener(state)
    listeners.add(own)
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      listeners.delete(own)
      if (!listeners.size) { renderer.removeListener(WATCHER_CHANGED, received); held = null }
    }
  }
}
