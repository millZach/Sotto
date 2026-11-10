// PROTOTYPE, throwaway. The real owlFamily.ts, whole, with one function replaced: the glyphs a thread owl is drawn
// with. The real painter imports this in place of owlFamily.ts (build.mjs), so it draws the prototype's extra poses
// with no change to its own code. With every idea switched off this returns the real glyphs.
export * from '@w/owlFamily'
import { owlGlyphs as realGlyphs, type ThreadOwlPose } from '@w/owlFamily'
import { fidgetOf, has, LIFE, threadOf } from './life'

const BODY = '/)__)', BODY_TURNED = '(__(\\', BODY_RUFFLED = '/)~~)'
const FEET = ' " " ', FEET_UP = " ' ' "

/** Five glyphs wide, as the real owl is. */
const five = (eyes: string, body = BODY, feet = FEET): string[] => [`{${eyes[0]},${eyes[1] ?? eyes[0]}}`, body, feet]
/** Seven wide, a wing either side of the face; its middle five fall where the five-wide owl's do. */
const seven = (left: string, eyes: string, right: string, feet = FEET): string[] => [`${left}{${eyes},${eyes}}${right}`, ` ${BODY} `, ` ${feet} `]

export function owlGlyphs(pose: Pick<ThreadOwlPose, 'flying' | 'owl'>, t: number, options: { readonly rail: boolean; readonly still: boolean }): string[] {
  const real = realGlyphs(pose, t, options)
  if (options.rail || options.still || pose.flying || LIFE.flags.size === 0) return real
  const owl = pose.owl, thread = threadOf(owl.key)
  const act = LIFE.acts.get(owl.key), acting = act !== undefined && t >= act.t0 && t < act.t0 + act.dur ? act : null
  const step = Math.floor(t * 4) % 2 === 1

  // A thread whose last turn failed winces, feathers ruffled.
  if (thread?.state === 'failed' && has('fidget')) return five('><', BODY_RUFFLED)
  // Waiting on you: it waves one wing, then the other.
  if (owl.mood === 'waiting') {
    if (!has('wave')) return real
    const beat = Math.floor(t * 3) % 4
    return beat === 0 ? seven('\\', 'O', ' ') : beat === 2 ? seven(' ', 'O', '/') : seven(' ', 'O', ' ')
  }
  if (acting?.kind === 'happy') return five('^^', BODY, step ? FEET_UP : FEET)
  if (acting?.kind === 'wake') {
    const k = (t - acting.t0) / acting.dur
    return k < 0.3 ? five('-o') : k < 0.75 ? seven('\\', 'o', '/') : five('oo')
  }
  if (acting?.kind === 'hop') return five(owl.mood === 'asleep' ? '--' : 'oo', BODY, FEET_UP)
  if (acting?.kind === 'lookup') return five('°°')
  if (owl.mood !== 'awake' || !has('fidget')) return real
  // Working: it watches Watcher's owl fly over, and between times looks down at its work, turns round or stretches.
  if (LIFE.watcherFlying) return five('°°')
  const { roll, into } = fidgetOf(owl.order, t)
  if (roll <= 2 && into < 1.8) return five('..', BODY, step ? ' ". ' + ' ' : FEET)
  if (roll === 3) return five('oo', BODY_TURNED)
  if (roll === 4 && into < 0.8) return seven('\\', 'o', '/')
  if (roll === 5 && into < 1.2) return five('°°')
  if (roll === 6 && into < 0.28) return five('oo', BODY, FEET_UP)
  return real
}
