import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { prefersReducedMotion } from '../state/reducedMotion'

/** One held gap: how tall the settled row stood, and whether it is closing. */
export interface HeldGap { readonly height: number; readonly closing: boolean }

/** How long the gap takes to close with motion; under reduced motion it goes at once. */
export const GAP_CLOSE_MS = 160
/** How often a held gap asks whether the pointer is still over the list, should its leave never have been heard. */
export const GAP_CHECK_MS = 3_000

const NO_GAPS: ReadonlyMap<string, HeldGap> = new Map()

/**
 * The held gap (ADR-0167, Zach's pick B of #1826): a Settle pressed with the pointer leaves its row's place empty while
 * the pointer stays over the list, so the next row's Settle does not slide under a still pointer and a second click lands
 * on nothing. It is the pointer's protection alone: a Settle from the keyboard holds nothing, and the focus moves on as
 * the thread list moves it (ADR-0164). Every gap closes once the pointer leaves the list, or, should that leave go
 * unheard, at the next look that finds the pointer elsewhere. It lives in the renderer and costs main nothing.
 *
 * `area` is the element the pointer is over the list in: the sidebar's scroll area, found from the list.
 */
export function useSettleGaps(list: RefObject<HTMLElement | null>): {
  readonly gaps: ReadonlyMap<string, HeldGap>
  /** Holds the place of the row about to be settled, when a pointer pressed it over the list; answers whether it did. */
  readonly hold: (threadId: string, row: HTMLElement | null) => boolean
  /** Lets one gap go at once: its settle was refused, or its thread came back. */
  readonly drop: (threadId: string) => void
} {
  const [gaps, setGaps] = useState<ReadonlyMap<string, HeldGap>>(NO_GAPS)
  /** What the last press was: a pointer's, or a key's. Only a pointer's Settle holds a gap. */
  const lastInput = useRef<'pointer' | 'keyboard'>('keyboard')
  useEffect(() => {
    const pointer = (): void => { lastInput.current = 'pointer' }
    const key = (): void => { lastInput.current = 'keyboard' }
    window.addEventListener('pointerdown', pointer, true)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('pointerdown', pointer, true); window.removeEventListener('keydown', key, true) }
  }, [])
  const area = useCallback((): HTMLElement | null => list.current?.closest<HTMLElement>('.thread-nav__scroll') ?? list.current, [list])
  const pointerOver = useCallback((): boolean => area()?.matches(':hover') === true, [area])
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(closing.current), [])
  const close = useCallback((): void => {
    clearTimeout(closing.current)
    if (prefersReducedMotion()) { setGaps(NO_GAPS); return }
    setGaps(current => current.size === 0 ? current : new Map([...current].map(([id, gap]) => [id, { ...gap, closing: true }])))
    closing.current = setTimeout(() => setGaps(current => {
      const left = [...current].filter(([, gap]) => !gap.closing)
      return left.length === current.size ? current : left.length ? new Map(left) : NO_GAPS
    }), GAP_CLOSE_MS)
  }, [])
  const holding = gaps.size > 0
  useEffect(() => {
    const element = area()
    if (!holding || element === null) return undefined
    const look = window.setInterval(() => { if (!pointerOver()) close() }, GAP_CHECK_MS)
    element.addEventListener('pointerleave', close)
    return () => { window.clearInterval(look); element.removeEventListener('pointerleave', close) }
  }, [holding, area, pointerOver, close])
  const hold = useCallback((threadId: string, row: HTMLElement | null): boolean => {
    if (row === null || lastInput.current !== 'pointer' || !pointerOver()) return false
    // A swarm's lead lists its angles under its row, and they settle with it, so their room is held too.
    const angles = row.nextElementSibling instanceof HTMLElement && row.nextElementSibling.classList.contains('thread-swarm') ? row.nextElementSibling : null
    const height = row.getBoundingClientRect().height + (angles?.getBoundingClientRect().height ?? 0)
    setGaps(current => new Map([...current, [threadId, { height, closing: false }]]))
    return true
  }, [pointerOver])
  const drop = useCallback((threadId: string): void => {
    setGaps(current => {
      if (!current.has(threadId)) return current
      const left = [...current].filter(([id]) => id !== threadId)
      return left.length ? new Map(left) : NO_GAPS
    })
  }, [])
  return { gaps, hold, drop }
}
