import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { pixelPath } from './claudeBotSprite'
import { EMPTY_PATH, glassFrame, HOURGLASS_OUTLINE, HOURGLASS_VESSEL, sandPath, TOP_ROWS } from './hourglass'
import { LARDO_FACING_LEFT, LARDO_LETTERS, LARDO_MINI_ROWS, LARDO_SPARKLES, LARDO_STEAM, lardoPaths, type LardoFrame, type LardoLetter } from './lardoSprite'
import { miniFrame, motionHeld, usePixelLoop, walkFrame, watchMotion, type PixelFrame } from './pixelLoop'
import './lardo.css'

export type LardoPose = 'monitoring' | 'working' | 'held' | 'babysitting'

/**
 * When the thread's last turn finished with Lardo up throughout (`performance.now()`), so he can flex for it. `LardoTurns`
 * provides it; anywhere else (the Appearance preview) no turn ever finishes, so he never flexes there.
 */
const LardoTurnFinished = createContext<number | null>(null)
/** A finish this recent is still his to flex for, even if the turn's end has just swapped him for another pose. */
const FRESH_FINISH_MS = 250

/**
 * The thread pane's half of the flex, wrapped round Lardo's pose only while he is the creature standing there, so a build
 * that holds him runs none of it: the moment a turn ends that he stood above the composer for, whichever pose he wears.
 * Judged here rather than in Lardo because the turn's end can change his pose (a held action becoming a command left
 * waiting), which mounts him anew while this stays. Unmounted when he leaves, so he never appears just to flex.
 */
export function LardoTurns({ running, children }: { readonly running: boolean; readonly children: ReactNode }): ReactNode {
  const [finished, setFinished] = useState<number | null>(null)
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) setFinished(performance.now())
    wasRunning.current = running
  }, [running])
  return <LardoTurnFinished.Provider value={finished}>{children}</LardoTurnFinished.Provider>
}

/** What Lardo is doing instead of his pose for a moment: a flex when a turn finishes, or a tantrum when clicked. */
interface Cue {
  readonly kind: 'flex' | 'angry'
  /** Held still under reduced motion: one pose for the length of the cue, and nothing thrown. */
  readonly still: boolean
}
/** One frame of a cue: which frame, turned which way, and what is drawn round him. */
interface CueStep {
  readonly frame: LardoFrame
  readonly left?: boolean
  readonly extra?: string
}

/** How long each cue lasts, in milliseconds, by kind and whether it is held still. */
const CUE_LENGTH = { flex: { moving: 1180, still: 1200 }, angry: { moving: 2200, still: 1500 } } as const

/**
 * A finished turn: a quarter turn, back double biceps with a sparkle, and back round. Clicked: he rips a piece out of
 * the composer, lifts it, hurls it at the screen and stands there most muscular, flushed and steaming. Held still, each
 * is its one pose.
 */
function cueStep(cue: Cue, elapsed: number): CueStep {
  if (cue.kind === 'flex') {
    if (cue.still) return { frame: 'backDoubleBiceps' }
    if (elapsed < 140) return { frame: 'sideChest' }
    if (elapsed < 1040) return { frame: 'backDoubleBiceps', extra: LARDO_SPARKLES[Math.floor((elapsed - 140) / 225) % 2]! }
    return { frame: 'sideChest', left: true }
  }
  if (cue.still) return { frame: 'mostMuscularAngry' }
  if (elapsed < RIP_AT) return { frame: 'rip' }
  if (elapsed < HURL_AT) return { frame: 'lift' }
  if (elapsed < SHATTER_AT) return { frame: 'hurl' }
  return { frame: 'mostMuscularAngry', extra: LARDO_STEAM }
}
/** The tantrum's beats: the piece comes away at RIP_AT, leaves his hands at HURL_AT and hits the screen at SHATTER_AT. */
const RIP_AT = 220, HURL_AT = 620, SHATTER_AT = 1000, REFORM_AT = 1250, REFORM_FOR = 900

const MINI_PATHS = LARDO_MINI_ROWS.map(rows => Object.fromEntries((['k', 's', 't'] as const).map(ch => [ch, pixelPath(rows, ch)])) as Record<'k' | 's' | 't', string>)
/** As many small Lardos as the other creatures send out, at most; the readout carries the real count. */
const MAX_WORKING_MINIS = 6
/** The hourglass stands on the floor at his right, clear of his elbows, in the units the other creatures hold it in. */
const GLASS_ON_FLOOR = 'translate(2 11)'

