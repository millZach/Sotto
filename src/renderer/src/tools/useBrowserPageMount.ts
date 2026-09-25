import { useLayoutEffect, type RefObject } from 'react'
import type { BrowserBounds } from '../../../shared/browser'

/**
 * Keeps a native page mounted at `host`'s rectangle while `active`, and unmounted otherwise. Main draws the page
 * where `host` sits; layout can move it without resizing it (the panel's edge, a dragged player, a pane split), so
 * the rectangle is read every frame while shown and `mount` is called only when it changes (that de-duplication is
 * `BrowserStore.mount`'s job, not this hook's). Shared by the docked `BrowserSurface` and the floating `BrowserPlayer`
 * so the two draw the same live page the same way.
 */
export function useBrowserPageMount(host: RefObject<HTMLElement | null>, active: boolean, mount: (bounds: BrowserBounds | null) => void): void {
  useLayoutEffect(() => {
    if (!active) { mount(null); return }
    let frame = 0
    const place = (): void => {
      const element = host.current
      if (element) {
        const rect = element.getBoundingClientRect()
        const x = Math.max(0, Math.round(rect.left))
        const y = Math.max(0, Math.round(rect.top))
        const width = Math.round(rect.right) - x
        const height = Math.round(rect.bottom) - y
        mount(width >= 1 && height >= 1 && document.visibilityState !== 'hidden' ? { x, y, width, height } : null)
      }
      frame = requestAnimationFrame(place)
    }
    place()
    return () => { cancelAnimationFrame(frame); mount(null) }
  }, [active, mount, host])
}
