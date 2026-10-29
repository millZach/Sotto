import { useSyncExternalStore } from 'react'

/**
 * The tips the user hid or used (ADR-0159), kept on this computer the way a dismissed notice is. A tip set aside never
 * shows again until Settings › Threads › Show hidden tips again clears the list. Ids only; never what a tip said.
 */
const SET_ASIDE_KEY = 'sotto.tips.setAside'
/** Where each rotation stands (`sotto.tips.next.thread:claude`), so the next turn shows the next tip even after Sotto restarts. */
const ROTATION_KEY = 'sotto.tips.next'

export interface TipsSetAsideStore {
  readonly ids: () => ReadonlySet<string>
  readonly setAside: (id: string) => void
  readonly clear: () => void
  /** The named rotation's next place, moved on by one. */
  readonly nextRotation: (rotation: string) => number
  readonly subscribe: (listener: () => void) => () => void
}

export function createTipsSetAsideStore(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined): TipsSetAsideStore {
  const listeners = new Set<() => void>()
  const read = (): ReadonlySet<string> => {
    try {
      const parsed: unknown = JSON.parse(storage?.getItem(SET_ASIDE_KEY) ?? '[]')
      return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
    } catch { return new Set() }
  }
  let ids = read()
  const write = (next: ReadonlySet<string>): void => {
    ids = next
    try {
      if (next.size) storage?.setItem(SET_ASIDE_KEY, JSON.stringify([...next]))
      else storage?.removeItem(SET_ASIDE_KEY)
    } catch { /* Storage refused: the tip stays hidden until Sotto restarts, which loses nothing. */ }
    for (const listener of listeners) listener()
  }
  return {
    ids: () => ids,
    setAside: id => {
      if (ids.has(id)) return
      // Never trimmed: a tip set aside stays aside until the user asks for them back, and the list grows only by presses.
      write(new Set([...ids, id]))
    },
    clear: () => { if (ids.size) write(new Set()) },
    nextRotation: rotation => {
      const key = `${ROTATION_KEY}.${rotation}`
      let at = 0
      try { at = Number.parseInt(storage?.getItem(key) ?? '0', 10) || 0 } catch { /* starts from the first tip */ }
      try { storage?.setItem(key, String((at + 1) % 1_000_000)) } catch { /* the next turn repeats the rotation's place */ }
      return at
    },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

/** The window's own. */
export const tipsSetAside: TipsSetAsideStore = createTipsSetAsideStore(globalThis.localStorage)

export function useTipsSetAside(store: TipsSetAsideStore = tipsSetAside): ReadonlySet<string> {
  return useSyncExternalStore(store.subscribe, store.ids)
}
