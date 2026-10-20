import { useCallback, useEffect, useRef, useState } from 'react'

import { canonicalChord, chordFromKeyboardEvent, keyTokenFromCode } from '../../../../shared/dictationShortcuts'
import type { SottoPlatform } from '../../../../shared/platform'


const NEVER_IN_CHORD: ReadonlySet<string> = new Set(['Fn', 'FnLock', 'CapsLock', 'NumLock', 'ScrollLock'])

/**
 * A recording's end: the canonical chord, null when cancelled, `unsupported-key` for a key no shortcut can use, or on
 * Linux `taken-press` / `taken-hold` when Hyprland ran one of Sotto's own bindings instead of passing the keys on.
 */
export type RecordedChord = string | null | 'unsupported-key' | 'taken-press' | 'taken-hold'

export interface ChordRecorder {
  /** The keys down right now while recording; empty before the first press. */
  readonly held: readonly string[]
  readonly recording: boolean
  record(): Promise<RecordedChord>
  cancel(): void
}

/**
 * Records one chord. With `listener` (Owl, macOS) main's key listener records, so Fn shows up;
 * otherwise the window's own key events do, with every dictation shortcut suspended meanwhile so
 * pressing the current one does not start dictation.
 */
export function useChordRecorder(platform: SottoPlatform, listener: boolean): ChordRecorder {
  const [held, setHeld] = useState<readonly string[]>([])
  const [recording, setRecording] = useState(false)
  const cancelRef = useRef<(() => void) | null>(null)

  const cancel = useCallback(() => cancelRef.current?.(), [])
  useEffect(() => cancel, [cancel])

  const record = useCallback((): Promise<RecordedChord> => {
    cancelRef.current?.()
    const bridge = window.sotto
    setHeld([])
    setRecording(true)
    return new Promise<RecordedChord>((resolve) => {
      const teardown: (() => void)[] = []
      let finished = false
      const finish = (chord: RecordedChord): void => {
        if (finished) return
        finished = true
        cancelRef.current = null
        for (const undo of teardown.splice(0)) undo()
        setHeld([])
        setRecording(false)
        resolve(chord)
      }
      const listen = <K extends keyof WindowEventMap>(type: K, handler: (event: WindowEventMap[K]) => void): void => {
        window.addEventListener(type, handler, true)
        teardown.push(() => window.removeEventListener(type, handler, true))
      }
      const swallow = (event: Event): void => {
        event.preventDefault()
        event.stopPropagation()
      }
      // Any press outside the window's keys ends the recording, the cancel control included.
      listen('pointerdown', () => cancelRef.current?.())
      // Enter or Space on the focused cancel control cancels instead of being recorded.
      const cancelKey = (event: KeyboardEvent, keysDown: number): boolean =>
        keysDown === 0 && (event.key === 'Enter' || event.key === ' ' || event.code === 'Space')
        && event.target instanceof Element && event.target.closest('[data-recording-cancel]') !== null

      const recordInWindow = (): void => {
        void bridge?.suspendDictationShortcuts?.(true).catch(() => undefined)
        teardown.push(() => void bridge?.suspendDictationShortcuts?.(false).catch(() => undefined))
        let keys: string[] = []
        // Main gives shortcuts back after 60 s whatever happens; give up first.
        const timeout = setTimeout(() => finish(null), 30_000)
        teardown.push(() => clearTimeout(timeout))
        listen('keydown', (event) => {
          swallow(event)
          if (event.repeat) return
          if ((event.code === 'Escape' && keys.length === 0) || cancelKey(event, keys.length)) return finish(null)
          // Fn and the lock keys are never part of a chord here (Fn reaches only main); holding Fn for F5 must still work.
          if (event.key === 'Fn' || NEVER_IN_CHORD.has(event.code)) return
          // Refuse rather than drop it, so the modifiers held with it are never saved alone.
          if (keyTokenFromCode(event.code, event.key, platform) === null) return finish('unsupported-key')
          keys = chordFromKeyboardEvent(event, keys, platform)
          setHeld(keys)
        })
        listen('keyup', (event) => {
          swallow(event)
          if (event.key === 'Fn' || NEVER_IN_CHORD.has(event.code)) return
          if (keys.length > 0) finish(canonicalChord(keys, platform))
        })
        // Capturing on window also hears every element's blur; only the window losing focus cancels.
        listen('blur', (event) => { if (!(event.target instanceof Node)) finish(null) })
        // Linux: Hyprland keeps a bound chord from the page. When it was one of Sotto's own, main says whose.
        teardown.push(bridge?.onDictationKeysTaken?.((role) => finish(role === 'press' ? 'taken-press' : 'taken-hold')) ?? (() => undefined))
      }

      cancelRef.current = () => finish(null)
      if (!listener || bridge?.recordDictationKeys === undefined) {
        recordInWindow()
        return
      }
      // Main hears the keys; the window's copies must not move focus or press buttons meanwhile.
      // Space or Enter cancels only on its own: with a modifier or Fn held (Fn reaches only main) it is part of the chord.
      let heldByMain: readonly string[] = []
      listen('keydown', (event) => {
        swallow(event)
        const held = heldByMain.length + Number(event.ctrlKey) + Number(event.altKey) + Number(event.shiftKey) + Number(event.metaKey)
        if (cancelKey(event, held)) cancelRef.current?.()
      })
      listen('keyup', swallow)
      teardown.push(bridge.onDictationKeysHeld?.((tokens) => {
        heldByMain = tokens
        setHeld([...tokens])
      }) ?? (() => undefined))
      cancelRef.current = () => {
        void bridge.cancelDictationKeyRecord?.().catch(() => undefined)
        finish(null)
      }
      void bridge.recordDictationKeys().catch(() => ({ kind: 'unavailable' as const })).then((result) => {
        if (finished) return
        if (result.kind === 'recorded') finish(result.chord)
        else if (result.kind === 'cancelled') finish(null)
        else if (result.kind === 'unsupported-key') finish('unsupported-key')
        else {
          cancelRef.current = () => finish(null)
          recordInWindow()
        }
      })
    })
  }, [listener, platform])

  return { held, recording, record, cancel }
}
