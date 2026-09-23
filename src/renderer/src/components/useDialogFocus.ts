import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'

/**
 * What every dialog here does with focus: the first control takes it on open, Tab stays inside, Escape
 * answers `onEscape`, and on close focus goes back to where it was, or to `fallbackFocus` when that place is
 * gone, unless another control has already taken it (a dialog that hands over to the next one). Returns the
 * ref to put on the dialog element.
 */
export function useDialogFocus({ onEscape, initialFocus, fallbackFocus }: {
  readonly onEscape: () => void
  readonly initialFocus: RefObject<HTMLElement | null>
  readonly fallbackFocus?: RefObject<HTMLElement | null> | undefined
}): RefObject<HTMLElement | null> {
  const dialog = useRef<HTMLElement>(null)
  const escape = useRef(onEscape)
  escape.current = onEscape
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    initialFocus.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); escape.current(); return }
      if (event.key !== 'Tab') return
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      if (focusable.length === 0) return
      const first = focusable[0]!, last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      queueMicrotask(() => {
        const active = document.activeElement
        if (active && active !== document.body && active.isConnected) return
        if (previous?.isConnected) previous.focus()
        else fallbackFocus?.current?.focus()
      })
    }
  }, [initialFocus, fallbackFocus])
  return dialog
}