/**
 * Lardo wearing one of the creature's poses. Monitoring: he struts the track on the schedule Sotto's creature walks it and
 * hits a side chest at each end. Working: front double biceps at the readout end, pumping, while small Lardos jog out
 * along the track, one per agent. Held: the vacuum beside an hourglass on the floor. Babysitting: abdominal and thigh
 * beside the pull request sign, still, in his own colours (Zach's call; the other creatures mute). Reduced motion holds
 * every pose still, as it holds the others.
 *
 * When the thread's turn finishes while he is up, he flexes. Clicked, he tears a bite out of the composer's top edge and
 * hurls it at the screen, where it shatters, and the composer grows back. Everything he throws is drawn over the window
 * and catches no pointer; the composer's text, caret, attachments and focus are never touched, and a press on him never
 * takes focus. Held still, a click only makes him angry. `playful` false (the Appearance preview) leaves him unclickable.
 */
export function Lardo({ pose, agents = 1, playful = true }: { readonly pose: LardoPose; readonly agents?: number; readonly playful?: boolean }): ReactNode {
  const actor = useRef<HTMLDivElement>(null)
  const facing = useRef<SVGGElement>(null)
  const letters = useRef<Partial<Record<LardoLetter, SVGPathElement | null>>>({})
  const extra = useRef<SVGPathElement>(null)
  const minis = useRef<(HTMLDivElement | null)[]>([])
  const miniPaths = useRef<(SVGGElement | null)[]>([])
  const glass = useRef<SVGGElement>(null)
  const topSand = useRef<SVGPathElement>(null)
  const bottomSand = useRef<SVGPathElement>(null)
  const grain = useRef<SVGPathElement>(null)
  const count = pose === 'working' ? Math.min(MAX_WORKING_MINIS, Math.max(1, agents)) : 0

  const [cue, setCue] = useState<Cue | null>(null)
  const cueRef = useRef<{ cue: Cue; began: number } | null>(null)
  const ends = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const begin = useCallback((next: Cue) => {
    clearTimeout(ends.current)
    cueRef.current = { cue: next, began: performance.now() }
    setCue(next)
    ends.current = setTimeout(() => { cueRef.current = null; setCue(null) }, CUE_LENGTH[next.kind][next.still ? 'still' : 'moving'])
  }, [])
  const play = useCallback((kind: Cue['kind']) => {
    if (!cueRef.current) begin({ kind, still: motionHeld() })
  }, [begin])
  useEffect(() => () => clearTimeout(ends.current), [])
  // Reduced motion turned on mid-cue, the system's or Sotto's own: whatever was thrown goes, and he holds the cue's pose.
  useEffect(() => {
    if (!cue || cue.still) return
    return watchMotion(() => { if (motionHeld() && cueRef.current) begin({ kind: cue.kind, still: true }) })
  }, [cue, begin])

  // A turn that finished while he was up: each finish once, and only a fresh one, so a pose that comes later never flexes.
  const finished = useContext(LardoTurnFinished)
  const flexedFor = useRef<number | null>(null)
  useEffect(() => {
    if (finished !== null && finished !== flexedFor.current && performance.now() - finished < FRESH_FINISH_MS) play('flex')
    flexedFor.current = finished
  }, [finished, play])

  /** The monitoring schedule stands still while he flexes or rages, so he picks up where he stopped rather than jumping on. */
  const paused = useRef({ total: 0, since: null as number | null })
  const draw = (frame: LardoFrame, left: boolean, decoration: string): void => {
    const paths = lardoPaths(frame)
    for (const letter of LARDO_LETTERS) letters.current[letter]?.setAttribute('d', paths[letter])
    facing.current?.setAttribute('transform', left ? LARDO_FACING_LEFT : '')
    extra.current?.setAttribute('d', decoration)
  }
  const paint = ({ time, still, width }: PixelFrame): void => {
    const reach = Math.max(0, width - 80)
    const active = cueRef.current
    const hold = paused.current
    if (active && hold.since === null) hold.since = time
    if (!active && hold.since !== null) { hold.total += time - hold.since; hold.since = null }
    const posed = time - hold.total - (hold.since === null ? 0 : time - hold.since)
    let x = 0, frame: LardoFrame, left = false
    if (pose === 'monitoring') {
      const walk = walkFrame(posed, still, width)
      const walking = walk.walking
      x = walk.x
      left = walk.left
      frame = walking ? (['strut0', 'strut1', 'strut2', 'strut3'] as const)[Math.floor(posed * 7) % 4]! : 'sideChest'
    } else if (pose === 'working') {
      x = reach
      frame = !still && Math.floor(time * 2) % 2 === 1 ? 'frontDoubleBicepsPump' : 'frontDoubleBiceps'
      // The small Lardos keep the other creatures' schedule: out from behind him, off the track's clipped left edge.
      minis.current.forEach((mini, index) => {
        if (!mini) return
        const { transform, stepping } = miniFrame(time, still, width, index, count)
        mini.style.transform = transform
        miniPaths.current[index]?.querySelectorAll('path').forEach(path => {
          const letter = path.dataset.letter as 'k' | 's' | 't'
          path.setAttribute('d', MINI_PATHS[stepping ? 1 : 0]![letter])
        })
      })
    } else if (pose === 'held') {
      frame = !still && Math.floor(time * 1.2) % 2 === 1 ? 'vacuumHold' : 'vacuum'
      // The glass every creature holds; held still, it keeps half its sand.
      const sand = glassFrame(time, still)
      glass.current?.setAttribute('transform', sand.turn)
      topSand.current?.setAttribute('d', sand.top)
      bottomSand.current?.setAttribute('d', sand.bottom)
      grain.current?.setAttribute('d', sand.grain)
    } else frame = 'abdominalThigh'
    // Only the poses that travel write a place, as the other creatures do; the rest stand at the track's start.
    if (actor.current) actor.current.style.transform = pose === 'monitoring' || pose === 'working' ? `translateX(${Math.round(x / 2) * 2}px)` : ''
    if (active) {
      const step = cueStep(active.cue, performance.now() - active.began)
      draw(step.frame, step.left ?? false, step.extra ?? EMPTY_PATH)
    } else draw(frame, left, EMPTY_PATH)
  }

  // Babysitting never moves, so it has no frame loop of its own: it is painted once, and loops only while a cue plays.
  const looping = pose !== 'babysitting' || cue !== null
  useLayoutEffect(() => {
    if (!looping) paint({ time: 0, still: true, width: actor.current?.parentElement?.clientWidth ?? 80 })
  })

  const tantrum = playful ? () => play('angry') : undefined
  return <>
    {/* A held pose has no next frame, so a cue or a change in the number of small Lardos paints one at once. */}
    {looping ? <LardoLoop actor={actor} paint={paint} repaintOn={`${cue?.kind}:${cue?.still}:${count}`} /> : null}
    {Array.from({ length: count }, (_, index) => <div key={index} className="thread-monitor__mini" aria-hidden="true"
      ref={node => { minis.current[index] = node }}>
      <svg viewBox="0 0 12 10" width="24" height="20" focusable="false" shapeRendering="crispEdges">
        <g ref={node => { miniPaths.current[index] = node }}>
          <path className="lardo-s" data-letter="s" d={MINI_PATHS[0]!.s} />
          <path className="lardo-t" data-letter="t" d={MINI_PATHS[0]!.t} />
          <path className="lardo-k" data-letter="k" d={MINI_PATHS[0]!.k} />
        </g>
      </svg>
    </div>)}
    <div className="thread-monitor__actor lardo" ref={actor} aria-hidden="true" data-cue={cue?.kind}
      // A press on him must not move focus: not by default, and not through the slim composer's press, which focuses it.
      onMouseDown={tantrum ? event => { event.preventDefault(); event.stopPropagation() } : undefined} onClick={tantrum}>
      <svg className="thread-monitor__creature" viewBox="0 0 40 32" width="80" height="64" focusable="false" shapeRendering="crispEdges">
        {pose === 'held' ? <g transform={GLASS_ON_FLOOR}>
          <g ref={glass}>
            <path className="thread-monitor__color" opacity=".28" d={HOURGLASS_VESSEL} />
            <path ref={topSand} className="thread-monitor__color thread-monitor__sand" d={sandPath(TOP_ROWS)} />
            <path ref={bottomSand} className="thread-monitor__color thread-monitor__sand" d={EMPTY_PATH} />
            <path ref={grain} className="thread-monitor__color" d={EMPTY_PATH} />
            <path className="thread-monitor__shine" d={HOURGLASS_OUTLINE} />
          </g>
        </g> : null}
        {pose === 'babysitting' ? <g transform="translate(2 0)">
          {/* The other creatures' sign, on a pole planted in the floor beside him, his hands being behind his head. */}
          <path className="thread-monitor__handle" d="M32 11h2v21h-2z" />
          <path className="thread-monitor__color" opacity=".28" d="M29 3h9v8h-9z" />
          <path className="thread-monitor__shine" d="M29 2h9v1h-9z M29 11h9v1h-9z M28 3h1v8h-1z M38 3h1v8h-1z" />
          <path className="thread-monitor__sign" d="M30 4h2v2h-2z M31 6h1v4h-1z M30 10h2v2h-2z M35 4h1v1h-1z M36 5h1v5h-1z M35 10h2v2h-2z M34 4h1v1h-1z" />
        </g> : null}
        <g ref={facing} className="lardo__body">
          {LARDO_LETTERS.map(letter => <path key={letter} className={`lardo-${letter}`} ref={node => { letters.current[letter] = node }} d={EMPTY_PATH} />)}
        </g>
        <path ref={extra} className={cue?.kind === 'angry' ? 'lardo-steam' : 'lardo-spark'} d={EMPTY_PATH} />
      </svg>
    </div>
    {cue?.kind === 'angry' && !cue.still ? <LardoThrow actor={actor} /> : null}
  </>
}

