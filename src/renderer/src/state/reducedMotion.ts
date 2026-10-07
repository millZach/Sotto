import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

/** Whether motion is reduced: by the system's setting, or by Sotto's own Reduce motion setting on the root. */
export function readReducedMotion(): boolean {
  return document.documentElement.dataset.reducedMotion === 'on' || (window.matchMedia?.(QUERY).matches ?? false)
}

/** `readReducedMotion`, kept current as either setting changes. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReducedMotion)
  useEffect(() => {
    const update = (): void => setReduced(readReducedMotion())
    const media = window.matchMedia?.(QUERY)
    media?.addEventListener('change', update)
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduced-motion'] })
    return () => { media?.removeEventListener('change', update); observer.disconnect() }
  }, [])
  return reduced
}
