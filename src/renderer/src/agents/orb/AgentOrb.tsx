import React, { useEffect, useRef, type ReactNode } from 'react'
import { createOrb, type OrbHandle, type OrbPreset, type OrbState } from './orb'

export function AgentOrb({ state, color }: { readonly state: OrbState; readonly color: OrbPreset }): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null)
  const handle = useRef<OrbHandle | null>(null)
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const isStill = (): boolean => media.matches || document.documentElement.dataset.reducedMotion === 'on' || window.sottoE2E !== undefined
    handle.current = createOrb(element, { state, colors: color, still: isStill() })
    const motion = (): void => { handle.current?.setStill(isStill()) }
    const visible = (): void => { if (document.hidden) handle.current?.pause(); else handle.current?.resume() }
    const observer = new MutationObserver(motion)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduced-motion'] })
    const resize = new ResizeObserver(() => handle.current?.redraw())
    resize.observe(element)
    media.addEventListener('change', motion)
    document.addEventListener('visibilitychange', visible)
    return () => { handle.current?.dispose(); handle.current = null; observer.disconnect(); resize.disconnect(); media.removeEventListener('change', motion); document.removeEventListener('visibilitychange', visible) }
    // State and color update the same renderer below, preserving its motion.
  }, [])
  useEffect(() => { handle.current?.setState(state) }, [state])
  useEffect(() => { handle.current?.setColors(color) }, [color])
  return <canvas ref={canvas} className="agent-orb" data-state={state} aria-hidden="true" />
}
