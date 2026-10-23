import React, { useRef, type ReactNode } from 'react'
import { BOT_EMPTY_PATH, ClaudeBotSprite, paintBot, useBotParts } from './claudeBotSprite'
import { usePixelLoop } from './pixelLoop'

/**
 * Where the glass sits, in the right hand's own units (the arm at rest, x 28-31, y 19-24), so it rises and swings with
 * `handR`. Walking it is carried upright beside the head; inspecting it is held level in front of the right eye, the
 * hand raised to face height. Both stay inside x 0-33, so the mirrored walk back keeps it in the 40 × 32 box.
 */
const CARRIED = 'translate(24 7)'
const RAISED = 'translate(18 14)'
const RAISE = 5
/** Upright, the handle runs down into the fist; level, a stub of it reaches right into the raised fist. */
const CARRIED_HANDLE = 'M4 9h2v4H4z'
const RAISED_HANDLE = 'M9 5h2v2H9z'
/** The eye seen through the lens, a size up from the real one it covers (the lens's own glint catches its corner), or shut to a line. */
const BIG_EYE = 'M3 2h3v6H3z'
const BIG_EYE_SHUT = 'M3 6h3v1H3z'

/** Original pixel art: Claude bot walks the track with a magnifying glass, as Sotto's creature does, and peers through it at the far end. */
export function ClaudeBotMonitoring(): ReactNode {
  const actor = useRef<HTMLDivElement>(null)
  const glass = useRef<SVGGElement>(null)
  const handle = useRef<SVGPathElement>(null)
  const eye = useRef<SVGPathElement>(null)
  const parts = useBotParts()
  usePixelLoop(actor, ({ time, still, width }) => {
    // Sotto's schedule: out 4 s, inspect 5 s, back 4 s, a second's rest at the start.
    const reach = Math.max(0, width - 80), phase = time % 14
    let x = reach, direction = 1, walking = false
    if (!still) {
      if (phase < 4) { x = reach * phase / 4; walking = true }
      else if (phase < 9) x = reach
      else if (phase < 13) { x = reach * (1 - (phase - 9) / 4); direction = -1; walking = true }
      else { x = 0; direction = -1 }
    }
    // The glass comes up a beat after arriving and goes down a beat before leaving, so the hand visibly lifts it.
    const inspecting = still || (phase >= 4.2 && phase < 8.8)
    const lifting = !still && !inspecting && phase >= 4 && phase < 9
    const step = Math.floor(time * 7) % 4
    const blink = !still && time % 5 > 4.86
    // While peering it leans in, and now and then eases back a unit and in again; the glass and the eye behind it go together.
    const leaning = still || [1, 1, 0, 1][Math.floor(time / 1.1) % 4] === 1
    const swing = walking ? [-1, 0, 1, 0][step]! : 0
    if (actor.current) actor.current.style.transform = `translateX(${Math.round(x / 2) * 2}px)`
    parts.facing.current?.setAttribute('transform', direction < 0 ? 'translate(33 0) scale(-1 1)' : '')
    paintBot(parts, {
      walking,
      step,
      bob: walking ? step % 2 === 1 : inspecting && leaning,
      eyes: blink ? 'blink' : 'open',
      look: walking || inspecting ? 1 : 0,
      spark: !still && Math.floor(time) % 2 === 1,
      glow: !still && time % 2.4 < 0.5,
      // The bulb lags behind the walk, and drifts on its own while the bot stands.
      sway: still ? 0 : walking ? (step === 1 ? 0 : -1) : ([0, 1, 0, -1] as const)[Math.floor(time / 0.9) % 4]!,
      handL: -swing,
      handR: inspecting ? RAISE : lifting ? 2 : swing,
    })
    glass.current?.setAttribute('transform', inspecting ? RAISED : CARRIED)
    handle.current?.setAttribute('d', inspecting ? RAISED_HANDLE : CARRIED_HANDLE)
    eye.current?.setAttribute('d', inspecting ? blink ? BIG_EYE_SHUT : BIG_EYE : BOT_EMPTY_PATH)
  })
  return <div className="thread-monitor__actor" ref={actor} aria-hidden="true">
    <svg className="thread-monitor__creature" viewBox="0 0 40 32" width="80" height="64" focusable="false" shapeRendering="crispEdges">
      <ClaudeBotSprite parts={parts}>
        <g ref={glass} transform={RAISED}>
          <path ref={handle} className="thread-monitor__handle" d={RAISED_HANDLE} />
          <path className="thread-monitor__color" opacity=".28" d="M1 1h7v7H1z" />
          <path ref={eye} className="bot-k" d={BIG_EYE} />
          <path className="thread-monitor__shine" d="M2 0h5v1H2z M2 8h5v1H2z M0 2h1v5H0z M8 2h1v5H8z M1 1h1v1H1z M7 1h1v1H7z M1 7h1v1H1z M7 7h1v1H7z M2 2h2v1H2z" />
        </g>
        {/* The fist, drawn again over the handle so the hand holds it rather than the handle crossing the hand. */}
        <path className="bot-b" d="M28 19h3v5h-3z" />
        <path className="bot-h" d="M28 19h3v1h-3z" />
        <path className="bot-l" d="M28 23h3v1h-3z" />
      </ClaudeBotSprite>
    </svg>
  </div>
}
