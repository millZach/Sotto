import React, { useRef, type ReactNode } from 'react'
import { ClaudeBotSprite, paintBot, pixelPath, useBotParts } from './claudeBotSprite'
import { usePixelLoop } from './pixelLoop'

/** A small agent: Claude bot at a third of the size on a 12 × 10 grid, its body in the same 4:3 box, eyes toward the left it walks to. */
const MINI_ROWS: readonly string[] = [
  '.....a......',
  '.....l......',
  '...hhhhhh...',
  '..hhbbbbbl..',
  '..hkbbkbbl..',
  '.bhkbbkbblb.',
  '.bhbbbbbblb.',
  '...llllll...',
]
const MINI_PATHS = Object.fromEntries(['a', 'b', 'h', 'l', 'k'].map(ch => [ch, pixelPath(MINI_ROWS, ch)])) as Record<string, string>
/** Legs at x 3 and 6. A planted leg is a shaft and a foot; a lifted one is only its foot, tucked a unit up. */
const MINI_LEG_X = [3, 6] as const
const miniLegs = (lifted: number): string => MINI_LEG_X.map((x, index) => index === lifted ? '' : `M${x} 8h2v1h-2z`).join(' ').trim()
const miniFeet = (lifted: number): string => MINI_LEG_X.map((x, index) => `M${x} ${index === lifted ? 8 : 9}h2v1h-2z`).join(' ')
const MINI_WIDTH = 24
/** No more small agents than the track can show without crowding it; the readout carries the real count. */
const MAX_WORKING_MINIS = 6

/**
 * Claude bot stood at the readout end facing the room, sending small agents out along the track: one per task the
 * provider says is still running, filing off the left edge on a loop while the near arm waves them on. Same schedule,
 * spacing and reduced-motion stance as Sotto's working creature; under reduced motion they stand spaced along the track.
 */
export function ClaudeBotWorking({ agents }: { readonly agents: number }): ReactNode {
  const actor = useRef<HTMLDivElement>(null)
  const parts = useBotParts()
  const minis = useRef<(HTMLDivElement | null)[]>([])
  const legs = useRef<(SVGPathElement | null)[]>([])
  const feet = useRef<(SVGPathElement | null)[]>([])
  const count = Math.min(MAX_WORKING_MINIS, Math.max(1, agents))
  usePixelLoop(actor, ({ time, still, width }) => {
    const reach = Math.max(0, width - 80)
    if (actor.current) actor.current.style.transform = `translateX(${Math.round(reach / 2) * 2}px)`
    // A mini leaves from under the raised arm and walks until it is past the track's clipped left edge.
    const start = Math.max(0, width - 96), span = start + MINI_WIDTH
    // Held still, they stand in a line a step apart: a stride clear of each other where the track allows,
    // closing up on the narrowest track so the last never falls off the end.
    const stride = Math.min(MINI_WIDTH + 12, Math.max(0, start - 12) / count)
    minis.current.forEach((mini, index) => {
      if (!mini) return
      const x = still ? Math.max(0, start - 12 - index * stride) : start - span * ((time * 0.09 + index * 0.17) % 1)
      const stepping = !still && Math.floor(time * 6 + index) % 2 === 1
      mini.style.transform = `translate(${Math.round(x / 2) * 2}px, ${stepping ? -1 : 0}px)`
      // The legs trade places on the bob's beat; held still, both stand.
      const lifted = still ? -1 : stepping ? 0 : 1
      legs.current[index]?.setAttribute('d', miniLegs(lifted))
      feet.current[index]?.setAttribute('d', miniFeet(lifted))
    })
    // Facing the room, so its right hand is the near one, waving them on. The spark turns quicker than at rest.
    parts.facing.current?.setAttribute('transform', 'translate(33 0) scale(-1 1)')
    paintBot(parts, still ? { look: 1 } : {
      bob: Math.floor(time * 1.2) % 2 === 1,
      eyes: time % 5 > 4.86 ? 'blink' : 'open',
      look: 1,
      spark: Math.floor(time * 2) % 2 === 1,
      glow: time % 2 < 0.5,
      sway: Math.floor(time * 2) % 2 ? 1 : 0,
      handR: Math.floor(time * 2) % 2,
    })
  }, count)
  return <>
    {/* Drawn before the bot, so each one steps out from behind it rather than across it. */}
    {Array.from({ length: count }, (_, index) => <div key={index} className="thread-monitor__mini" aria-hidden="true"
      ref={node => { minis.current[index] = node }}>
      <svg viewBox="0 0 12 10" width="24" height="20" focusable="false" shapeRendering="crispEdges">
        <path ref={node => { legs.current[index] = node }} className="bot-l" d={miniLegs(-1)} />
        <path ref={node => { feet.current[index] = node }} className="bot-d" d={miniFeet(-1)} />
        <path className="bot-b" d={MINI_PATHS.b} />
        <path className="bot-h" d={MINI_PATHS.h} />
        <path className="bot-l" d={MINI_PATHS.l} />
        <path className="bot-k" d={MINI_PATHS.k} />
        <path className="bot-a" d={MINI_PATHS.a} />
      </svg>
    </div>)}
    <div className="thread-monitor__actor" ref={actor} aria-hidden="true">
      <svg className="thread-monitor__creature" viewBox="0 0 40 32" width="80" height="64" focusable="false" shapeRendering="crispEdges">
        <ClaudeBotSprite parts={parts} />
      </svg>
    </div>
  </>
}
