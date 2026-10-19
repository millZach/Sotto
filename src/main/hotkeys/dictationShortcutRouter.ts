import { acceleratorKey, acceleratorModifier } from '../../shared/accelerator'
import type {
  DictationCommand,
  DictationShortcutsResult,
  KeyListenerPermission,
  KeyRecordResult,
} from '../../shared/contracts'
import {
  canonicalChord,
  chordNeedsListener,
  chordTokens,
  validateChord,
  type ChordRefusal,
  type DictationShortcutSet,
} from '../../shared/dictationShortcuts'
import type { SottoPlatform } from '../../shared/platform'
import { createChordMatcher, type ChordMatcher, type MatcherChord } from './chordMatcher'
import type { GlobalShortcutAdapter } from './hotkeyManager'
import type { KeyListener, KeyListenerOptions } from './keyListener'

export type DictationShortcutEvent =
  | 'native-extra-shortcut-unavailable'
  | 'native-key-listener-gave-up'
  | 'native-key-listener-restarting'
  | 'native-key-listener-unavailable'
  | 'native-key-listener-not-ready'
  | 'native-key-listener-missing'

export type ApplyMode = 'strict' | 'lenient'

export type KeyListenerHandlers = Pick<KeyListenerOptions, 'onKey' | 'onReset' | 'onPermission' | 'onExit'>

export interface DictationShortcutRouterDependencies {
  readonly shortcuts: GlobalShortcutAdapter
  readonly createListener: (handlers: KeyListenerHandlers) => KeyListener
  readonly isIdle: () => boolean
  readonly dispatch: (command: DictationCommand) => void
  readonly showWidget: () => void
  readonly pushHeld: (tokens: readonly string[]) => void
  readonly pushPermission: (permission: KeyListenerPermission) => void
  readonly openInputMonitoring: () => void | Promise<void>
  readonly log: (event: DictationShortcutEvent) => void
  readonly platform: SottoPlatform
}

export interface DictationShortcutRouter {
  apply(set: DictationShortcutSet, mode: ApplyMode): DictationShortcutsResult
  suspend(on: boolean): void
  record(): Promise<KeyRecordResult>
  cancelRecord(): void
  permission(): KeyListenerPermission
  requestPermission(): Promise<KeyListenerPermission>
  /** The screen locked or the computer slept: cancel a hold this router started and forget every held key. */
  interrupt(): void
  /** The main press shortcut toggled dictation: a hold in progress no longer owns the session, so it ends silently. */
  pressToggled(): void
  dispose(): void
}

/** A chord's normalised token set (aliases resolved, case-folded, order-free). Chords compare by this, never by spelling. */
export function chordTokenSet(chord: string, platform: SottoPlatform): string {
  return [...new Set(chordTokens(chord).map((token) => (acceleratorModifier(token, platform) ?? acceleratorKey(token)).toLowerCase()))]
    .sort()
    .join('+')
}

const RELATIONAL: ReadonlySet<ChordRefusal> = new Set(['duplicate', 'overlap', 'lone-modifier'])
const SUSPEND_LIMIT_MS = 60_000
const RETRY_MS = 5_000
const RETRY_LIMIT = 12
const RECORD_LIMIT_MS = 30_000
// A recording waits this long for the helper's first permission line, then the page records instead.
const RECORD_READY_MS = 3_000
// The preload's held-keys schema accepts at most 8 tokens.
const MAX_HELD_PUSHED = 8

interface Recording {
  held: string[]
  // False until the helper is ready: keys before that are ignored and the 30 s limit has not started.
  ready: boolean
  timer: ReturnType<typeof setTimeout>
  readonly resolve: (result: KeyRecordResult) => void
}

