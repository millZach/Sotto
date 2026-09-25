import { useEffect, useState, type RefObject } from 'react'

/** Anything drawn above the page that a native view would cover. Native views composite over all DOM. */
const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], dialog[open], [data-covers-native-view]'

/**
 * Overlays that cover only what they overlap, rather than the whole page: the minimized theme editor bar (the
 * reader keeps it up while checking a theme against the page, so the page shows beside it), and the browser
 * player (its own rectangle is exactly where it draws, so a page docked in Tools elsewhere on screen steps aside
 * only if the player is actually sitting over it, not merely open).
 */
const COVERS_WHERE_IT_OVERLAPS = '[data-theme-editor-panel][data-minimized], .browser-player'

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
export function useOverlayOpen(inside: RefObject<HTMLElement | null>, viewport: RefObject<HTMLElement | null>): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let frame = 0
    const check = (): void => {
      cancelAnimationFrame(frame)
      frame = 0
      const overlays = [...document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)].filter(element => !inside.current?.contains(element) && element.getClientRects().length > 0)
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
  }, [inside, viewport])
  return open
}
