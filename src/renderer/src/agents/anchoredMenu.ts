import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Opens `dialog` as a modal menu anchored over `trigger` while `open`, focuses `focus` in it, and returns focus to the
 * trigger when it closes. The model picker and the Providers page's model list share it.
 *
 * Anchored over the trigger, below it only when there is room, and kept inside the window as it resizes. Where it fits
 * on neither side, as in a small window with the composer mid-way down, it takes the roomier side and is shortened to
 * fit there, so it never covers the trigger it came from. Once open it keeps its side and holds the trigger's edge: a
 * menu above its trigger keeps its foot there and grows and shrinks upward, one below keeps its head there and grows
 * downward. It changes sides only when it no longer fits on its own. A step of the menu can be taller or shorter than
 * the last (a provider's model sources, then one source's models), so each draw places it again before it shows.
 */
export function useAnchoredMenu(open: boolean, trigger: RefObject<HTMLElement | null>, dialog: RefObject<HTMLDialogElement | null>, focus: RefObject<HTMLElement | null>): void {
  const placeMenu = useRef<(() => void) | undefined>(undefined)
  useLayoutEffect(() => {
    if (!open) return
    const element = dialog.current
    if (!element) return
    element.showModal?.()
    if (!element.open) element.setAttribute('open', '')
    let side: 'below' | 'above' | undefined
    const place = (): void => {
      const anchor = trigger.current?.getBoundingClientRect()
      if (!anchor) return
      element.style.maxHeight = ''
      const width = element.offsetWidth || 336
      const natural = element.offsetHeight || 360
      const room = { below: innerHeight - anchor.bottom - 22, above: anchor.top - 22 }
      if (!side || natural > room[side]) side = natural <= room.below ? 'below' : natural <= room.above ? 'above' : room.below > room.above ? 'below' : 'above'
      const fit = Math.max(room[side], 160)
      if (natural > fit) element.style.maxHeight = `${fit}px`
      const height = Math.min(natural, fit)
      const top = Math.max(16, Math.min(side === 'below' ? anchor.bottom + 6 : anchor.top - height - 6, innerHeight - height - 16))
      element.style.left = `${Math.max(16, Math.min(anchor.left, innerWidth - width - 16))}px`
      // The edge against the trigger is the one set, so the menu's own height moves only its far edge. The other is set
      // to auto, since a modal dialog's own style pins both to the window.
      element.style.top = side === 'below' ? `${top}px` : 'auto'
      element.style.bottom = side === 'above' ? `${innerHeight - top - height}px` : 'auto'
    }
    place()
    placeMenu.current = place
    addEventListener('resize', place)
    focus.current?.focus()
    return () => { removeEventListener('resize', place); placeMenu.current = undefined; element.close?.(); trigger.current?.focus() }
  }, [open, trigger, dialog, focus])
  useLayoutEffect(() => { placeMenu.current?.() })
}
