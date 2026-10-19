import type { KeyRecordResult } from '../../shared/contracts'
import type { DictationShortcutRouter } from './dictationShortcutRouter'

/** Electron's powerMonitor, as far as lost key-ups need it. */
export interface LockAndSleepSource {
  on(event: 'lock-screen', listener: () => void): unknown
  on(event: 'suspend', listener: () => void): unknown
}

export interface DictationShortcutLifecycle {
  /** Stands every dictation shortcut down, or back up; a suspension ends on its own after the limit. */
  suspend(suspended: boolean): void
  /** Records one chord with every shortcut stood down. A later call wins: an earlier one's end never resumes the shortcuts. */
  record(): Promise<KeyRecordResult>
  /** The main renderer reloaded or crashed: its recording can no longer end, so the shortcuts come back now. */
  rendererGone(): void
}

export function createDictationShortcutLifecycle(deps: {
  /** The primary hotkey and the router together. */
  suspend: (suspended: boolean) => void
  router: Pick<DictationShortcutRouter, 'record' | 'cancelRecord'> | null
  limitMs?: number
}): DictationShortcutLifecycle {
  let timer: ReturnType<typeof setTimeout> | undefined
  // Each record() and each forced resume takes a new generation; only the current recording may resume the shortcuts.
  let generation = 0
  const suspend = (suspended: boolean): void => {
    clearTimeout(timer)
    deps.suspend(suspended)
    if (suspended) timer = setTimeout(() => suspend(false), deps.limitMs ?? 60_000)
  }
  return {
    suspend,
    async record() {
      if (deps.router === null) return { kind: 'unavailable' }
      const mine = ++generation
      suspend(true)
      try { return await deps.router.record() } finally { if (mine === generation) suspend(false) }
    },
    rendererGone() {
      generation += 1
      deps.router?.cancelRecord()
      suspend(false)
    },
  }
}

/** A locked screen or a sleep can swallow key-ups, so the router forgets every held key. */
export function interruptOnLockAndSleep(source: LockAndSleepSource, interrupt: () => void): void {
  source.on('lock-screen', interrupt)
  source.on('suspend', interrupt)
}
