import React, { useEffect, useRef, type ReactNode } from 'react'
import { useThemeBrand } from '../../components/useThemeBrand'
import { createOrb, orbColorsBeneath, type OrbHandle, type OrbState } from './orb'

/** The voice sphere, coloured by the window's theme. One canvas and renderer live for the orb's whole mount. */
export function AgentOrb({ state }: { readonly state: OrbState }): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null)
  const handle = useRef<OrbHandle | null>(null)
  const { orb: visible } = useThemeBrand()
  // The light room inverts the canvas, so what is drawn depends on the filter in force.
  const drawn = (element: HTMLCanvasElement): readonly [string, string] =>
    orbColorsBeneath(element.ownerDocument.defaultView?.getComputedStyle(element).filter ?? 'none', visible)
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const isStill = (): boolean => media.matches || document.documentElement.dataset.reducedMotion === 'on' || window.sottoE2E !== undefined
    handle.current = createOrb(element, { state, colors: drawn(element), still: isStill() })
    const motion = (): void => { handle.current?.setStill(isStill()) }
    const visibility = (): void => { if (document.hidden) handle.current?.pause(); else handle.current?.resume() }
    const observer = new MutationObserver(motion)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduced-motion'] })
    const resize = new ResizeObserver(() => handle.current?.redraw())
    resize.observe(element)
    media.addEventListener('change', motion)
    document.addEventListener('visibilitychange', visibility)
    return () => { handle.current?.dispose(); handle.current = null; observer.disconnect(); resize.disconnect(); media.removeEventListener('change', motion); document.removeEventListener('visibilitychange', visibility) }
    // State and colours update the same renderer below, preserving its motion.
  }, [])
  useEffect(() => { handle.current?.setState(state) }, [state])
  useEffect(() => {
    const element = canvas.current
    if (element) handle.current?.setColors(drawn(element))
  }, [visible[0], visible[1]])
  return <canvas ref={canvas} className="agent-orb" data-state={state} data-orb-colors={visible.join(' ')} aria-hidden="true" />
}
