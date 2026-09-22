import React, { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { AgentMonitoringTask } from '../../../shared/agentMonitoring'
import type { AgentThread } from '../../../shared/agents'
import { formatDuration, heldAction, heldLabel, heldLongEnough, HELD_AFTER_MS, type HeldAction } from './threadActivityView'
import './threadMonitor.css'

/** One frame of a pixel pose: seconds since the pose appeared, whether motion is held, and the track it stands on. */
interface PixelFrame {
  readonly time: number
  readonly still: boolean
  readonly width: number
}

/**
 * The loop every pixel pose shares: 30fps, held in a single pose under system or app reduced motion,
 * and stopped entirely while the window is hidden. The painter reads its own refs and writes no state.
 */
function usePixelLoop(actor: RefObject<HTMLDivElement | null>, paint: (frame: PixelFrame) => void): void {
  const painter = useRef(paint)
  // Assigned after the commit rather than during render, so a double-rendered pass cannot install a
  // painter whose render was thrown away. The loop below only ever reads it from a frame callback.
  useEffect(() => { painter.current = paint })
  useEffect(() => {
    const node = actor.current
    const track = node?.parentElement
    if (!node || !track) return
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const began = performance.now()
    let reduced = false, frame = 0, width = track.clientWidth, previous = -Infinity
    const render = (now: number): void => { painter.current({ time: (now - began) / 1000, still: reduced, width }) }
    const tick = (now: number): void => {
      frame = 0
      if (now - previous >= 1000 / 30) { render(now); previous = now }
      if (!reduced && !document.hidden) frame = requestAnimationFrame(tick)
    }
    const refresh = (): void => {
      cancelAnimationFrame(frame)
      reduced = preference.matches || document.documentElement.dataset.reducedMotion === 'on'
      render(performance.now())
      if (!reduced && !document.hidden) frame = requestAnimationFrame(tick)
    }
    const resize = new ResizeObserver(() => { width = track.clientWidth; render(performance.now()) })
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
  }, [actor])
}

/** The body every pose shares, so both read as the same creature. Ears, tail and belly never animate. */
const BODY = 'M9 8h4v8H9z M21 7h4v9h-4z M11 6h2v5h-2z M23 5h2v5h-2z M9 13h17v15H9z M7 16h21v9H7z M11 11h12v18H11z M5 23h4v4H5z'
const OPEN_EYES = 'M15 17h2v3h-2z M22 17h2v3h-2z M20 22h2v1h-2z'
const SHUT_EYES = 'M15 17h2v1h-2z M22 17h2v1h-2z M20 22h2v1h-2z'

/** Original pixel art on a 40 × 32 grid, following the approved process-perch prototype. */
function MonitoringCreature(): ReactNode {
  const actor = useRef<HTMLDivElement>(null)
  const facing = useRef<SVGGElement>(null)
  const body = useRef<SVGGElement>(null)
  const feet = useRef<SVGPathElement>(null)
  const glass = useRef<SVGGElement>(null)
  usePixelLoop(actor, ({ time, still, width }) => {
    const reach = Math.max(0, width - 80), phase = time % 14
    let x = reach, direction = 1, walking = false
    if (!still) {
      if (phase < 4) { x = reach * phase / 4; walking = true }
      else if (phase < 9) x = reach
      else if (phase < 13) { x = reach * (1 - (phase - 9) / 4); direction = -1; walking = true }
      else { x = 0; direction = -1 }
    }
    const step = Math.floor(time * 7) % 4
    if (actor.current) actor.current.style.transform = `translateX(${Math.round(x / 2) * 2}px)`
    facing.current?.setAttribute('transform', direction < 0 ? 'translate(40 0) scale(-1 1)' : '')
    body.current?.setAttribute('transform', walking && step % 2 === 1 ? 'translate(0 -1)' : '')
    const left = walking ? [9, 11, 13, 11][step]! : 11
    const right = walking ? [23, 21, 19, 21][step]! : 21
    feet.current?.setAttribute('d', `M${left} 29h5v3h-5z M${right} 29h5v3h-5z`)
    glass.current?.setAttribute('transform', walking ? 'translate(29 17)' : 'translate(25 14)')
  })
  return <div className="thread-monitor__actor" ref={actor} aria-hidden="true">
    <svg className="thread-monitor__creature" viewBox="0 0 40 32" width="80" height="64" focusable="false" shapeRendering="crispEdges">
      <g ref={facing}>
        <path ref={feet} className="thread-monitor__color" d="M11 29h5v3h-5z M21 29h5v3h-5z" />
        <g ref={body}>
          <path className="thread-monitor__color" d={BODY} />
          <path className="thread-monitor__shine" opacity=".24" d="M10 14h3v9h-3z" />
          <path className="thread-monitor__ink" opacity=".24" d="M13 25h10v3H13z" />
          <path className="thread-monitor__ink" d={OPEN_EYES} />
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

/**
 * Three grains of sand, top chamber and bottom, each row top to bottom. The glass is held out clear of
 * the body (which reaches x=28): a translucent vessel over a solid body would be the same colour as it,
 * so like the loupe's ring it reads by sitting against the surface with a bright outline.
 */
const TOP_ROWS = [[31, 10, 5], [31, 11, 5], [32, 12, 3]] as const
const BOTTOM_ROWS = [[32, 16, 3], [31, 17, 5], [31, 18, 5]] as const
/** A path that draws nothing, for a chamber with no sand in it and a grain that is not falling. */
const EMPTY_PATH = 'M0 0h0v0z'
const sandPath = (rows: readonly (readonly [number, number, number])[]): string =>
  rows.map(([x, y, width]) => `M${x} ${y}h${width}v1h-${width}z`).join(' ') || EMPTY_PATH
/** A full turn of the glass, and the part of it spent flipping rather than running. */
const GLASS_PERIOD = 6, GLASS_FLIP = 0.5

/**
 * The same creature stood still, holding an hourglass. It says only that time is passing on work the
 * thread started; nothing here claims the provider is watching, and it grants no authority.
 */
function HeldCreature(): ReactNode {
  const actor = useRef<HTMLDivElement>(null)
  const body = useRef<SVGGElement>(null)
  const eyes = useRef<SVGPathElement>(null)
  const glass = useRef<SVGGElement>(null)
  const topSand = useRef<SVGPathElement>(null)
  const bottomSand = useRef<SVGPathElement>(null)
  const grain = useRef<SVGPathElement>(null)
  usePixelLoop(actor, ({ time, still }) => {
    // Held motion keeps a half-run glass: the pose still reads as waiting without a frame of movement.
    const phase = still ? GLASS_PERIOD / 2 : time % GLASS_PERIOD
    const running = GLASS_PERIOD - GLASS_FLIP
    const drain = Math.min(1, phase / running)
    const spin = phase > running ? (phase - running) / GLASS_FLIP : 0
    const gone = Math.min(3, Math.floor(drain * 3))
    body.current?.setAttribute('transform', !still && Math.floor(time * 1.2) % 2 === 1 ? 'translate(0 -1)' : '')
    eyes.current?.setAttribute('d', !still && time % 5 > 4.86 ? SHUT_EYES : OPEN_EYES)
    // The rotation only ever runs during the flip, and never carries over: the sand rows live in the
    // rotated group, so a half turn that outlasted the flip would empty the chamber the reader sees
    // filling, and the sand would climb. Because the vessel is symmetric, ending a flip at half a turn
    // looks exactly like starting the next cycle upright, so the full chamber stays where the eye left it.
    glass.current?.setAttribute('transform', `rotate(${spin * 180} 33.5 14.5)`)
    topSand.current?.setAttribute('d', sandPath(TOP_ROWS.slice(gone)))
    bottomSand.current?.setAttribute('d', sandPath(BOTTOM_ROWS.slice(3 - gone)))
    grain.current?.setAttribute('d', drain < 1 && !still ? `M33 ${13 + Math.floor(time * 8) % 3}h1v1h-1z` : EMPTY_PATH)
  })
  return <div className="thread-monitor__actor" ref={actor} aria-hidden="true">
    <svg className="thread-monitor__creature" viewBox="0 0 40 32" width="80" height="64" focusable="false" shapeRendering="crispEdges">
      <path className="thread-monitor__color" d="M11 29h5v3h-5z M21 29h5v3h-5z" />
      <g ref={body}>
        <path className="thread-monitor__color" d={BODY} />
        <path className="thread-monitor__shine" opacity=".24" d="M10 14h3v9h-3z" />
        <path className="thread-monitor__ink" opacity=".24" d="M13 25h10v3H13z" />
        <path ref={eyes} className="thread-monitor__ink" d={OPEN_EYES} />
        {/* The arm holding it out past the body, then the glass, whose sand reads against the surface. */}
        <path className="thread-monitor__color" d="M28 14h2v2h-2z" />
        <g ref={glass}>
          <path className="thread-monitor__color" opacity=".28" d="M31 10h5v2h-5z M32 12h3v1h-3z M33 13h1v3h-1z M32 16h3v1h-3z M31 17h5v2h-5z" />
          <path ref={topSand} className="thread-monitor__color thread-monitor__sand" d={sandPath(TOP_ROWS)} />
          <path ref={bottomSand} className="thread-monitor__color thread-monitor__sand" d={EMPTY_PATH} />
          <path ref={grain} className="thread-monitor__color" d={EMPTY_PATH} />
          {/* Caps and tapering walls last, so the outline holds the shape over body or surface alike. */}
          <path className="thread-monitor__shine" d="M30 9h7v1h-7z M30 19h7v1h-7z M30 10h1v2h-1z M36 10h1v2h-1z M31 12h1v1h-1z M35 12h1v1h-1z M32 13h1v3h-1z M34 13h1v3h-1z M31 16h1v1h-1z M35 16h1v1h-1z M30 17h1v2h-1z M36 17h1v2h-1z" />
        </g>
        <path className="thread-monitor__color" d="M25 25h5v2h-5z" />
      </g>
    </svg>
  </div>
}

/** Counts up in its own element so a waiting thread never re-renders its transcript to show a clock. */
function WaitedFor({ startedAt, now }: { readonly startedAt: string; readonly now: number | undefined }): ReactNode {
  const ref = useRef<HTMLSpanElement>(null)
  const text = (at: number): string => ` · ${formatDuration(Math.max(0, at - Date.parse(startedAt)))}`
  useEffect(() => {
    if (now !== undefined) return
    const tick = (): void => { if (ref.current) ref.current.textContent = text(Date.now()) }
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [startedAt, now])
  // Announcing a clock every second would talk over the rest of the page, so only the label is read out.
  return <span ref={ref} aria-hidden="true">{text(now ?? Date.now())}</span>
}

/**
 * The action this thread has been held on long enough to say so, with one timer that fires as the
 * threshold passes. A fixed clock — a capture — answers from that clock and schedules nothing.
 */
export function useHeldAction(thread: Pick<AgentThread, 'status' | 'activities' | 'messages'>, eligible: boolean,
  now: number | undefined): HeldAction | undefined {
  const [, setTick] = useState(0)
  // Finding the action filters and sorts the activity window, which is bounded at 2,000 records, so it
  // waits on the records themselves rather than repeating on every keystroke the composer re-renders for.
  const { status, activities, messages } = thread
  const action = useMemo(() => eligible ? heldAction({ status, activities, messages }) : undefined,
    [eligible, status, activities, messages])
  const startedAt = action?.startedAt
  useEffect(() => {
    if (now !== undefined || startedAt === undefined) return
    const remaining = HELD_AFTER_MS - (Date.now() - Date.parse(startedAt))
    if (!Number.isFinite(remaining) || remaining <= 0) return
    const timer = window.setTimeout(() => setTick(value => value + 1), remaining)
    return () => window.clearTimeout(timer)
  }, [startedAt, now])
  return action !== undefined && heldLongEnough(action, now ?? Date.now()) ? action : undefined
}

/**
 * The one shape both poses wear: a creature on its track, and a readout naming what it stands for.
 * `kind` marks which pose is up; the composer reserves its room from the ornament's presence alone.
 */
function ThreadOrnament({ kind, creature, label, title, status }: {
  readonly kind: 'monitoring' | 'held'
  readonly creature: ReactNode
  readonly label: string
  readonly title: string
  readonly status: ReactNode
}): ReactNode {
  return <div className="thread-monitor" data-ornament={kind} role="status" aria-live="polite" aria-atomic="true">
    <div className="thread-monitor__track">{creature}</div>
    <div className="thread-monitor__task" title={title}>
      <span className="thread-monitor__label">{label}</span>
      <span className="thread-monitor__status">{status}</span>
    </div>
  </div>
}

/** Observational only. The caller supplies live, eligible tasks from this thread's adapter. */
export function ThreadMonitor({ tasks }: { readonly tasks: readonly AgentMonitoringTask[] }): ReactNode {
  const first = tasks[0]
  if (!first) return null
  return <ThreadOrnament kind="monitoring" creature={<MonitoringCreature key={first.id} />}
    label={first.label} title={tasks.map(task => task.label).join('\n')}
    status={tasks.length === 1 ? 'Monitoring' : `Monitoring ${tasks.length} tasks`} />
}

/**
 * Observational only. One action has held this thread past the threshold; the caller judged that.
 * The reader is told "Waiting", which is the plain word for it whatever the code calls the record.
 */
export function ThreadHeld({ action, now }: { readonly action: HeldAction; readonly now: number | undefined }): ReactNode {
  const label = heldLabel(action)
  return <ThreadOrnament kind="held" creature={<HeldCreature key={action.id} />} label={label} title={label}
    status={<>Waiting<WaitedFor startedAt={action.startedAt} now={now} /></>} />
}
