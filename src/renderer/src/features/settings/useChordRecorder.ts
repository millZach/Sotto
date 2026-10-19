import { useCallback, useEffect, useRef, useState } from 'react'

import { canonicalChord, chordFromKeyboardEvent } from '../../../../shared/dictationShortcuts'
import type { SottoPlatform } from '../../../../shared/platform'

export interface ChordRecorder {
  /** The keys down right now while recording; empty before the first press. */
  readonly held: readonly string[]
  readonly recording: boolean
  /** Resolves with the canonical chord, or null when the recording was cancelled. */
  record(): Promise<string | null>
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

  const record = useCallback((): Promise<string | null> => {
    cancelRef.current?.()
    const bridge = window.sotto
    setHeld([])
    setRecording(true)
    return new Promise<string | null>((resolve) => {
      const teardown: (() => void)[] = []
      let finished = false
      const finish = (chord: string | null): void => {
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
          keys = chordFromKeyboardEvent(event, keys, platform)
          setHeld(keys)
        })
        listen('keyup', (event) => {
          swallow(event)
          if (keys.length > 0) finish(canonicalChord(keys, platform))
        })
        // Capturing on window also hears every element's blur; only the window losing focus cancels.
        listen('blur', (event) => { if (!(event.target instanceof Node)) finish(null) })
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
        else {
          cancelRef.current = () => finish(null)
          recordInWindow()
        }
      })
    })
  }, [listener, platform])

  return { held, recording, record, cancel }
}
