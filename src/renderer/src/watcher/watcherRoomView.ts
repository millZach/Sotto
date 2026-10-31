import { browserStorage } from '../agents/splitLayout'

/** Watcher only splits into columns; its width belongs to the room, not the thread opened beside it. */
export const WATCHER_SHARE_STORAGE_KEY = 'sotto.watcher.split.columns'

export interface RoomView { readonly besideId: string | null; readonly share: number }

/** The beside thread lasts for this window; the divider's share also survives a restart. */
export class RoomViewStore {
  private view: RoomView | null = null
  private readonly listeners = new Set<() => void>()

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = null) {}

  readonly get = (): RoomView => {
    if (this.view === null) {
      let share = 0.5
      try {
        const text = this.storage?.getItem(WATCHER_SHARE_STORAGE_KEY)
        const stored: unknown = text == null ? null : JSON.parse(text)
        if (typeof stored === 'number' && Number.isFinite(stored) && stored > 0 && stored < 1) share = stored
      } catch { /* Unavailable storage or an unreadable share leaves the default. */ }
      this.view = { besideId: null, share }
    }
    return this.view
  }

  set(patch: Partial<RoomView>): void {
    const previous = this.get()
    this.view = { ...previous, ...patch }
    if (this.view.share !== previous.share) {
      try { this.storage?.setItem(WATCHER_SHARE_STORAGE_KEY, JSON.stringify(this.view.share)) }
      catch { /* The divider still holds for this window when storage is unavailable. */ }
    }
    for (const listener of [...this.listeners]) listener()
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

export const roomView = new RoomViewStore(browserStorage())
