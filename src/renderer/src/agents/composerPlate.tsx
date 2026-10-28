import React, { type ReactNode } from 'react'
import { ArrowUp, CornerDownRight, ListPlus } from 'lucide-react'

/** What a composer button does, which picks its glyph (ADR-0153, as amended by Drake's pick 2.2 of
 *  docs/prototypes/prompt-send-refine-2.html, kept at the tag prototype/prompt-send-refine-2). */
export type PlateRole = 'send' | 'queue' | 'stop' | 'steer'

const GLYPHS = { send: ArrowUp, queue: ListPlus, steer: CornerDownRight } as const

/** A button's glyph and the key that does the same, the key cap drawn as a key. The full name stays in the button's label. */
export function KeyedGlyph({ role, keyCap }: { readonly role: PlateRole; readonly keyCap: string | null }): ReactNode {
  const Glyph = role === 'stop' ? null : GLYPHS[role]
  return <>{Glyph === null
    ? <svg className="thread-prompt__glyph" width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x=".5" y=".5" width="11" height="11" rx="2.5" /></svg>
    : <Glyph className="thread-prompt__glyph" size={14} strokeWidth={2.5} aria-hidden="true" />}
    {keyCap ? <kbd className="thread-prompt__key" aria-hidden="true">{keyCap}</kbd> : null}</>
}

// The app's arrival curve and the copy confirm's spring; every move is 120 to 240 ms.
const OUT = 'cubic-bezier(.2, .8, .2, 1)'
const SPRING = 'cubic-bezier(.2, .9, .3, 1.3)'
const systemCalm = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null

function play(element: Element | null | undefined, frames: Keyframe[], options: KeyframeAnimationOptions): void {
  if (element instanceof HTMLElement || element instanceof SVGElement) if (typeof element.animate === 'function') element.animate(frames, options)
}

/** Nothing here moves under reduced motion, the system's or the app's own setting. */
function moving(): boolean {
  return document.documentElement.dataset.reducedMotion !== 'on' && systemCalm?.matches !== true
}

/** A send: the plate's glyph rises out as the words go and the next settles in (120 ms out, 200 ms in). From the keyboard
 *  the plate also takes the press a click gives it (80 ms down, 220 ms back on the spring). */
export function plateSent(row: HTMLElement | null, fromKeyboard: boolean): void {
  const plate = row?.querySelector('.thread-prompt__send')
  if (!plate || !moving()) return
  play(plate.querySelector('.thread-prompt__glyph'), [
    { transform: 'none', opacity: 1, easing: 'ease-in' }, { transform: 'translateY(-9px)', opacity: 0, offset: .375 },
    { transform: 'scale(.6)', opacity: 0, offset: .376, easing: OUT }, { transform: 'none', opacity: 1 },
  ], { duration: 320 })
  if (fromKeyboard) play(plate, [{ transform: 'none', easing: 'ease-out' }, { transform: 'scale(.94)', offset: .27, easing: SPRING }, { transform: 'none' }], { duration: 300 })
}

/** The row's moves when the turn starts, when typing during it brings Queue, and back: the new plate's glyph settles in,
 *  Stop's trace fades up, and Stop and Steer step out of the plate's side. `aside` keeps how far Stop stepped. */
export function rowMoved(row: HTMLElement | null, from: PlateRole, to: PlateRole, aside: { width: number }): void {
  if (!row || !moving()) return
  const stop = row.querySelector('.thread-prompt__stop'), plate = row.lastElementChild
  play(plate?.querySelector('.thread-prompt__glyph'), [{ transform: 'scale(.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 200, delay: 40, easing: OUT, fill: 'backwards' })
  if (from === 'send' && to === 'stop') play(stop?.querySelector('.thread-prompt__trace'), [{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' })
  if (from === 'stop' && to === 'queue' && plate instanceof HTMLElement) {
    aside.width = plate.offsetWidth + (parseFloat(getComputedStyle(row).columnGap) || 0)
    play(stop, [{ transform: `translateX(${aside.width}px)` }, { transform: 'none' }], { duration: 200, easing: OUT })
    play(row.querySelector('.thread-prompt__steer'), [{ transform: `translateX(${aside.width}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 200, delay: 40, easing: OUT, fill: 'backwards' })
  }
  if (from === 'queue' && to === 'stop' && aside.width > 0) play(stop, [{ transform: `translateX(${-aside.width}px)` }, { transform: 'none' }], { duration: 200, easing: OUT })
}
