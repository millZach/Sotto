import { useLayoutEffect, useState, type RefObject } from 'react'

const ELLIPSIS = '…'

/**
 * A title cut to fit one line at a word's end, with an ellipsis: "Write the split plan…" rather than "Write the split
 * plan do…". `fits` says whether a string fits the line. A title that fits is left whole; one whose first word alone does
 * not fit is left for the line's own ellipsis, which cuts where it must.
 */
export function cutAtWord(title: string, fits: (text: string) => boolean): string {
  if (fits(title)) return title
  const words = title.split(/(?<=\s)/u)
  let best = ''
  for (let count = 1; count < words.length; count += 1) {
    const kept = words.slice(0, count).join('').trimEnd().replace(/[\s,;:.\-–—/]+$/u, '')
    if (kept === '' || !fits(kept + ELLIPSIS)) break
    best = kept
  }
  return best === '' ? title : best + ELLIPSIS
}

let canvas: CanvasRenderingContext2D | null | undefined
const context = (): CanvasRenderingContext2D | null => {
  if (canvas === undefined) canvas = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  return canvas
}

/** One observer for every cut title, since a sidebar's titles change width together. */
const watched = new Map<Element, () => void>()
let observer: ResizeObserver | undefined
const observe = (element: Element, measure: () => void): (() => void) => {
  observer ??= new ResizeObserver(entries => { for (const entry of entries) watched.get(entry.target)?.() })
  watched.set(element, measure)
  observer.observe(element)
  return () => { watched.delete(element); observer?.unobserve(element) }
}

/**
 * The title as a one-line box shows it: whole while it fits, else cut at a word's end. While `look` is null the box is
 * not one line and the title is left whole. It measures in the box's own font when the box changes width, when `title`
 * or `look` (anything that changes the font, such as the row's weight) changes, and once the fonts have loaded. The whole
 * title stays the row's name and its tooltip.
 */
export function useWordCut(box: RefObject<HTMLElement | null>, title: string, look: string | null): string {
  const [cut, setCut] = useState(title)
  useLayoutEffect(() => {
    const element = box.current
    // Where nothing reports a width, as in a test's document, the title stays whole for the box's own ellipsis.
    const pen = look === null || element === null || typeof ResizeObserver === 'undefined' ? null : context()
    if (element === null || pen === null) { setCut(title); return undefined }
    let width = -1, font = ''
    const measure = (): void => {
      const style = getComputedStyle(element)
      const nextFont = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      const nextWidth = element.clientWidth
      if (nextWidth === width && nextFont === font) return
      width = nextWidth
      font = nextFont
      if (width <= 0) { setCut(title); return }
      pen.font = font
      // A pixel to spare, so the box's own ellipsis never has to cut what the canvas measured as fitting.
      setCut(cutAtWord(title, text => pen.measureText(text).width <= width - 1))
    }
    measure()
    let live = true
    void document.fonts?.ready.then(() => { if (live) { font = ''; measure() } })
    const stop = observe(element, measure)
    return () => { live = false; stop() }
  }, [box, title, look])
  return cut
}