export function createDictationShortcutRouter(deps: DictationShortcutRouterDependencies): DictationShortcutRouter {
  const { platform, shortcuts } = deps
  const aliased = (chord: string): string[] =>
    chordTokens(chord).map((token) => acceleratorModifier(token, platform) ?? acceleratorKey(token))
  const normalise = (chord: string): string | null => canonicalChord(aliased(chord), platform)
  const tokenSet = (chord: string): string => chordTokenSet(chord, platform)

  let registered: string[] = []
  // Extras a restore could not re-register; retried every 5 s, never counted as registered.
  let pending: string[] = []
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  // Token sets of the last applied set: strict apply re-validates only chords not in it.
  let saved = new Set<string>()
  let matcher: ChordMatcher = createChordMatcher([], () => undefined, { isIdle: deps.isIdle })
  let suspended = false
  let suspendTimer: ReturnType<typeof setTimeout> | undefined
  let recording: Recording | null = null
  let disposed = false

  // A press toggle takes the session over, so a hold in progress ends silently.
  const pressToggled = (): void => matcher.releaseHolds()

  const toggle = (): void => {
    pressToggled()
    deps.dispatch({ type: 'toggle' })
    deps.showWidget()
  }

  const register = (accelerator: string): boolean => {
    try {
      return shortcuts.register(accelerator, toggle)
    } catch {
      return false
    }
  }

  const unregister = (accelerator: string): void => {
    try {
      shortcuts.unregister(accelerator)
    } catch {
      // Native cleanup is best-effort.
    }
  }

  const listener = deps.createListener({
    onKey(type, token) {
      if (recording === null) matcher.key(type, token)
      else if (recording.ready) recordKey(type, token)
    },
    onReset: () => matcher.reset(),
    onPermission(state) {
      // Without Input Monitoring the tap sees nothing, so the page records instead.
      if (state === 'denied' && recording !== null) finishRecord({ kind: 'unavailable' })
      else if (recording !== null && !recording.ready) armRecording()
      deps.pushPermission(permission())
    },
    onExit() {
      matcher.reset()
      // The page can still record when the helper dies or never gets ready.
      if (recording !== null) finishRecord({ kind: 'unavailable' })
    },
  })

  const watchMatcher = (): void => {
    if (!suspended) listener.watch(matcher.watchedTokens())
  }

  // 'unsupported' means the listener cannot run here (no helper), never just "not macOS".
  function permission(): KeyListenerPermission {
    if (platform === 'linux') return 'unsupported'
    const state = listener.permission()
    if (state === 'unavailable') return 'unsupported'
    if (platform !== 'darwin') return 'not-needed'
    if (matcher.watchedTokens().length === 0 && recording === null) return 'not-needed'
    return state === 'unknown' ? 'not-needed' : state
  }

  function restorePending(attempt: number): void {
    retryTimer = undefined
    const failed = pending.filter((accelerator) => !register(accelerator))
    registered = [...registered, ...pending.filter((accelerator) => !failed.includes(accelerator))]
    pending = failed
    if (failed.length === 0) return
    if (attempt === 0) deps.log('native-extra-shortcut-unavailable')
    if (attempt < RETRY_LIMIT) retryTimer = setTimeout(() => restorePending(attempt + 1), RETRY_MS)
  }

  function suspend(on: boolean): void {
    if (disposed) return
    clearTimeout(suspendTimer)
    suspendTimer = on ? setTimeout(() => suspend(false), SUSPEND_LIMIT_MS) : undefined
    if (on === suspended) return
    suspended = on
    clearTimeout(retryTimer)
    if (on) {
      for (const accelerator of registered) unregister(accelerator)
      matcher.reset()
      if (recording === null) listener.watch([])
      return
    }
    pending = [...registered, ...pending]
    registered = []
    restorePending(0)
    watchMatcher()
  }

  function finishRecord(result: KeyRecordResult): void {
    const active = recording
    if (active === null) return
    recording = null
    clearTimeout(active.timer)
    listener.record(false)
    suspend(false)
    active.resolve(result)
  }

  function armRecording(): void {
    const active = recording!
    if (listener.permission() === 'denied') {
      finishRecord({ kind: 'unavailable' })
      return
    }
    active.ready = true
    clearTimeout(active.timer)
    active.timer = setTimeout(() => finishRecord({ kind: 'cancelled' }), RECORD_LIMIT_MS)
  }

  function recordKey(type: 'down' | 'up', token: string): void {
    const active = recording!
    // Keys outside the shortcut table can never be part of a chord.
    if (token === 'Other') return
    if (type === 'down') {
      if (token === 'Escape' && active.held.length === 0) {
        finishRecord({ kind: 'cancelled' })
        return
      }
      if (active.held.includes(token)) return
      active.held = [...active.held, token]
      deps.pushHeld(active.held.slice(0, MAX_HELD_PUSHED))
      return
    }
    if (!active.held.includes(token)) return
    const chord = canonicalChord(active.held, platform)
    finishRecord(chord === null ? { kind: 'cancelled' } : { kind: 'recorded', chord })
  }

  return {
    apply(set, mode) {
      if (disposed) return { ok: false, reason: 'unavailable' }
      const strict = mode === 'strict'
      if (strict) {
        for (const role of ['press', 'hold'] as const) {
          for (const [index, chord] of set[role].entries()) {
            const verdict = validateChord(chord, { role, index }, set, platform, { listener: true })
            // A chord already applied may be a legacy spelling: it answers only to the checks against the rest of the set.
            if (!verdict.ok && (!saved.has(tokenSet(chord)) || RELATIONAL.has(verdict.code))) {
              return { ok: false, reason: 'invalid', chord }
            }
          }
        }
      }
      const seen = new Set(set.press.length > 0 ? [tokenSet(set.press[0]!)] : [])
      const accelerators: string[] = []
      const chords: MatcherChord[] = []
      const entries = [
        ...set.press.slice(1).map((chord) => ({ chord: chord.trim(), role: 'press' as const })),
        ...set.hold.map((chord) => ({ chord: chord.trim(), role: 'hold' as const })),
      ]
      for (const [index, { chord, role }] of entries.entries()) {
        const key = tokenSet(chord)
        if (seen.has(key)) {
          if (strict) return { ok: false, reason: 'invalid', chord }
          deps.log('native-extra-shortcut-unavailable')
          continue
        }
        seen.add(key)
        const canonical = normalise(chord)
        if (role === 'press' && !chordNeedsListener(chord, role)) {
          accelerators.push(canonical ?? chord)
        } else if (canonical === null) {
          if (strict) return { ok: false, reason: 'invalid', chord }
          deps.log('native-extra-shortcut-unavailable')
        } else {
          chords.push({ id: `${role}-${index}`, chord: canonical, role })
        }
      }

      // Register the new accelerators before releasing the old, so a refusal leaves the old set working.
      const fresh: string[] = []
      const kept: string[] = []
      for (const accelerator of accelerators) {
        if (registered.includes(accelerator) && !suspended) {
          kept.push(accelerator)
        } else if (register(accelerator)) {
          fresh.push(accelerator)
          kept.push(accelerator)
        } else if (strict) {
          for (const added of fresh) unregister(added)
          return { ok: false, reason: 'conflict', chord: accelerator }
        } else {
          deps.log('native-extra-shortcut-unavailable')
        }
      }
      if (!suspended) for (const old of registered) if (!kept.includes(old)) unregister(old)
      registered = kept
      clearTimeout(retryTimer)
      pending = []
      saved = new Set([...set.press, ...set.hold].map(tokenSet))

      // A new set ends any suspension; the old matcher's reset cancels a hold in progress.
      clearTimeout(suspendTimer)
      suspended = false
      matcher.reset()
      matcher = createChordMatcher(chords, (event) => {
        if (disposed) return
        if (event.type === 'toggle') pressToggled()
        if (event.type === 'start' || event.type === 'toggle') {
          deps.dispatch({ type: event.type })
          deps.showWidget()
        } else {
          deps.dispatch({ type: event.type })
        }
      }, { isIdle: deps.isIdle })
      if (recording === null) watchMatcher()
      else listener.watch(matcher.watchedTokens())
      return { ok: true }
    },

    suspend,

    record() {
      if (disposed) return Promise.resolve({ kind: 'unavailable' })
      finishRecord({ kind: 'cancelled' })
      return new Promise<KeyRecordResult>((resolve) => {
        recording = {
          held: [],
          ready: false,
          resolve,
          timer: setTimeout(() => finishRecord({ kind: 'unavailable' }), RECORD_READY_MS),
        }
        suspend(true)
        listener.record(true)
        if (!listener.running()) finishRecord({ kind: 'unavailable' })
        else if (listener.ready()) armRecording()
      })
    },

    cancelRecord() {
      finishRecord({ kind: 'cancelled' })
    },

    permission,

    // The old matcher's reset cancels a hold this router started.
    interrupt() {
      matcher.reset()
    },

    pressToggled,

    async requestPermission() {
      listener.request()
      await deps.openInputMonitoring()
      return permission()
    },

    dispose() {
      if (disposed) return
      finishRecord({ kind: 'cancelled' })
      disposed = true
      clearTimeout(suspendTimer)
      clearTimeout(retryTimer)
      matcher.reset()
      for (const accelerator of registered) unregister(accelerator)
      registered = []
      listener.dispose()
    },
  }
}
