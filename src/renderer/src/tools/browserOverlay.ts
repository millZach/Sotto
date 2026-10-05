import { useEffect, useState, type RefObject } from 'react'

/** Anything drawn above the page that a native view would cover. Native views composite over all DOM. */
const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], dialog[open], [data-covers-native-view]'

/**
 * Overlays that cover only what they overlap, rather than the whole page: the minimized theme editor bar (the
 * reader keeps it up while checking a theme against the page, so the page shows beside it), and the browser
 * and phone players (each one's own rectangle is exactly where it draws, so a page elsewhere on screen steps aside
 * only if a player is actually sitting over it, not merely open).
 */
const COVERS_WHERE_IT_OVERLAPS = '[data-theme-editor-panel][data-minimized], .browser-player, .phone-player__label, .phone-player__phone, .phone-player__status'

/** Whether `element` reaches a pixel of the native page, which main draws at `viewport`'s rounded rectangle. */
function overlapsPage(element: HTMLElement, viewport: HTMLElement | null): boolean {
  if (!viewport) return true
  const box = element.getBoundingClientRect()
  const page = viewport.getBoundingClientRect()
  return Math.floor(box.left) < Math.round(page.right) && Math.ceil(box.right) > Math.round(page.left)
    && Math.floor(box.top) < Math.round(page.bottom) && Math.ceil(box.bottom) > Math.round(page.top)
}

/**
 * True while an overlay outside `inside` covers the page at `viewport`, so the native page steps aside for it.
 * Shared by the docked `BrowserSurface` and the floating `BrowserPlayer`, since both draw a live native page that
 * a dialog, menu or the minimized theme editor would otherwise sit under.
 */
export function useOverlayOpen(inside: RefObject<HTMLElement | null>, viewport: RefObject<HTMLElement | null>, active = true): boolean {
  // Until the first scan, keep native content behind the DOM. Mounting before the
  // passive effect checks an existing dialog would briefly draw over that dialog.
  const [open, setOpen] = useState(true)
  useEffect(() => {
    // Hidden players have no native page to protect. Keep the document observer and frame loop dormant until shown.
    if (!active) { setOpen(true); return }
    let frame = 0
    const check = (): void => {
      cancelAnimationFrame(frame)
      frame = 0
      // The phone player marks its whole box, but only its label, phone and status draw; those parts stand in for it.
      const overlays = [...document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)].flatMap(element => element.classList.contains('phone-player') ? [...element.querySelectorAll<HTMLElement>(':scope > *')] : [element])
        .filter(element => !inside.current?.contains(element) && element.getClientRects().length > 0)
      const bars = overlays.filter(element => element.matches(COVERS_WHERE_IT_OVERLAPS))
      const modal = bars.length < overlays.length
      setOpen(modal || bars.some(bar => overlapsPage(bar, viewport.current)))
      // A bar moves with no DOM change this observes (a drag, the window or panel resizing), so it is measured every
      // frame while it alone could cover the page.
      if (!modal && bars.length > 0) frame = requestAnimationFrame(check)
    }
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'open', 'hidden', 'data-covers-native-view', 'data-minimized'] })
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [inside, viewport, active])
  return active && open
}
