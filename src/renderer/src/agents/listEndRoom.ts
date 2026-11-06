import { useLayoutEffect, type RefObject } from 'react'

/** The places a scroll of the thread list comes to rest, as threadSidebar.css names them. */
const RESTS = '.thread-folder, .thread-nav__settled, .thread-folder__rows > :is(.thread-nav__row, .thread-nav__gap)'
/** A row's place lies a head's depth down; these rest at the band. */
const AT_BAND = '.thread-folder, .thread-nav__settled'

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
 * Keeps the thread list's end room (`--list-end-room`) as the list stands: on a resize of the list or of anything in it,
 * at most once a frame. It reads where the places to rest lie and writes one style property; it renders nothing.
 */
export function useListEndRoom(scroll: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const list = scroll.current
    if (list === null || typeof ResizeObserver === 'undefined') return undefined
    let frame = 0
    let room = 0
    const measure = (): void => {
      frame = 0
      if (list.clientHeight === 0) return
      const style = getComputedStyle(list)
      const padding = Number.parseFloat(style.scrollPaddingTop) || 0
      const top = list.getBoundingClientRect().top - list.scrollTop
      const places = [...list.querySelectorAll<HTMLElement>(RESTS)]
      const row = places.find(place => !place.matches(AT_BAND))
      const depth = row === undefined ? 0 : Number.parseFloat(getComputedStyle(row).scrollMarginTop) || 0
      const rests = places.map(place => place.getBoundingClientRect().top - top - padding - (place.matches(AT_BAND) ? 0 : depth))
      const next = endRoom(list.scrollHeight - room - list.clientHeight, rests)
      if (next === room) return
      room = next
      list.style.setProperty('--list-end-room', `${room}px`)
    }
    const soon = (): void => { if (frame === 0) frame = requestAnimationFrame(measure) }
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
    return () => { cancelAnimationFrame(frame); resized.disconnect(); added.disconnect(); themed.disconnect() }
  }, [scroll])
}
