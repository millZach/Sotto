import React, { createRef, useState, type ReactNode, type RefObject } from 'react'

/**
 * Claude bot, the second creature (the `creature` setting). Original pixel art on the grid Sotto's own creature uses, 40 × 32
 * units at two pixels a unit (80 × 64), so it stands on the same track and a pose swaps one for the other without moving
 * anything: a front-facing bot with an antenna, two arms and four legs. Its right hand, the arm at x 28-31, carries each pose's
 * prop. Every pose draws it through `ClaudeBotSprite` and moves it through `paintBot`, so the four read as one character the
 * way Sotto's creature's poses share `BODY`. The art is written as rows of letters, one per unit, so it reads like the picture
 * it is: b body, h highlight, l shade.
 */

/** The path of every `ch` in `rows`: one rectangle per run of units, with runs of the same width on neighbouring rows merged. */
export function pixelPath(rows: readonly string[], ch: string, ox = 0, oy = 0): string {
  const boxes: { x: number; y: number; w: number; h: number }[] = []
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      if (row[x] !== ch) { x += 1; continue }
      let end = x
      while (row[end] === ch) end += 1
      const above = boxes.find(box => box.x === x && box.w === end - x && box.y + box.h === y)
      if (above) above.h += 1
      else boxes.push({ x, y, w: end - x, h: 1 })
      x = end
    }
  })
  return boxes.map(({ x, y, w, h }) => `M${x + ox} ${y + oy}h${w}v${h}h-${w}z`).join(' ')
}

/** A path that draws nothing, for an eye shape or a glint that is not showing. */
export const BOT_EMPTY_PATH = 'M0 0h0v0z'

/** The body, 23 × 18 units at (5, 10). Light falls from the top left, so the right and the bottom are in shade. */
export const BOT_BODY_ROWS: readonly string[] = [
  '..hhhhhhhhhhhhhhhhhhh..',
  '.hhhhhhhhhhhhhhhhhhhhb.',
  'hhbbbbbbbbbbbbbbbbbbbbl',
  'hbbbbbbbbbbbbbbbbbbbbbl',
  'hbbbbbbbbbbbbbbbbbbbbbl',
  'hbbbbbbbbbbbbbbbbbbbbbl',
  'hbbbbbbbbbbbbbbbbbbbbbl',
  'hbbbbbbbbbbbbbbbbbbbbbl',
  'hbbbbbbbbbbbbbbbbbbbbbl',
  'hbbbbbbbbbbbbbbbbbbbbbl',
  'hbbbbbbbbbbbbbbbbbbbbbl',
  'hbbbbbbbbbbbbbbbbbbbbbl',
  'hbbbbbbbbbbbbbbbbbbbbbl',
  'hbbbbbbbbbbbbbbbbbbbbbl',
  'hbbbbbbbbbbbbbbbbbbbbbl',
  'lbbbbbbbbbbbbbbbbbbbbbl',
  '.lllllllllllllllllllll.',
  '..lllllllllllllllllll..',
]
const BODY_PATHS = { b: pixelPath(BOT_BODY_ROWS, 'b', 5, 10), h: pixelPath(BOT_BODY_ROWS, 'h', 5, 10), l: pixelPath(BOT_BODY_ROWS, 'l', 5, 10) }

/**
 * Where each of the four legs stands (left edge), and which are off the ground on each frame of the gait: a trot. The legs are
 * as even about the bot's centre (x 16.5) as the body is, so turning the whole bot round moves nothing but the prop.
 */
const LEG_X = [7, 11, 19, 23] as const
const GAIT = [[1, 0, 0, 1], [0, 0, 0, 0], [0, 1, 1, 0], [0, 0, 0, 0]] as const
/** Legs start under the body (y 27) so the body can rise a unit without a gap showing; a lifted leg ends a unit higher. */
const legsPath = (lifted: readonly number[]): string => LEG_X.map((x, index) => `M${x} 27h3v${lifted[index] ? 4 : 5}h-3z`).join(' ')
const feetPath = (lifted: readonly number[]): string => LEG_X.map((x, index) => `M${x} ${lifted[index] ? 30 : 31}h3v1h-3z`).join(' ')

