import React, { useLayoutEffect, useRef, type ReactNode } from 'react'

import type { WatcherScene } from '../../../../../shared/watcherScene'
import { clamp, owlAt, sceneInk, TREES_MIN_MARGIN, type Box, type SceneLayout, type SceneMeasure, type WatcherOwlState, type Word } from '../../../watcher/nightScene'
import { NightScenePainter } from '../../../watcher/nightScenePainter'
import { OwlFamily, type WatchedOwl } from '../../../watcher/owlFamily'
import { surfaceOf, toWord } from '../../../watcher/WatcherNightScene'
import { toRgb } from '../../../watcher/canvasColor'

/** The preview's watched threads: one waiting on you, one working and one resting. Never pressed, so never named. */
const OWLS: readonly WatchedOwl[] = [
  { key: 'waiting', title: '', threadId: null, mood: 'waiting' },
  { key: 'working', title: '', threadId: null, mood: 'awake' },
  { key: 'resting', title: '', threadId: null, mood: 'asleep' },
]

/** Watcher's owl at home in its tree, going nowhere. */
const HOME: WatcherOwlState = { at: 'home', side: 'left', flight: null, next: Number.POSITIVE_INFINITY }

/** The scene's clock: the preview draws one settled moment. */
const T = 0

/**
 * Watcher's night scene in the Appearance preview's small room, drawn by the room's own painter (nightScenePainter.ts)
 * as one still frame. The room is far smaller than Watcher's, so the scene is laid out for the same room scaled up until
 * its margins hold the trees, and drawn back at the room's size: a faithful miniature, glyphs and all. It never moves,
 * so reduced motion changes nothing here. It never blinks either (ADR-0126): a new size, a new theme or the other half
 * is drawn in the same task that cleared the canvases, before the frame is shown, and a room hidden with its page keeps
 * its last frame.
 *
 * The parent is the room: it holds `.studio-watcher__head` and `.studio-watcher__composer`, which set the header band
 * and the column as Watcher's own header and composer do. `paint` changes whenever the colours the room is shown in do.
 */
export function PreviewNightScene({ paint, place = 'night-wood' }: {
  readonly paint: string
  /** The place the scene is set in (ADR-0149): a new one is drawn in the same task, so it never shows blank. */
  readonly place?: WatcherScene | undefined
}): ReactNode {
  const back = useRef<HTMLCanvasElement>(null)
  const front = useRef<HTMLCanvasElement>(null)
  const probe = useRef<HTMLElement>(null)
  const repaint = useRef<() => void>(() => undefined)
  const placeRef = useRef(place)
  const movePlace = useRef<() => void>(() => undefined)

  useLayoutEffect(() => {
    const land = back.current, owl = front.current, ink = probe.current
    const room = land?.parentElement
    // Without layout (a test's DOM) there is nothing to measure, so nothing is drawn.
    if (land == null || owl == null || ink == null || room == null || typeof ResizeObserver === 'undefined') return
    const pixelCanvas = document.createElement('canvas')
    pixelCanvas.width = 1; pixelCanvas.height = 1
    const pixel = pixelCanvas.getContext('2d', { willReadFrequently: true })
    if (pixel === null) return
    const painter = new NightScenePainter(land, owl)
    painter.setPlace(placeRef.current)
    let disposed = false
    let measured = ''
    let inked = ''
    let layout: SceneLayout | null = null
    let family: OwlFamily | null = null

    const draw = (): void => {
      if (disposed || layout === null || !painter.ready) return
      const marker = family?.marker ?? null, count = family?.pileCount ?? 0
      painter.draw({
        t: T, still: true, ripples: [], whirl: 0,
        watcher: layout.mode === 'trees' ? owlAt(T, layout, HOME, { still: true }) : null,
        owls: family?.poses(T) ?? [],
        pile: marker !== null && count > 0 ? { spot: marker, count } : null,
      })
    }
    const readInk = (force = false): void => {
      if (disposed) return
      const style = getComputedStyle(ink)
      const text = toRgb(style.color, pixel), accent = toRgb(style.backgroundColor, pixel), surface = surfaceOf(room, pixel)
      if (text === null || accent === null || surface === null) return
      const words = [toWord(style.color, pixel), toWord(style.borderTopColor, pixel)].filter((word): word is Word => word !== null)
      const key = JSON.stringify([text, accent, words, surface, style.fontFamily])
      if (key === inked && !force) return
      inked = key
      painter.setInk(sceneInk(surface, text, accent, words), style.fontFamily)
      draw()
    }
    const relayout = (): void => {
      if (disposed) return
      const base = room.getBoundingClientRect()
      const composer = room.querySelector('.studio-watcher__composer')?.getBoundingClientRect()
      const head = room.querySelector('.studio-watcher__head')?.getBoundingClientRect()
      // A room hidden with its page has no size: the scene keeps its last frame until it shows again.
      if (base.width < 1 || base.height < 1 || composer === undefined || head === undefined || composer.width < 1) return
      const margin = Math.max(1, Math.min(composer.left - base.left, base.right - composer.right))
      const k = clamp((TREES_MIN_MARGIN + 12) / margin, 1, 2.8)
      const at = (box: DOMRect): Box => ({ x: (box.left - base.left) * k, y: (box.top - base.top) * k, w: box.width * k, h: box.height * k })
      const measure: SceneMeasure = { width: base.width * k, height: base.height * k, header: (head.bottom - base.top) * k, composer: at(composer), words: [at(head)] }
      const dpr = window.devicePixelRatio || 1
      const key = JSON.stringify([measure, dpr])
      if (key === measured) return
      measured = key
      // The canvases hold the room's own pixels: the scaled room drawn at a pixel ratio scaled down by as much.
      const next = painter.resize(measure, dpr / k)
      if (next === null) { painter.invalidate(); layout = null; return }
      layout = next
      family = new OwlFamily(next)
      family.update(OWLS, T, 'still')
      // Laying out cleared the canvases: the scene is drawn again in this same task, so it never shows blank.
      readInk(true)
    }
    repaint.current = () => readInk()
    movePlace.current = () => { if (painter.setPlace(placeRef.current)) draw() }

    const sizes = new ResizeObserver(relayout)
    sizes.observe(room)
    // The window's own theme changing repaints the scene in the new inks, before the frame is shown.
    const theme = new MutationObserver(() => readInk())
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'data-theme-id', 'data-effort-color'] })
    const font = `10.5px ${getComputedStyle(ink).fontFamily}`
    void document.fonts?.load(font).then(() => readInk(true), () => undefined)
    relayout()

    return () => {
      disposed = true
      repaint.current = () => undefined
      movePlace.current = () => undefined
      sizes.disconnect()
      theme.disconnect()
    }
  }, [])

  // The preview's colours changed (a theme chosen, or the other half shown): new inks, drawn before the frame is shown.
  useLayoutEffect(() => { repaint.current() }, [paint])
  // Another place chosen: its landscape is drawn now, before the frame is shown.
  useLayoutEffect(() => { placeRef.current = place; movePlace.current() }, [place])

  return <>
    <canvas ref={back} className="studio-scene studio-scene--land" aria-hidden="true" />
    <canvas ref={front} className="studio-scene studio-scene--owl" aria-hidden="true" />
    <i ref={probe} className="studio-scene__ink" aria-hidden="true" />
  </>
}
