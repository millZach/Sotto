import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import { useReducedMotion } from '../state/reducedMotion'
import { addRipple, frameDelay, liveRipples, sceneInk, type Box, type Look, type OwlStage, type Rgb, type Ripple, type SceneMeasure } from './nightScene'
import { NightScenePainter } from './nightScenePainter'
import './nightScene.css'

/** How long the scene takes to fade once the room has a conversation (nightScene.css). */
export const SCENE_FADE_MS = 700

/** Where a press is a control's, or the composer's or the header's, and sends out no ripple. */
const NOT_BACKGROUND = [
  'button', 'a', 'input', 'textarea', 'select', 'label', 'summary', 'dialog', '[contenteditable]',
  ...['button', 'tab', 'link', 'menuitem', 'option', 'combobox', 'textbox', 'dialog', 'menu', 'listbox', 'checkbox', 'radio', 'switch', 'slider'].map(role => `[role="${role}"]`),
  '.thread-workspace__compose', '.watcher-head', '.watcher-glance', '.watcher-handover',
].join(', ')

function relative(box: DOMRect, base: DOMRect, scrollTop: number): Box {
  return { x: box.left - base.left, y: box.top - base.top + scrollTop, w: box.width, h: box.height }
}

/** What the scene needs to know of Watcher's pane, or null while it has no composer to fly to. */
export function measureRoom(pane: HTMLElement): SceneMeasure | null {
  const form = pane.querySelector<HTMLElement>('.thread-workspace__compose .thread-prompt')
  const compose = form?.closest<HTMLElement>('.thread-workspace__compose')
  if (form == null || compose == null) return null
  const base = pane.getBoundingClientRect(), top = pane.scrollTop
  const at = (element: Element): Box => relative(element.getBoundingClientRect(), base, top)
  const composer = at(form)
  if (composer.w < 1 || composer.h < 1) return null
  const words: Box[] = []
  const shown = (box: Box): boolean => box.w > 1 && box.h > 1
  const word = (element: Element): void => { const box = at(element); if (shown(box) && element.textContent?.trim()) words.push(box) }
  // What stands on the composer, such as the handover offer or an error line, is where the owl lands instead.
  let perchTop = composer.y
  for (const child of compose.children) {
    if (child.contains(form)) break
    const box = at(child)
    if (shown(box)) { perchTop = Math.min(perchTop, box.y); words.push(box) }
  }
  // The header and the needs-you line, the intro's words, and the line under the composer.
  let header = 0
  for (const band of pane.querySelectorAll(':scope > :is(.watcher-head, .watcher-glance, .thread-workspace__error)')) {
    const box = at(band)
    header = Math.max(header, box.y + box.h)
    word(band)
  }
  const intro = pane.querySelector('.watcher-first__intro, .thread-workspace__empty')
  for (const element of intro?.children ?? []) word(element)
  for (const line of compose.querySelectorAll(':scope > .thread-pane__meta')) word(line)
  return { width: pane.clientWidth, height: pane.clientHeight, header, composer, perchTop, intro: intro === null ? null : at(intro), words }
}

/** A colour as the canvas paints it, whatever form the style gave it in. */
function toRgb(value: string, pixel: CanvasRenderingContext2D): Rgb | null {
  pixel.clearRect(0, 0, 1, 1)
  pixel.fillStyle = 'rgba(0, 0, 0, 0)'
  pixel.fillStyle = value
  pixel.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0, a = 0] = pixel.getImageData(0, 0, 1, 1).data
  return a === 0 ? null : { r, g, b }
}

/** The surface the scene is drawn on: the first painted background at or above the pane. */
function surfaceOf(pane: HTMLElement, pixel: CanvasRenderingContext2D): Rgb | null {
  for (let node: Element | null = pane; node !== null; node = node.parentElement) {
    const found = toRgb(getComputedStyle(node).backgroundColor, pixel)
    if (found !== null) return found
  }
  return null
}