const EYE_X = [10, 21] as const
export type BotEyes = 'open' | 'blink' | 'rest'
/** Open: tall slots with a glint. Blink: shut to a line. Rest: half shut, as Sotto's creature rests. */
const eyesPath = (eyes: BotEyes, look: number): string =>
  EYE_X.map(x => eyes === 'open' ? `M${x + look} 12h2v5h-2z` : eyes === 'blink' ? `M${x + look} 15h2v1h-2z` : `M${x + look} 14h2v2h-2z`).join(' ')
const glintPath = (eyes: BotEyes, look: number): string =>
  eyes === 'open' ? EYE_X.map(x => `M${x + look} 12h1v1h-1z`).join(' ') : BOT_EMPTY_PATH
/** A smile when awake; flat at rest. */
const mouthPath = (eyes: BotEyes, look: number): string =>
  eyes === 'rest' ? `M${15 + look} 19h3v1h-3z` : `M${14 + look} 18h1v1h-1z M${15 + look} 19h3v1h-3z M${18 + look} 18h1v1h-1z`

/** The emblem on the chest, a 5 × 5 asterisk that turns between a plus and a cross, as a spinner does. */
const sparkPath = (cross: boolean): string => (cross
  ? [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [4, 0], [3, 1], [1, 3], [0, 4]]
  : [[2, 0], [2, 1], [0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [2, 3], [2, 4]]).map(([x, y]) => `M${14 + x!} ${22 + y!}h1v1h-1z`).join(' ')

/** What a pose can say about the bot on one frame. Everything is optional: the default is standing, eyes open. */
export interface BotState {
  /** Legs step, arms swing: set while the bot walks. */
  readonly walking?: boolean
  /** Gait frame, 0-3; read only while walking. */
  readonly step?: number
  /** The body, antenna and arms one unit up. Walking raises it on the passing frames; standing breathes with it. */
  readonly bob?: boolean
  readonly eyes?: BotEyes
  /** Eyes and smile one unit toward where the bot is looking; 0 at rest. */
  readonly look?: -1 | 0 | 1
  /** The chest emblem's frame: false is the plus, true the cross. */
  readonly spark?: boolean
  /** The antenna bulb: false in the theme's activity colour, true lit in the text colour. */
  readonly glow?: boolean
  /** The antenna bulb one unit sideways, a lagging sway. */
  readonly sway?: -1 | 0 | 1
  /** The hands, raised by this many units (negative lowers them). */
  readonly handL?: number
  readonly handR?: number
}

/** Every element a pose moves. Create once per pose with `useBotParts`, hand to `ClaudeBotSprite`, paint with `paintBot`. */
export interface BotParts {
  /** The whole bot, to mirror it (`translate(33 0) scale(-1 1)`) when it faces left. */
  readonly facing: RefObject<SVGGElement | null>
  readonly legs: RefObject<SVGPathElement | null>
  readonly feet: RefObject<SVGPathElement | null>
  readonly body: RefObject<SVGGElement | null>
  readonly bulb: RefObject<SVGGElement | null>
  readonly bulbFill: RefObject<SVGPathElement | null>
  readonly armL: RefObject<SVGGElement | null>
  readonly armR: RefObject<SVGGElement | null>
  readonly eyes: RefObject<SVGPathElement | null>
  readonly glints: RefObject<SVGPathElement | null>
  readonly mouth: RefObject<SVGPathElement | null>
  readonly spark: RefObject<SVGPathElement | null>
}

const createBotParts = (): BotParts => ({
  facing: createRef<SVGGElement>(), legs: createRef<SVGPathElement>(), feet: createRef<SVGPathElement>(),
  body: createRef<SVGGElement>(), bulb: createRef<SVGGElement>(), bulbFill: createRef<SVGPathElement>(),
  armL: createRef<SVGGElement>(), armR: createRef<SVGGElement>(), eyes: createRef<SVGPathElement>(),
  glints: createRef<SVGPathElement>(), mouth: createRef<SVGPathElement>(), spark: createRef<SVGPathElement>(),
})

/** One set of parts for the life of the pose: the same object on every render, so an effect keyed on it runs once. */
export function useBotParts(): BotParts {
  return useState(createBotParts)[0]
}

/** Puts the bot in `state`. Only writes attributes, so a frame loop can call it at 30 fps without rendering. */
export function paintBot(parts: BotParts, state: BotState = {}): void {
  const { walking = false, step = 0, bob = false, eyes = 'open', look = 0, spark = false, glow = false, sway = 0, handL = 0, handR = 0 } = state
  // Between steps unless it walks; a frame that is not a whole number counts as the one it falls in.
  const lifted = GAIT[walking && Number.isFinite(step) ? ((Math.floor(step) % 4) + 4) % 4 : 1]!
  parts.legs.current?.setAttribute('d', legsPath(lifted))
  parts.feet.current?.setAttribute('d', feetPath(lifted))
  parts.body.current?.setAttribute('transform', bob ? 'translate(0 -1)' : '')
  parts.bulb.current?.setAttribute('transform', sway === 0 ? '' : `translate(${sway} 0)`)
  parts.bulbFill.current?.setAttribute('class', glow ? 'bot-w' : 'bot-a')
  parts.armL.current?.setAttribute('transform', handL === 0 ? '' : `translate(0 ${-handL})`)
  parts.armR.current?.setAttribute('transform', handR === 0 ? '' : `translate(0 ${-handR})`)
  parts.eyes.current?.setAttribute('d', eyesPath(eyes, look))
  parts.glints.current?.setAttribute('d', glintPath(eyes, look))
  parts.mouth.current?.setAttribute('d', mouthPath(eyes, look))
  parts.spark.current?.setAttribute('d', sparkPath(spark))
}

/**
 * The bot itself, to sit inside a pose's 40 × 32 `<svg>`. `children` are the pose's prop, drawn in the same 40 × 32 space
 * on top of the body and carried by the right hand (they rise and fall with `handR`). Colours come from the `.bot-*`
 * classes in threadMonitor.css, which read the provider's own colour and ink through theme tokens.
 */
export function ClaudeBotSprite({ parts, children }: { readonly parts: BotParts; readonly children?: ReactNode }): ReactNode {
  const standing = GAIT[1]
  return <g ref={parts.facing}>
    <path ref={parts.legs} className="bot-l" d={legsPath(standing)} />
    <path ref={parts.feet} className="bot-d" d={feetPath(standing)} />
    <g ref={parts.body}>
      <path className="bot-l" d="M16 7h1v3h-1z" />
      <g ref={parts.bulb}>
        <path ref={parts.bulbFill} className="bot-a" d="M15 4h3v3h-3z" />
        <path className="bot-h" d="M15 4h1v1h-1z" />
      </g>
      <g ref={parts.armL}>
        <path className="bot-b" d="M2 19h3v5H2z" />
        <path className="bot-h" d="M2 19h3v1H2z" />
        <path className="bot-l" d="M2 23h3v1H2z" />
      </g>
      <path className="bot-b" d={BODY_PATHS.b} />
      <path className="bot-h" d={BODY_PATHS.h} />
      <path className="bot-l" d={BODY_PATHS.l} />
      <path ref={parts.eyes} className="bot-k" d={eyesPath('open', 0)} />
      <path ref={parts.glints} className="bot-h" d={glintPath('open', 0)} />
      <path ref={parts.mouth} className="bot-k" d={mouthPath('open', 0)} />
      <path ref={parts.spark} className="bot-d" d={sparkPath(false)} />
      <g ref={parts.armR}>
        <path className="bot-b" d="M28 19h3v5h-3z" />
        <path className="bot-h" d="M28 19h3v1h-3z" />
        <path className="bot-l" d="M28 23h3v1h-3z" />
        {children}
      </g>
    </g>
  </g>
}
