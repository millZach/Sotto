import { useEffect, useState } from 'react'

/** Whether motion is reduced right now: by the system, or by Sotto's own Reduce motion setting. */
export function prefersReducedMotion(): boolean {
  return (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false) || document.documentElement.dataset.reducedMotion === 'on'
}

/**
 * Whether motion is reduced, following the system preference and Sotto's own setting as either changes. With `watch`
 * false it follows neither and starts nothing, for a part that is held (an Owl feature) or turned off.
 */
export function useReducedMotion(watch = true): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useEffect(() => {
    if (!watch) return undefined
    setReduced(prefersReducedMotion())
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const update = (): void => setReduced(prefersReducedMotion())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduced-motion'] })
    media?.addEventListener?.('change', update)
    return () => { observer.disconnect(); media?.removeEventListener?.('change', update) }
  }, [watch])
  return reduced
}