/**
 * Watcher's night scene (Zach's pick on October 21, 2026, variant A of `prototype/watcher-owl-scene`): an ASCII night
 * drawn behind Watcher's room while it is empty, the first time and in an empty conversation. The owl flies its route
 * once when the room opens and perches on the composer's top-right corner; a press in the open background sends out a
 * ripple, and the perched owl looks toward it. Once the room has a conversation the scene fades and stops drawing.
 *
 * It is decoration: two canvases hidden from assistive technology, never focusable and never the target of a press.
 * It draws at about 30 frames a second while something moves, 10 while the owl sits, and not at all when nothing moves,
 * the window is hidden or the scene has gone. With motion reduced, or `held` for a capture, the owl starts on the
 * composer and the scene holds still.
 */
export function WatcherNightScene({ shown, held }: {
  /** Whether the room is empty, so the scene shows; when it turns false the scene fades and stops. */
  readonly shown: boolean
  /** A capture's fixed clock: the scene draws its settled picture and holds it. */
  readonly held: boolean
}): ReactNode {
  const reduced = useReducedMotion()
  const still = reduced || held
  const [phase, setPhase] = useState<'shown' | 'leaving' | 'gone'>(shown ? 'shown' : 'gone')
  // The flight plays once a room visit: the scene coming back later in the visit finds the owl where its clock has it.
  const origin = useRef<number | null>(null)
  const stillRef = useRef(still)
  const leaving = useRef(phase === 'leaving')
  const wakeRef = useRef<() => void>(() => undefined)
  const back = useRef<HTMLCanvasElement>(null)
  const front = useRef<HTMLCanvasElement>(null)
  const probe = useRef<HTMLElement>(null)

  useEffect(() => {
    if (shown) { setPhase('shown'); return }
    setPhase(current => current === 'gone' ? 'gone' : 'leaving')
    const timer = window.setTimeout(() => setPhase('gone'), SCENE_FADE_MS)
    return () => window.clearTimeout(timer)
  }, [shown])
  useEffect(() => { leaving.current = phase === 'leaving' }, [phase])
  useEffect(() => { stillRef.current = still; wakeRef.current() }, [still])

  const mounted = phase !== 'gone'
  useEffect(() => {
    const land = back.current, owl = front.current, ink = probe.current
    const pane = land?.parentElement
    // Without layout (a test's DOM) there is nothing to measure, so nothing is drawn.
    if (!mounted || land == null || owl == null || ink == null || pane == null || typeof ResizeObserver === 'undefined') return
    const pixelCanvas = document.createElement('canvas')
    pixelCanvas.width = 1; pixelCanvas.height = 1
    const pixel = pixelCanvas.getContext('2d', { willReadFrequently: true })
    if (pixel === null) return
    const painter = new NightScenePainter(land, owl)
    let disposed = false
    let timer: number | null = null
    let request: number | null = null
    let layoutRequest: number | null = null
    let measured = ''
    let inked = ''
    let ripples: Ripple[] = []
    let look: Look | null = null
    let stage: OwlStage | null = null
    const clock = (): number => origin.current === null ? 0 : (performance.now() - origin.current) / 1000

    const frame = (): void => {
      request = null
      if (disposed || document.visibilityState === 'hidden' || !painter.ready) return
      const t = clock()
      ripples = liveRipples(ripples, t, stillRef.current)
      const drawn = painter.draw(t, ripples, look, stillRef.current)
      if (drawn.stage !== stage) { stage = drawn.stage; owl.dataset.owl = stage }
      const delay = frameDelay(drawn.stage, ripples.length, stillRef.current)
      if (delay !== null) timer = window.setTimeout(() => { timer = null; request = requestAnimationFrame(frame) }, delay)
    }
    /** Draws the next frame now, rather than when the current pace would. */
    const wake = (): void => {
      if (disposed) return
      if (timer !== null) { window.clearTimeout(timer); timer = null }
      if (request === null) request = requestAnimationFrame(frame)
    }
    wakeRef.current = wake

    const readInk = (): void => {
      const style = getComputedStyle(ink)
      const text = toRgb(style.color, pixel), accent = toRgb(style.backgroundColor, pixel), surface = surfaceOf(pane, pixel)
      if (text === null || accent === null || surface === null) return
      const key = JSON.stringify([text, accent, surface, style.fontFamily])
      if (key === inked) return
      inked = key
      painter.setInk(sceneInk(surface, text, accent), style.fontFamily)
      wake()
    }
    const relayout = (): void => {
      layoutRequest = null
      if (disposed) return
      const measure = measureRoom(pane)
      const dpr = window.devicePixelRatio || 1
      const key = measure === null ? '' : JSON.stringify([measure, dpr])
      if (key === measured) return
      measured = key
      observeParts()
      if (measure === null || !painter.resize(measure, dpr)) {
        for (const canvas of [land, owl]) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
        return
      }
      // The clock starts when the scene first has a composer to fly to.
      origin.current ??= performance.now()
      readInk()
      wake()
    }
    const scheduleLayout = (): void => { if (layoutRequest === null && !disposed) layoutRequest = requestAnimationFrame(relayout) }

    const sizes = new ResizeObserver(scheduleLayout)
    const observeParts = (): void => {
      sizes.disconnect()
      sizes.observe(pane)
      for (const part of pane.querySelectorAll('.thread-workspace__compose, .thread-workspace__compose .thread-prompt, .watcher-first__intro, .thread-workspace__empty, :scope > .watcher-glance')) sizes.observe(part)
    }
    // The intro, the composer and what stands on it come and go; typing in the composer is left to the size watch.
    const parts = new MutationObserver(records => {
      if (records.some(record => !(record.target instanceof Element && record.target.closest('.thread-prompt')))) scheduleLayout()
    })
    parts.observe(pane, { childList: true, subtree: true })
    // A theme or mode change repaints the scene in the new inks.
    const theme = new MutationObserver(readInk)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'data-theme-id'] })
    const visibility = (): void => { if (document.visibilityState !== 'hidden') wake() }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('resize', scheduleLayout)

    // A press in the open background sends out a ripple, and the owl looks toward it.
    const press = (event: PointerEvent): void => {
      if (leaving.current || event.button !== 0 || !painter.ready) return
      if (!(event.target instanceof Element) || event.target.closest(NOT_BACKGROUND) !== null) return
      const base = pane.getBoundingClientRect()
      const x = event.clientX - base.left, y = event.clientY - base.top + pane.scrollTop, t = clock()
      ripples = addRipple(liveRipples(ripples, t, stillRef.current), { x, y, t })
      look = { x, y, t }
      wake()
    }
    pane.addEventListener('pointerdown', press)

    // The glyph face may still be loading; the scene is drawn again once it has.
    const font = `10.5px ${getComputedStyle(ink).fontFamily}`
    void document.fonts?.load(font).then(() => { if (!disposed) { inked = ''; readInk() } }, () => undefined)
    relayout()

    return () => {
      disposed = true
      wakeRef.current = () => undefined
      if (timer !== null) window.clearTimeout(timer)
      if (request !== null) cancelAnimationFrame(request)
      if (layoutRequest !== null) cancelAnimationFrame(layoutRequest)
      sizes.disconnect(); parts.disconnect(); theme.disconnect()
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('resize', scheduleLayout)
      pane.removeEventListener('pointerdown', press)
    }
  }, [mounted])

  if (!mounted) return null
  const fading = phase === 'leaving' || undefined
  return <>
    <canvas ref={back} className="watcher-scene watcher-scene--land" data-leaving={fading} aria-hidden="true" />
    <canvas ref={front} className="watcher-scene watcher-scene--owl" data-leaving={fading} aria-hidden="true" />
    <i ref={probe} className="watcher-scene__ink" aria-hidden="true" />
  </>
}
