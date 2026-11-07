import { useCallback, useRef } from 'react'

/**
 * Keeps the branch's name whole in a pane header by letting the project leave first (ADR-0182, November 4 amendment:
 * what stands beside the name gives way a whole part at a time, the workspace, then the project, then the branch). The
 * box's own width cannot say when that is, since it depends on how long the branch's name is, so the box is measured: when
 * the name would be cut with the project shown, the box is marked crowded and the stylesheet hides the project. Each
 * measure starts from the project shown, so it comes back as soon as both fit. It runs when the box changes size or what
 * it holds changes, never on a timer, and touches nothing but one attribute.
 */
export function useWhereFit(): (element: HTMLElement | null) => void {
  const stop = useRef<() => void>(() => undefined)
  return useCallback((element: HTMLElement | null) => {
    stop.current()
    stop.current = () => undefined
    if (!element || typeof ResizeObserver === 'undefined') return
    let measuring = false
    const measure = (): void => {
      if (measuring) return
      measuring = true
      element.removeAttribute('data-crowded')
      const name = element.querySelector<HTMLElement>('.branch-toolbar__branch > span')
      const project = element.querySelector<HTMLElement>('.thread-workspace__crumb > span:first-of-type')
      // Layout is read here once, after the attribute came off; setting it again changes nothing the box itself measures.
      if (name && project && project.offsetWidth > 0 && name.scrollWidth > name.clientWidth + 1) element.setAttribute('data-crowded', '')
      measuring = false
    }
    const resized = new ResizeObserver(measure)
    resized.observe(element)
    // The branch's name and the project arrive after the box, and a switched branch changes the name without a resize.
    const changed = new MutationObserver(measure)
    changed.observe(element, { childList: true, subtree: true, characterData: true })
    measure()
    stop.current = () => { resized.disconnect(); changed.disconnect() }
  }, [])
}
