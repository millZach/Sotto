import { WATCHER_CHANGED, type WatcherBridge, type WatcherRoomChange } from '../shared/watcherRoom'
import { isWatcherRoomChange } from '../shared/watcherRoomChanges'

/** What this needs of Electron's `ipcRenderer`: the preload's own adapter, or the real one in the Electron room benchmark. */
export interface WatcherRoomRenderer {
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}
type RendererListener = (event: unknown, ...args: unknown[]) => void

/**
 * Each change to Watcher's room as main sent it, for the page (#1759). The context bridge copies everything that crosses
 * it, so handing the page the whole room on every update copied every receipt Watcher ever made, several times a second.
 * The page puts the room together on its own side (`watcherRoomChanges` in shared), and only the change crosses. What
 * could be neither a room nor an update never reaches the page. One listener on the channel serves every page listener.
 */
export function watcherRoomForwarding(renderer: WatcherRoomRenderer): WatcherBridge['onChanged'] {
  const listeners = new Set<(change: WatcherRoomChange) => void>()
  const received: RendererListener = (_event, ...args) => {
    if (args.length !== 1 || !isWatcherRoomChange(args[0])) return
    const change = args[0]
    for (const listener of [...listeners]) listener(change)
  }
  return listener => {
    if (!listeners.size) renderer.on(WATCHER_CHANGED, received)
    const own = (change: WatcherRoomChange) => listener(change)
    listeners.add(own)
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      listeners.delete(own)
      if (!listeners.size) renderer.removeListener(WATCHER_CHANGED, received)
    }
  }
}
