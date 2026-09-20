import React, { useEffect, useRef, type ReactNode } from 'react'
import type { AgentMonitoringTask } from '../../../shared/agentMonitoring'
import './threadMonitor.css'

/** Original pixel art on a 40 × 32 grid, following the approved process-perch prototype. */
function MonitoringCreature(): ReactNode {
  const actor = useRef<HTMLDivElement>(null)
  const facing = useRef<SVGGElement>(null)
  const body = useRef<SVGGElement>(null)
  const feet = useRef<SVGPathElement>(null)
  const glass = useRef<SVGGElement>(null)
  useEffect(() => {
    const node = actor.current
    const track = node?.parentElement
    if (!node || !track) return
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    let reduced = false, frame = 0, width = track.clientWidth, previous = -Infinity
    const began = performance.now()
    const paint = (now: number): void => {
      const reach = Math.max(0, width - 80), time = (now - began) / 1000, phase = time % 14
      let x = reach, direction = 1, walking = false
      if (!reduced) {
        if (phase < 4) { x = reach * phase / 4; walking = true }
        else if (phase < 9) x = reach
        else if (phase < 13) { x = reach * (1 - (phase - 9) / 4); direction = -1; walking = true }
        else { x = 0; direction = -1 }
      }
      const step = Math.floor(time * 7) % 4
      node.style.transform = `translateX(${Math.round(x / 2) * 2}px)`
      facing.current?.setAttribute('transform', direction < 0 ? 'translate(40 0) scale(-1 1)' : '')
      body.current?.setAttribute('transform', walking && step % 2 === 1 ? 'translate(0 -1)' : '')
      const left = walking ? [9, 11, 13, 11][step]! : 11
      const right = walking ? [23, 21, 19, 21][step]! : 21
      feet.current?.setAttribute('d', `M${left} 29h5v3h-5z M${right} 29h5v3h-5z`)
      glass.current?.setAttribute('transform', walking ? 'translate(29 17)' : 'translate(25 14)')
    }
    const tick = (now: number): void => {
      frame = 0
      if (now - previous >= 1000 / 30) { paint(now); previous = now }
      if (!reduced && !document.hidden) frame = requestAnimationFrame(tick)
    }
    const refresh = (): void => {
      cancelAnimationFrame(frame)
      reduced = preference.matches || document.documentElement.dataset.reducedMotion === 'on'
      paint(performance.now())
      if (!reduced && !document.hidden) frame = requestAnimationFrame(tick)
    }
    const resize = new ResizeObserver(() => { width = track.clientWidth; paint(performance.now()) })
    const motion = new MutationObserver(refresh)
    resize.observe(track)
    motion.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduced-motion'] })
    preference.addEventListener('change', refresh)
    document.addEventListener('visibilitychange', refresh)
    refresh()
    return () => {
      cancelAnimationFrame(frame); resize.disconnect(); motion.disconnect()
      preference.removeEventListener('change', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])
  return <div className="thread-monitor__actor" ref={actor} aria-hidden="true">
    <svg className="thread-monitor__creature" viewBox="0 0 40 32" width="80" height="64" focusable="false" shapeRendering="crispEdges">
      <g ref={facing}>
        <path ref={feet} className="thread-monitor__color" d="M11 29h5v3h-5z M21 29h5v3h-5z" />
        <g ref={body}>
          <path className="thread-monitor__color" d="M9 8h4v8H9z M21 7h4v9h-4z M11 6h2v5h-2z M23 5h2v5h-2z M9 13h17v15H9z M7 16h21v9H7z M11 11h12v18H11z M5 23h4v4H5z" />
          <path className="thread-monitor__shine" opacity=".24" d="M10 14h3v9h-3z" />
          <path className="thread-monitor__ink" opacity=".24" d="M13 25h10v3H13z" />
          <path className="thread-monitor__ink" d="M15 17h2v3h-2z M22 17h2v3h-2z M20 22h2v1h-2z" />
          <g ref={glass} transform="translate(25 14)">
            <path className="thread-monitor__handle" d="M3 8h2v7H3z" />
            <path className="thread-monitor__color" d="M2 12h4v2H2z" />
            <path className="thread-monitor__color" opacity=".28" d="M1 1h7v7H1z" />
            <path className="thread-monitor__shine" d="M2 0h5v1H2z M2 8h5v1H2z M0 2h1v5H0z M8 2h1v5H8z M1 1h1v1H1z M7 1h1v1H7z M1 7h1v1H1z M7 7h1v1H7z M2 2h2v1H2z" />
          </g>
          <path className="thread-monitor__color" d="M25 25h5v2h-5z" />
        </g>
      </g>
    </svg>
  </div>
}

/** Observational only. The caller supplies live, eligible tasks from this thread's adapter. */
export function ThreadMonitor({ tasks }: { readonly tasks: readonly AgentMonitoringTask[] }): ReactNode {
  const first = tasks[0]
  if (!first) return null
  return <div className="thread-monitor" role="status" aria-live="polite" aria-atomic="true">
    <div className="thread-monitor__track"><MonitoringCreature key={first.id} /></div>
    <div className="thread-monitor__task" title={tasks.map(task => task.label).join('\n')}>
      <span className="thread-monitor__label">{first.label}</span>
      <span className="thread-monitor__status">{tasks.length === 1 ? 'Monitoring' : `Monitoring ${tasks.length} tasks`}</span>
    </div>
  </div>
}
