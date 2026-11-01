import { useSyncExternalStore } from 'react'

/**
 * The microphone's level while dictating, about every 33 ms, for the one meter that shows it: the Dictate room's wave,
 * which also gives screen readers its value. It is kept out of the app's state so a level redraws that meter alone
 * rather than the whole window (#993); the rest of the window hears only whether a voice is heard (`speaking`).
 */
export interface LiveLevel {
  readonly get: () => number
  readonly subscribe: (listener: () => void) => () => void
}

export class LiveLevelStore implements LiveLevel {
  private level = 0
  private readonly listeners = new Set<() => void>()
  readonly get = (): number => this.level
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  set(level: number): void {
    if (level === this.level) return
    this.level = level
    for (const listener of [...this.listeners]) listener()
  }
}

/** A level that never moves, where no dictation reports one. */
export const SILENT_LEVEL: LiveLevel = { get: () => 0, subscribe: () => () => undefined }

export function useLiveLevel(source: LiveLevel): number {
  return useSyncExternalStore(source.subscribe, source.get)
}