/** The shared frame loop, mounted only while something moves, so a still pose costs nothing. */
function LardoLoop({ actor, paint, repaintOn }: { readonly actor: RefObject<HTMLDivElement | null>; readonly paint: (frame: PixelFrame) => void; readonly repaintOn: unknown }): null {
  usePixelLoop(actor, paint, repaintOn)
  return null
}

/** The bite: as wide as he is tall, and only as deep as the composer's top padding, so it never covers what is written. */
const BITE = { width: 56, height: 10 }
const BITE_CELL = 4
const SHARDS = 22

/**
 * What Lardo throws, drawn over the whole window and catching no pointer: a bite out of the composer's top edge beside
 * him, the piece itself rising to his hands and flying at the screen, the shards and cracks where it hits, and the
 * composer growing back over the bite a few pixels at a time. It reads the composer's place on the screen and nothing
 * else of it. Mounted for one tantrum; everything it starts it stops when he is done.
 */
function LardoThrow({ actor }: { readonly actor: RefObject<HTMLDivElement | null> }): ReactNode {
  const bite = useRef<HTMLDivElement>(null)
  const piece = useRef<HTMLDivElement>(null)
  const shards = useRef<(HTMLDivElement | null)[]>([])
  const cracks = useRef<SVGSVGElement>(null)
  const [scatter] = useState(() => Array.from({ length: SHARDS }, () => ({ size: 6 + Math.random() * 14, angle: Math.random() * Math.PI * 2,
    distance: 120 + Math.random() * 240, spin: (Math.random() - 0.5) * 540, duration: 700 + Math.random() * 300 })))
  const [cells] = useState(() => {
    const all: { x: number; y: number; delay: number }[] = []
    for (let y = 0; y < BITE.height; y += BITE_CELL) for (let x = 0; x < BITE.width; x += BITE_CELL) all.push({ x, y, delay: 0 })
    return all.map(cell => ({ ...cell, delay: Math.random() * REFORM_FOR }))
  })
  useLayoutEffect(() => {
    const him = actor.current
    const composer = him?.closest<HTMLElement>('.thread-prompt, .agent-composer')
    if (!him || !composer || !bite.current || !piece.current) return
    const card = composer.getBoundingClientRect(), stands = him.getBoundingClientRect()
    const left = Math.max(card.left + 16, Math.min(card.right - BITE.width - 16, stands.right - 10))
    for (const node of [bite.current, piece.current]) Object.assign(node.style, { left: `${left}px`, top: `${card.top}px`, visibility: 'hidden' })
    const timers: ReturnType<typeof setTimeout>[] = []
    const at = (ms: number, run: () => void): void => { timers.push(setTimeout(run, ms)) }
    const animations: Animation[] = []
    const animate = (node: Element | null | undefined, frames: Keyframe[], options: KeyframeAnimationOptions): void => {
      const running = typeof node?.animate === 'function' ? node.animate(frames, options) : undefined
      if (running) animations.push(running)
    }
    // Over his head, the piece's foot at his fists.
    const hands = { x: stands.left + 41 - BITE.width / 2 - left, y: stands.top - 6 - card.top }
    const lifted = `translate(${hands.x}px, ${hands.y}px) rotate(-8deg)`
    const grow = Math.min(9, (window.innerWidth * 0.45) / BITE.width)
    const centre = { x: window.innerWidth / 2 - BITE.width / 2 - left, y: window.innerHeight / 2 - BITE.height / 2 - card.top }
    at(RIP_AT, () => {
      bite.current!.style.visibility = 'visible'
      piece.current!.style.visibility = 'visible'
      animate(piece.current, [{ transform: 'none' }, { transform: lifted }], { duration: 260, easing: 'ease-out', fill: 'forwards' })
    })
    at(HURL_AT, () => animate(piece.current, [{ transform: `${lifted} scale(1)` },
      { transform: `translate(${centre.x}px, ${centre.y}px) rotate(14deg) scale(${grow})` }], { duration: SHATTER_AT - HURL_AT, easing: 'cubic-bezier(.5, 0, .9, .6)', fill: 'forwards' }))
    at(SHATTER_AT, () => {
      piece.current!.style.visibility = 'hidden'
      shards.current.forEach((shard, index) => {
        const spray = scatter[index]!
        if (!shard) return
        Object.assign(shard.style, { left: `${window.innerWidth / 2 - spray.size / 2}px`, top: `${window.innerHeight / 2 - spray.size / 2}px`, visibility: 'visible' })
        animate(shard, [{ transform: 'none', opacity: 1 },
          { transform: `translate(${Math.cos(spray.angle) * spray.distance}px, ${Math.sin(spray.angle) * spray.distance + 160}px) rotate(${spray.spin}deg)`, opacity: 0 }],
        { duration: spray.duration, easing: 'cubic-bezier(.2, .6, .4, 1)', fill: 'forwards' })
      })
      animate(cracks.current, [{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], { duration: 900, easing: 'ease-out', fill: 'forwards' })
    })
    // The composer grows back over the bite, one small square at a time.
    at(REFORM_AT, () => bite.current?.querySelectorAll<HTMLElement>('.lardo-bite__cell').forEach((cell, index) =>
      animate(cell, [{ opacity: 0 }, { opacity: 1 }], { duration: 1, delay: cells[index]!.delay, fill: 'forwards' })))
    at(REFORM_AT + REFORM_FOR + 40, () => { bite.current!.style.visibility = 'hidden' })
    // The bite stays in the composer's top edge however the composer moves or grows while he throws.
    let follow = 0
    const keepInEdge = (): void => {
      const now = composer.getBoundingClientRect()
      const edge = Math.max(now.left + 16, Math.min(now.right - BITE.width - 16, left + now.left - card.left))
      if (bite.current) Object.assign(bite.current.style, { left: `${edge}px`, top: `${now.top}px` })
      follow = requestAnimationFrame(keepInEdge)
    }
    follow = requestAnimationFrame(keepInEdge)
    return () => {
      cancelAnimationFrame(follow)
      timers.forEach(clearTimeout)
      animations.forEach(animation => animation.cancel())
    }
  }, [actor, scatter, cells])
  return createPortal(<div className="lardo-throw" aria-hidden="true">
    <div className="lardo-bite" ref={bite}>
      {cells.map((cell, index) => <i key={index} className="lardo-bite__cell" style={{ left: cell.x, top: cell.y }} />)}
    </div>
    <div className="lardo-piece" ref={piece} />
    {scatter.map((spray, index) => <div key={index} className="lardo-shard" ref={node => { shards.current[index] = node }} style={{ width: spray.size, height: spray.size }} />)}
    <svg className="lardo-cracks" ref={cracks} viewBox="-50 -50 100 100" preserveAspectRatio="xMidYMid meet" focusable="false">
      <path d="M0 0L-9 -14L-12 -26L-22 -38M-9 -14L-20 -12L-34 -18M0 0L12 -9L26 -12L40 -24M12 -9L18 4L33 10M0 0L6 13L4 27L13 42M6 13L-6 22L-15 36M0 0L-14 4L-28 1L-44 8M-14 4L-22 16" />
      <path d="M-6 -4L4 -6L7 5L-3 8Z" />
    </svg>
  </div>, document.body)
}
