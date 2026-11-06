import { useLayoutEffect, type RefObject } from 'react'

import { prefersReducedMotion } from '../state/reducedMotion'

/** The places a scroll of the thread list comes to rest, as threadSidebar.css names them. */
const RESTS = '.thread-folder, .thread-nav__settled, .thread-folder__rows > :is(.thread-nav__row, .thread-nav__gap)'
/** A row's place lies a head's depth down; these rest at the band. */
const AT_BAND = '.thread-folder, .thread-nav__settled'
/** How near a place, in pixels, a scroll counts as resting on it. */
const ON_PLACE = 1

/**
 * How much room the list's end needs so that the furthest it can scroll is a place to rest. `end` is how far the list
 * scrolls with no room, `rests` the scroll at which each place rests. A list that does not scroll, or whose end already
 * rests on a place, needs none; otherwise the room reaches the first place beyond the end. Without it the end would be a
 * resting scroll of its own, and the row under the stuck head there would rest cut through.
 */
export function endRoom(end: number, rests: readonly number[]): number {
  if (end <= 0) return 0
  let next = Number.POSITIVE_INFINITY
  for (const rest of rests) {
    if (Math.abs(rest - end) < 0.5) return 0
    if (rest > end && rest < next) next = rest
  }
  return Number.isFinite(next) ? Math.ceil(next - end) : 0
}

/**
 * Where a scroll that came to rest at `at` settles, or null where it already rests on a place. It goes on to the next place
 * the way it was moving (`way`, 1 down and -1 up), so a scroll shorter than a row still moves the list a row rather than
 * springing back to where it was; with no way known, or nothing further that way, it takes the nearest place. `rests` are
 * the places' scrolls, the list's top among them, and `end` the furthest the list scrolls.
 */
export function settleAt(at: number, way: number, rests: readonly number[], end: number): number | null {
  const places = rests.filter(rest => rest >= -ON_PLACE && rest <= end + ON_PLACE)
  const [first] = places
  if (first === undefined || places.some(rest => Math.abs(rest - at) < ON_PLACE)) return null
  let ahead: number | null = null
  let nearest = first
  for (const rest of places) {
    if (Math.abs(rest - at) < Math.abs(nearest - at)) nearest = rest
    if (way > 0 && rest > at && (ahead === null || rest < ahead)) ahead = rest
    if (way < 0 && rest < at && (ahead === null || rest > ahead)) ahead = rest
  }
  return Math.min(Math.max(ahead ?? nearest, 0), end)
}

/**
 * Lets the thread list come to rest on a row's edge. When a scroll ends between places it goes on to the next one the
 * way it was moving, smoothly unless motion is reduced; and it keeps the list's end room (`--list-end-room`) as the list
 * stands, on a resize of the list or of anything in it at most once a frame, so the furthest scroll is a place too. It
 * reads where the places lie and writes one style property and a scroll; it renders nothing.
 */
export function useListEndRoom(scroll: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const list = scroll.current
    if (list === null || typeof ResizeObserver === 'undefined') return undefined
    let frame = 0
    let room = 0
    /** The scroll at which each place in view of the layout rests, the list's top first. */
    const rests = (): number[] => {
      const style = getComputedStyle(list)
      const padding = Number.parseFloat(style.scrollPaddingTop) || 0
      const top = list.getBoundingClientRect().top - list.scrollTop
      const places = [...list.querySelectorAll<HTMLElement>(RESTS)].filter(place => place.getClientRects().length > 0)
      if (places.length === 0) return []
      const row = places.find(place => !place.matches(AT_BAND))
      const depth = row === undefined ? 0 : Number.parseFloat(getComputedStyle(row).scrollMarginTop) || 0
      return [0, ...places.map(place => place.getBoundingClientRect().top - top - padding - (place.matches(AT_BAND) ? 0 : depth))]
    }
    const measure = (): void => {
      frame = 0
      if (list.clientHeight === 0) return
      const next = endRoom(list.scrollHeight - room - list.clientHeight, rests())
      if (next === room) return
      room = next
      list.style.setProperty('--list-end-room', `${room}px`)
    }
    const soon = (): void => { if (frame === 0) frame = requestAnimationFrame(measure) }
    // Which way the list last moved, so a scroll that ends between rows goes on that way.
    let last = list.scrollTop
    let way = 0
    const moved = (): void => {
      const at = list.scrollTop
      if (at !== last) way = Math.sign(at - last)
      last = at
    }
    const ended = (): void => {
      // Only the thread list's own layout (threadSidebar.css) lays out places to rest.
      if (list.clientHeight === 0 || list.closest('.thread-nav[data-mode]') === null) return
      const at = list.scrollTop
      const target = settleAt(at, way, rests(), list.scrollHeight - list.clientHeight)
      if (target === null || Math.abs(target - at) < ON_PLACE) return
      list.scrollTo({ top: target, behavior: prefersReducedMotion() ? 'instant' : 'smooth' })
    }
    list.addEventListener('scroll', moved, { passive: true })
    list.addEventListener('scrollend', ended)
    const resized = new ResizeObserver(soon)
    // The list's own boxes, and the sections of the thread list inside it, which lays out as their parent.
    const added = new MutationObserver(() => watch())
    const watch = (): void => {
      resized.disconnect()
      resized.observe(list)
      for (const child of list.querySelectorAll<HTMLElement>(':scope > *, :scope > .thread-nav__list > *')) resized.observe(child)
      added.observe(list, { childList: true })
      const inner = list.querySelector(':scope > .thread-nav__list')
      if (inner !== null) added.observe(inner, { childList: true })
      soon()
    }
    watch()
    // A theme moves the places to rest without resizing anything: Glass's heads stick at the list's very top.
    const themed = new MutationObserver(soon)
    themed.observe(document.documentElement, { attributes: true })
    return () => {
      cancelAnimationFrame(frame); resized.disconnect(); added.disconnect(); themed.disconnect()
      list.removeEventListener('scroll', moved); list.removeEventListener('scrollend', ended)
    }
  }, [scroll])
}
