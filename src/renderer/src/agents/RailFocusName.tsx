import React, { useCallback, useEffect, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Beside the control, after its end (the rail's tiles), or under it (the pane header's symbols). */
type Side = 'end' | 'below'

interface Shown { readonly text: string; readonly left: number; readonly top: number; readonly control: HTMLElement; readonly side: Side }

const place = (control: HTMLElement, text: string, side: Side): Shown => {
  const box = control.getBoundingClientRect()
  return side === 'end'
    ? { text, left: box.right + 8, top: box.top + box.height / 2, control, side }
    : { text, left: box.left + box.width / 2, top: box.bottom + 6, control, side }
}

export interface FocusName {
  readonly onFocus: (event: FocusEvent<HTMLElement>) => void
  readonly onBlur: (event: FocusEvent<HTMLElement>) => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  readonly name: ReactNode
}

/**
 * A symbol says its name to the pointer in its tooltip, but the keyboard has no tooltip: walking the collapsed rail showed
 * "Vg", "Mt", "Sw" (ADR-0146's two letters), and walking a pane header showed a landmark and two panels. While such a
 * control holds the keyboard's focus this names it in the tooltip's own words, beside the rail or under the header, so it
 * reads from the keys as it does under the pointer. It is for the eye only: the control's accessible name already says it.
 * A press or the focus moving on puts it away. `accepts` says which controls in the region are named this way.
 */
function useFocusName(accepts: (control: HTMLElement) => boolean, side: Side): FocusName {
  const [shown, setShown] = useState<Shown | null>(null)
  const onFocus = useCallback((event: FocusEvent<HTMLElement>): void => {
    const control = event.target
    const text = control.getAttribute('title')
    if (!text || !accepts(control) || !control.matches(':focus-visible')) { setShown(null); return }
    setShown(place(control, text, side))
  }, [accepts, side])
  const onBlur = useCallback((): void => setShown(null), [])
  // Enter or Space opens what the control opens where the name stands, and Escape puts the name away.
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape' || event.key === 'F10' || event.key === 'ContextMenu') setShown(null)
  }, [])
  const showing = shown !== null
  useEffect(() => {
    if (!showing) return
    const hide = (): void => setShown(null)
    // A tile the keys reach off the rail's edge scrolls into view, so the name follows its control rather than leaving.
    const follow = (): void => setShown(current => current === null || !current.control.isConnected || document.activeElement !== current.control ? null : place(current.control, current.text, current.side))
    window.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    window.addEventListener('pointerdown', hide, true)
    return () => { window.removeEventListener('scroll', follow, true); window.removeEventListener('resize', follow); window.removeEventListener('pointerdown', hide, true) }
  }, [showing])
  // A rail tile's tooltip is the title, then what the thread is doing, parted by " · ": the title leads on its own line.
  const [title, ...facts] = shown?.text.split(' · ') ?? []
  const name = shown === null ? null : createPortal(<div className="focus-name" data-side={shown.side} aria-hidden="true" style={{ left: shown.left, top: shown.top }}>
    <strong>{title}</strong>{facts.length ? <span>{facts.join(' · ')}</span> : null}
  </div>, document.body)
  return { onFocus, onBlur, onKeyDown, name }
}

const railTile = (control: HTMLElement): boolean => control.classList.contains('thread-nav__rail-thread')

/** The collapsed rail's tiles, named beside the rail. */
export function useRailFocusName(): FocusName {
  return useFocusName(railTile, 'end')
}

// The header's symbols: the Council, Tools, the Terminal drawer, the ··· menu and close. Watch and the Git action say
// their words already, and an open menu says its own.
const headerSymbol = (control: HTMLElement): boolean => control.classList.contains('pane-action') && control.getAttribute('aria-expanded') !== 'true'

/** A pane header's symbols, named under the header. */
export function useHeaderFocusName(): FocusName {
  return useFocusName(headerSymbol, 'below')
}
