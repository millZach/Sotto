import { useSyncExternalStore } from 'react'

/**
 * The tips the user hid or used (ADR-0159), kept on this computer the way a dismissed notice is. A tip set aside never
 * shows again until Settings › Threads › Show hidden tips again clears them. Ids only; never what a tip said. Each id is
 * its own storage entry (`sotto.tips.setAside.<id>`), so setting one aside writes one entry however many came before.
 */
const SET_ASIDE_PREFIX = 'sotto.tips.setAside.'
/** Where each rotation stands (`sotto.tips.next.thread:claude`), so the next turn shows the next tip even after Sotto restarts. */
const ROTATION_KEY = 'sotto.tips.next'

/** The tips set aside, as a working line asks: whether one is, and how many. */
export type TipsSetAside = Pick<ReadonlySet<string>, 'has' | 'size'>

export interface TipsSetAsideStore {
  /** A new value after every change, so a reader knows to look again; the ids themselves are never copied. */
  readonly ids: () => TipsSetAside
  readonly setAside: (id: string) => void
  readonly clear: () => void
  /** The named rotation's next place, moved on by one. */
  readonly nextRotation: (rotation: string) => number
  readonly subscribe: (listener: () => void) => () => void
}

type TipStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

export function createTipsSetAsideStore(storage: TipStorage | undefined): TipsSetAsideStore {
  const listeners = new Set<() => void>()
  const ids = new Set<string>()
  try {
    for (let index = 0; index < (storage?.length ?? 0); index++) {
      const key = storage!.key(index)
      if (key?.startsWith(SET_ASIDE_PREFIX)) ids.add(key.slice(SET_ASIDE_PREFIX.length))
    }
  } catch { /* Storage refused: nothing is set aside this run, which loses nothing. */ }
  const view = (): TipsSetAside => ({ has: id => ids.has(id), size: ids.size })
  let snapshot = view()
  const changed = (): void => {
    snapshot = view()
    for (const listener of listeners) listener()
  }
  return {
    ids: () => snapshot,
    setAside: id => {
      if (ids.has(id)) return
      // Never trimmed: a tip set aside stays aside until the user asks for them back.
      ids.add(id)
      try { storage?.setItem(`${SET_ASIDE_PREFIX}${id}`, '1') } catch { /* the tip stays hidden until Sotto restarts */ }
      changed()
    },
    // Show hidden tips again is a press about the whole list, so it goes through the whole list.
    clear: () => {
      if (!ids.size) return
      for (const id of ids) try { storage?.removeItem(`${SET_ASIDE_PREFIX}${id}`) } catch { /* comes back hidden next run */ }
      ids.clear()
      changed()
    },
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

export function useTipsSetAside(store: TipsSetAsideStore = tipsSetAside): TipsSetAside {
  return useSyncExternalStore(store.subscribe, store.ids)
}
