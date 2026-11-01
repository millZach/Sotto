import React, { useEffect, useRef, type ReactNode } from 'react'
import { useReducedMotion } from '../state/reducedMotion'
import { OWL_EASEL_FPS, owlEaselFrame, owlEaselGrid, owlEaselProgress } from './owlEasel'

const FRAME_MS = 1000 / OWL_EASEL_FPS

let framesDrawn = 0
/** Every frame any scene has drawn since the window opened: the benchmark's count of what the scene costs. */
export function owlEaselFramesDrawn(): number { return framesDrawn }

/**
 * The owl at the easel, playing in a tile while an agent makes an image (ADR-0170). It writes its two layers of text
 * straight into the page, never through React, twelve times a second while the tile is on screen and the window is
 * shown. Until it first shows, off screen, hidden or unmounted (the picture landed) it draws nothing and holds no timer;
 * under reduced motion it draws one frame when it first shows and holds it.
 */
export function OwlEasel({ startedAt }: { readonly startedAt: number }): ReactNode {
  const box = useRef<HTMLDivElement>(null)
  const paint = useRef<HTMLPreElement>(null)
  const sketch = useRef<HTMLPreElement>(null)
  const still = useReducedMotion()
  useEffect(() => {
    const element = box.current
    if (!element || !paint.current || !sketch.current) return undefined
    const { cols, rows, fontSize, lineHeight } = owlEaselGrid(element.clientWidth || 206, element.clientHeight || 138)
    for (const layer of [paint.current, sketch.current]) { layer.style.fontSize = `${fontSize}px`; layer.style.lineHeight = `${lineHeight}px` }
    const draw = (): void => {
      const seconds = Math.max(0, (Date.now() - startedAt) / 1000)
      const frame = still ? owlEaselFrame(cols, rows, 0.5, 0) : owlEaselFrame(cols, rows, owlEaselProgress(seconds), seconds)
      paint.current!.textContent = frame.paint; sketch.current!.textContent = frame.sketch
      framesDrawn += 1
    }
    // Nothing is drawn until the tile first comes on screen: one never seen costs nothing (ADR-0170).
    let raf = 0, last = 0, visible = false
    const loop = (now: number): void => {
      raf = 0
      if (!visible || document.hidden) return
      if (now - last >= FRAME_MS) { last = now; draw() }
      raf = requestAnimationFrame(loop)
    }
    const run = (): void => { if (visible && !document.hidden && !raf) raf = requestAnimationFrame(loop) }
    const halt = (): void => { if (raf) cancelAnimationFrame(raf); raf = 0 }
    const observer = new IntersectionObserver(entries => {
      visible = entries.at(-1)?.isIntersecting ?? false
      // Under reduced motion, one still frame the first time it shows, and nothing after.
      if (still) { if (visible) { draw(); observer.disconnect() } return }
      // Coming on screen it draws at once, so it never shows a blank tile, then runs.
      if (visible) { if (!raf) draw(); run() } else halt()
    })
    observer.observe(element)
    const shown = (): void => { if (document.hidden) halt(); else if (!still) run() }
    document.addEventListener('visibilitychange', shown)
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', shown); halt() }
  }, [startedAt, still])
  return <div ref={box} className="owl-easel" aria-hidden="true">
    <pre ref={sketch} className="owl-easel__sketch" />
    <pre ref={paint} className="owl-easel__paint" />
  </div>
}
