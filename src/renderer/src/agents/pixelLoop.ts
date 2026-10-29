import { useEffect, useRef, type RefObject } from 'react'

/** One frame of a pixel pose: seconds since the pose appeared, whether motion is held, and the track it stands on. */
export interface PixelFrame {
  readonly time: number
  readonly still: boolean
  readonly width: number
}

/**
 * The loop every pixel pose shares: 30fps, held in a single pose under system or app reduced motion,
 * and stopped entirely while the window is hidden. The painter reads its own refs and writes no state.
 * `repaintOn` names what the pose draws from its props: a change paints one frame at once, because a
 * held pose has no next frame to pick it up on.
 */
export function usePixelLoop(actor: RefObject<HTMLDivElement | null>, paint: (frame: PixelFrame) => void, repaintOn?: unknown): void {
  const painter = useRef(paint)
  const repaint = useRef<() => void>(() => undefined)
  // Assigned after the commit rather than during render, so a double-rendered pass cannot install a
  // painter whose render was thrown away. The loop below only ever reads it from a frame callback.
  useEffect(() => { painter.current = paint })
  useEffect(() => {
    const node = actor.current
    const track = node?.parentElement
    if (!node || !track) return
    const began = performance.now()
    let reduced = false, frame = 0, width = track.clientWidth, previous = -Infinity
    const render = (now: number): void => { painter.current({ time: (now - began) / 1000, still: reduced, width }) }
    repaint.current = () => render(performance.now())
    const tick = (now: number): void => {
      frame = 0
      if (now - previous >= 1000 / 30) { render(now); previous = now }
      if (!reduced && !document.hidden) frame = requestAnimationFrame(tick)
    }
    const refresh = (): void => {
      cancelAnimationFrame(frame)
      reduced = motionHeld()
      render(performance.now())
      if (!reduced && !document.hidden) frame = requestAnimationFrame(tick)
    }
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => { width = track.clientWidth; render(performance.now()) })
    resize?.observe(track)
    const unwatch = watchMotion(refresh)
    document.addEventListener('visibilitychange', refresh)
    refresh()
    return () => {
      cancelAnimationFrame(frame); resize?.disconnect(); unwatch(); repaint.current = () => undefined
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [actor])
  useEffect(() => { repaint.current() }, [repaintOn])
}

/** Where a monitoring creature stands on one frame of its walk: how far along, facing which way, and whether it steps. */
export interface WalkFrame {
  readonly x: number
  readonly left: boolean
  readonly walking: boolean
  /** Seconds into the 14 s cycle, for what a creature does at the far end. */
  readonly phase: number
}

/**
 * The walk every creature keeps while monitoring: out along the track 4 s, 5 s at the far end, back 4 s, a second's rest
 * at the start facing back. Held still, it stands at the far end facing out.
 */
export function walkFrame(time: number, still: boolean, width: number): WalkFrame {
  const reach = Math.max(0, width - 80), phase = time % 14
  if (still) return { x: reach, left: false, walking: false, phase }
  if (phase < 4) return { x: reach * phase / 4, left: false, walking: true, phase }
  if (phase < 9) return { x: reach, left: false, walking: false, phase }
  if (phase < 13) return { x: reach * (1 - (phase - 9) / 4), left: true, walking: true, phase }
  return { x: 0, left: true, walking: false, phase }
}

/**
 * Whether motion is held: the system's preference, Sotto's own setting, or a window that cannot say whether motion is
 * reduced (a test's), which holds one painted frame rather than loop unasked.
 */
export function motionHeld(): boolean {
  const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  return preference === undefined || preference.matches || document.documentElement.dataset.reducedMotion === 'on'
}

/** Calls `changed` whenever either of the two things `motionHeld` reads changes. Returns the way to stop. */
export function watchMotion(changed: () => void): () => void {
  const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  const setting = new MutationObserver(changed)
  setting.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduced-motion'] })
  preference?.addEventListener('change', changed)
  return () => { setting.disconnect(); preference?.removeEventListener('change', changed) }
}

/** The small agents' width, in pixels. */
const MINI_WIDTH = 24

/** One small agent on one frame of background work: its place on the track as a transform, and whether it is mid-step. */
export interface MiniFrame {
  readonly transform: string
  readonly stepping: boolean
}

/**
 * Where small agent `index` of `count` is: leaving from under the creature at the readout end and walking until it is past
 * the track's clipped left edge. Held still, they stand in a line a step apart: a stride clear of each other where the
 * track allows, closing up on the narrowest track so the last never falls off the end.
 */
export function miniFrame(time: number, still: boolean, width: number, index: number, count: number): MiniFrame {
  const start = Math.max(0, width - 96), span = start + MINI_WIDTH
  const stride = Math.min(MINI_WIDTH + 12, Math.max(0, start - 12) / Math.max(1, count))
  const x = still ? Math.max(0, start - 12 - index * stride) : start - span * ((time * 0.09 + index * 0.17) % 1)
  const stepping = !still && Math.floor(time * 6 + index) % 2 === 1
  return { transform: `translate(${Math.round(x / 2) * 2}px, ${stepping ? -1 : 0}px)`, stepping }
}
