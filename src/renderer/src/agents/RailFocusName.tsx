import React, { useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Beside the control, after its end (the rail's tiles), under it (the pane header's symbols) or over it (the sidebar's foot). */
type Side = 'end' | 'below' | 'above'

interface Shown { readonly text: string; readonly left: number; readonly top: number; readonly control: HTMLElement; readonly side: Side; readonly by?: 'pointer' | undefined }

const place = (control: HTMLElement, text: string, side: Side): Shown => {
  const box = control.getBoundingClientRect()
  return side === 'end'
    ? { text, left: box.right + 8, top: box.top + box.height / 2, control, side }
    : side === 'above'
      // Over the foot the name starts at its control's left edge, so the first tile's stays inside the window.
      ? { text, left: box.left, top: box.top - 6, control, side }
      : { text, left: box.left + box.width / 2, top: box.bottom + 6, control, side }
}

export interface FocusName {
  readonly onFocus: (event: FocusEvent<HTMLElement>) => void
  readonly onBlur: (event: FocusEvent<HTMLElement>) => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  /** Where the name shows under the pointer too: a resting pointer shows the same name, at once once one is up. */
  readonly onPointerOver?: ((event: PointerEvent<HTMLElement>) => void) | undefined
  readonly onPointerOut?: ((event: PointerEvent<HTMLElement>) => void) | undefined
  readonly name: ReactNode
}

/** How long the pointer rests on a control before its name shows; moving on to the next one shows its name at once. */
const POINTER_REST_MS = 300
/** Where a control keeps its title while its name shows under the pointer, so the system's own tooltip does not show as well. */
const KEPT_TITLE = 'data-focus-name-title'
const titleOf = (control: HTMLElement): string | null => control.getAttribute('title') ?? control.getAttribute(KEPT_TITLE)
/** Gives a control back the title its name was read from, unless it has a new one already. */
function giveBackTitle(control: HTMLElement): void {
  const kept = control.getAttribute(KEPT_TITLE)
  if (kept === null) return
  control.removeAttribute(KEPT_TITLE)
  if (!control.hasAttribute('title')) control.setAttribute('title', kept)
}

/**
 * A symbol says its name to the pointer in its tooltip, but the keyboard has no tooltip: walking the collapsed rail showed
 * "Vg", "Mt", "Sw" (ADR-0146's two letters), and walking a pane header showed a landmark and two panels. While such a
 * control holds the keyboard's focus this names it in the tooltip's own words, beside the rail or under the header, so it
 * reads from the keys as it does under the pointer. It is for the eye only: the control's accessible name already says it.
 * A press or the focus moving on puts it away. `accepts` says which controls in the region are named this way.
 */
function useFocusName(accepts: (control: HTMLElement) => boolean, sideOf: (control: HTMLElement) => Side, pointer = false): FocusName {
  const [shown, setShown] = useState<Shown | null>(null)
  const onFocus = useCallback((event: FocusEvent<HTMLElement>): void => {
    const control = event.target
    const text = titleOf(control)
    if (!text || !accepts(control) || !control.matches(':focus-visible')) { setShown(current => current?.by === 'pointer' ? current : null); return }
    setShown(place(control, text, sideOf(control)))
  }, [accepts, sideOf])
  const onBlur = useCallback((): void => setShown(current => current?.by === 'pointer' ? current : null), [])
  // Under the pointer (`pointer`): the control's own title, shown in the same place and words once the pointer rests, and
  // kept from the control meanwhile so the system's tooltip does not show beside it.
  const resting = useRef<{ readonly control: HTMLElement; readonly timer: number } | null>(null)
  const pointed = useRef<HTMLElement | null>(null)
  const leave = useCallback((): void => {
    if (resting.current !== null) { window.clearTimeout(resting.current.timer); resting.current = null }
    if (pointed.current !== null) { giveBackTitle(pointed.current); pointed.current = null }
    setShown(current => current?.by === 'pointer' ? null : current)
  }, [])
  const onPointerOver = useCallback((event: PointerEvent<HTMLElement>): void => {
    if (event.pointerType === 'touch') return
    const control = (event.target as Element).closest<HTMLElement>('button, a')
    if (control === null || !event.currentTarget.contains(control) || !accepts(control) || control === pointed.current || control === resting.current?.control) return
    const text = titleOf(control)
    if (!text) return
    const showing = pointed.current !== null
    leave()
    const show = (): void => {
      resting.current = null
      if (!control.isConnected) return
      const title = control.getAttribute('title')
      if (title !== null) { control.setAttribute(KEPT_TITLE, title); control.removeAttribute('title') }
      pointed.current = control
      setShown({ ...place(control, titleOf(control) ?? text, sideOf(control)), by: 'pointer' })
    }
    if (showing) show()
    else resting.current = { control, timer: window.setTimeout(show, POINTER_REST_MS) }
  }, [accepts, sideOf, leave])
  const onPointerOut = useCallback((event: PointerEvent<HTMLElement>): void => {
    const to = event.relatedTarget instanceof Node ? event.relatedTarget : null
    const on = pointed.current ?? resting.current?.control ?? null
    if (on !== null && to !== null && on.contains(to)) return
    leave()
  }, [leave])
  useEffect(() => leave, [leave])
  // Enter or Space opens what the control opens where the name stands, and Escape puts the name away.
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape' || event.key === 'F10' || event.key === 'ContextMenu') setShown(null)
  }, [])
  const showing = shown !== null
  useEffect(() => {
    if (!showing) return
    const hide = (): void => { if (pointed.current !== null) { giveBackTitle(pointed.current); pointed.current = null } setShown(null) }
    // A tile the keys reach off the rail's edge scrolls into view, so the name follows its control rather than leaving.
    const follow = (): void => setShown(current => current === null || !current.control.isConnected || (current.by !== 'pointer' && document.activeElement !== current.control) ? null
      : { ...place(current.control, current.text, current.side), by: current.by })
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
  return { onFocus, onBlur, onKeyDown, ...pointer ? { onPointerOver, onPointerOut } : {}, name }
}

const railTile = (control: HTMLElement): boolean => control.classList.contains('thread-nav__rail-thread')
const toEnd = (): Side => 'end'
const toBelow = (): Side => 'below'

/** The collapsed rail's tiles, named beside the rail. */
export function useRailFocusName(): FocusName {
  return useFocusName(railTile, toEnd)
}

/** Whether a worded press shows its words, or only its symbol in a narrow pane. */
const wordShown = (control: HTMLElement, words: string): boolean => {
  const word = control.querySelector<HTMLElement>(words)
  return word !== null && word.getBoundingClientRect().width > 1
}

// The header's symbols: the Council, Tools, the Terminal drawer, the ··· menu and close, and in a narrow pane Watch's owl
// and the Git action's mark once their words have gone. A press showing its words needs no name, and an open menu says its own.
const headerSymbol = (control: HTMLElement): boolean => control.getAttribute('aria-expanded') !== 'true'
  && (control.classList.contains('pane-action')
    || (control.classList.contains('watch-toggle') && !wordShown(control, '.watch-toggle__text'))
    || (control.classList.contains('git-action__quick') && !wordShown(control, '.git-action__label')))

/** A pane header's symbols, named under the header. */
export function useHeaderFocusName(): FocusName {
  return useFocusName(headerSymbol, toBelow)
}

// The sidebar foot's icons: the room switch's tiles, the page links and the update control. On the collapsed rail the foot
// stands upright, so they are named beside it as the rail's tiles are; in the open sidebar, over the row.
const footControl = (control: HTMLElement): boolean => control.matches('.thread-nav__seg [role="tab"], .thread-nav__page, .update-control')
const footSide = (control: HTMLElement): Side => control.closest('.thread-nav__rail') !== null ? 'end' : control.closest('.watcher-head') !== null ? 'below' : 'above'

/**
 * The way off the page's icons, named over the sidebar's foot, beside it on the collapsed rail and under Watcher's header,
 * for the keys and for a resting pointer alike: each icon's name and its shortcut (the owner's ask on November 6, 2026).
 */
export function useFootFocusName(): FocusName {
  return useFocusName(footControl, footSide, true)
}
