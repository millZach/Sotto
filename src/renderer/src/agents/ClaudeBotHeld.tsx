import React, { useRef, type ReactNode } from 'react'
import { ClaudeBotSprite, paintBot, useBotParts } from './claudeBotSprite'
import { BOTTOM_ROWS, EMPTY_PATH, GLASS_FLIP, GLASS_PERIOD, grainPath, HOURGLASS_CENTRE, HOURGLASS_OUTLINE, HOURGLASS_VESSEL, sandPath, TOP_ROWS } from './hourglass'
import { usePixelLoop } from './pixelLoop'

/** The right hand is raised this far (the arm then spans y 12-16), so it fits the glass's waist between the two chambers. */
const HAND = 7
/**
 * The glass stays in its own units (x 30-36), clear of the body and the face, where a full turn about its centre still fits
 * the 40-unit box; it only follows the breath.
 */
const glassAt = (bob: boolean): string => bob ? 'translate(0 -1)' : ''

/**
 * Claude bot stood still, holding an hourglass out in its right hand: Sotto's held pose, the same timing and the
 * same stance under reduced motion. It says only that time is passing on work the thread started.
 */
export function ClaudeBotHeld(): ReactNode {
  const parts = useBotParts()
  const actor = useRef<HTMLDivElement>(null)
  const holder = useRef<SVGGElement>(null)
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
    const bob = !still && Math.floor(time * 1.2) % 2 === 1
    paintBot(parts, still ? { handR: HAND } : {
      bob,
      eyes: time % 5 > 4.86 ? 'blink' : 'open',
      // A glance at the glass now and then, and while it turns.
      look: time % 9 > 6.5 || spin > 0 ? 1 : 0,
      spark: Math.floor(time / 1.5) % 2 === 1,
      glow: time % 3 < 0.6,
      handR: HAND,
    })
    // The glass is drawn before the bot (so its turning group is the first nested group), so it follows the breath itself.
    holder.current?.setAttribute('transform', glassAt(bob))
    // The rotation only ever runs during the flip, and never carries over: the sand rows live in the rotated group, so a
    // half turn that outlasted the flip would empty the chamber the reader sees filling, and the sand would climb.
    glass.current?.setAttribute('transform', `rotate(${spin * 180} ${HOURGLASS_CENTRE})`)
    topSand.current?.setAttribute('d', sandPath(TOP_ROWS.slice(gone)))
    bottomSand.current?.setAttribute('d', sandPath(BOTTOM_ROWS.slice(3 - gone)))
    grain.current?.setAttribute('d', drain < 1 && !still ? grainPath(time) : EMPTY_PATH)
  })
  return <div className="thread-monitor__actor" ref={actor} aria-hidden="true">
    <svg className="thread-monitor__creature" viewBox="0 0 40 32" width="80" height="64" focusable="false" shapeRendering="crispEdges">
      <g ref={holder} transform={glassAt(false)}>
        <g ref={glass}>
          <path className="thread-monitor__color" opacity=".28" d={HOURGLASS_VESSEL} />
          <path ref={topSand} className="thread-monitor__color thread-monitor__sand" d={sandPath(TOP_ROWS)} />
          <path ref={bottomSand} className="thread-monitor__color thread-monitor__sand" d={EMPTY_PATH} />
          <path ref={grain} className="thread-monitor__color" d={EMPTY_PATH} />
          {/* Caps and tapering walls last, so the outline holds the shape against the surface. */}
          <path className="thread-monitor__shine" d={HOURGLASS_OUTLINE} />
        </g>
      </g>
      <ClaudeBotSprite parts={parts}>
        {/* The fingers closing on the glass's neck, in the arm's own (lowered) units; they rise with the arm. */}
        <path className="bot-b" d="M31 20h1v3h-1z" />
      </ClaudeBotSprite>
    </svg>
  </div>
}
