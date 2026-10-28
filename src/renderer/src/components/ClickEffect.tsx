import React, { useEffect, useRef, type ReactNode } from 'react'
import { useClickEffectOn } from '../state/clickEffect'
import { toRgb } from '../watcher/canvasColor'
import { columnCeiling, type Word } from '../watcher/nightScene'
import { surfaceOf, toWord } from '../watcher/WatcherNightScene'
import { watchResolution } from '../watcher/watchResolution'
import { ClickWater, GLYPH_ALPHA, GLYPH_H, GLYPH_W, STEP_HZ } from './clickWater'
import './clickEffect.css'

/** The most steps one frame runs, so a frame that came late does not stall the next; it ages the water by the rest. */
const MAX_STEPS = 4
const STEP_MS = 1000 / STEP_HZ
/** Where a press sends no waves: every composer, the thread's, Watcher's and a new thread's draft (Zach, October 27). */
const QUIET = '.thread-prompt'

/** What a run draws with: a 0 and a 1 in the accent, and the strongest any glyph may be. */
interface Ink {
  readonly key: string
  readonly digits: readonly [HTMLCanvasElement, HTMLCanvasElement]
  /** No stronger than GLYPH_ALPHA, nor than leaves every word over a glyph at 4.5:1. */
  readonly ceiling: number
}

/** A part of the window, in CSS pixels, where no glyph is drawn. */
interface Rect { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }

/**
 * Where Watcher's night scene already spends what the words over it allow (ADR-0126): the conversation's column and the
 * header above it. Waves drawn under the scene's glyphs there would add to them, so none are; the margins keep theirs.
 */
function sceneColumn(): readonly Rect[] {
  const pane = document.querySelector<HTMLElement>('.watcher-pane')
  if (pane?.querySelector(':scope > .watcher-scene--land') == null) return []
  const room = pane.getBoundingClientRect()
  const card = pane.querySelector(':scope > .thread-workspace__compose > .thread-prompt')?.getBoundingClientRect()
  const header = Math.max(room.top, ...[...pane.querySelectorAll(':scope > :is(.watcher-head, .watcher-glance)')].map(band => band.getBoundingClientRect().bottom))
  return [
    { left: room.left, top: room.top, right: room.right, bottom: header },
    ...card === undefined ? [] : [{ left: card.left, top: room.top, right: card.right, bottom: room.bottom }],
  ]
}

/**
 * The click effect (ADR-0156): a press anywhere in the main window but a composer sends waves of 0s and 1s in the theme's
 * accent through the room behind it. The canvas lies under the window's content, over only the room's own background, so
 * a card, a bubble or the composer sits over the waves and nothing pressed is ever covered; it never takes the pointer
 * either. Its glyphs are never stronger than leaves every word written over them at 4.5:1 against the room, and none are
 * drawn where Watcher's night scene already spends that. A theme change takes effect in the next frame. It exists only
 * while the effect is on, draws only while the water moves, and clears itself and stops when the water is calm, the
 * window is hidden or the effect goes.
 */
export function ClickEffect(): ReactNode {
  return useClickEffectOn() ? <ClickEffectLayer /> : null
}

function ClickEffectLayer(): ReactNode {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    // Without a canvas to draw on (a test's DOM) nothing listens.
    if (canvas == null || ctx == null) return
    const pixel = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true })
    let water: ClickWater | null = null
    let ink: Ink | null = null
    /** The ink and the quiet column are read again before the next frame: a run starts, or the theme changed. */
    let stale = true
    let quiet: readonly Rect[] = []
    let request: number | null = null
    let last = 0
    /** Time owed to the water since the last step, in milliseconds. */
    let owed = 0
    // An end-to-end run marks whether the loop runs, and counts the frames drawn and the glyphs in the last, so a test can
    // tell the waves from the calm.
    let frames = 0
    const counted = window.sottoE2E !== undefined
    const dpr = (): number => window.devicePixelRatio || 1

    /** The water, sized to the window and its pixel ratio as they are now; a new size starts calm water. */
    const waterNow = (): ClickWater => {
      const width = window.innerWidth, height = window.innerHeight, scale = dpr()
      if (water?.width === width && water.height === height && canvas.width === Math.round(width * scale)) return water
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      water = new ClickWater(width, height)
      return water
    }

    /**
     * The ink for the theme in force, read once as a run starts: the accent (the canvas's outline), the words' colours (its
     * borders and column rule: the text, its secondary and muted tiers, and links at rest and pointed at) and the room's
     * surface under them, as the night scene
     * reads its own (ADR-0126). The glyphs go no stronger than leaves every one of those words at 4.5:1 over a glyph.
     */
    const inkNow = (): Ink => {
      const style = getComputedStyle(canvas)
      const scale = dpr()
      const shell = canvas.parentElement ?? document.body
      const key = [style.outlineColor, style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor, style.columnRuleColor,
        getComputedStyle(shell).backgroundColor, style.fontFamily, scale].join('|')
      if (ink?.key === key) return ink
      const accent = pixel === null ? null : toRgb(style.outlineColor, pixel)
      const words = pixel === null ? [] : [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor, style.columnRuleColor]
        .map(value => toWord(value, pixel)).filter((word): word is Word => word !== null)
      const surface = pixel === null || words[0] === undefined ? null : surfaceOf(shell, pixel, words[0])
      // Colours that cannot be read draw nothing rather than risk a word.
      const ceiling = accent === null || surface === null ? 0 : Math.min(GLYPH_ALPHA, columnCeiling(surface, accent, 1, words))
      const draw = (digit: string): HTMLCanvasElement => {
        const sprite = document.createElement('canvas')
        sprite.width = Math.ceil(GLYPH_W * 1.4 * scale)
        sprite.height = Math.ceil(GLYPH_H * scale)
        const pen = sprite.getContext('2d')
        if (pen !== null) {
          pen.scale(scale, scale)
          pen.font = `500 11px ${style.fontFamily}`
          pen.fillStyle = style.outlineColor
          pen.textAlign = 'center'
          pen.textBaseline = 'middle'
          pen.fillText(digit, sprite.width / scale / 2, GLYPH_H / 2)
        }
        return sprite
      }
      ink = { key, digits: [draw('0'), draw('1')], ceiling }
      if (counted) { canvas.dataset.clickEffectCeiling = String(ceiling); canvas.dataset.clickEffectInk = style.outlineColor }
      return ink
    }

    const stop = (): void => {
      if (request !== null) cancelAnimationFrame(request)
      request = null
      water?.clear()
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (counted) { canvas.dataset.clickEffectRunning = 'false'; canvas.dataset.clickEffectGlyphs = '0' }
    }

    const frame = (now: number): void => {
      request = null
      if (water === null) return
      // Steps are owed by the clock, not by frames, so the waves keep their speed and their cost on any display.
      owed += now - last
      last = now
      const due = Math.floor(owed / STEP_MS)
      if (due < 1) { request = requestAnimationFrame(frame); return }
      owed -= due * STEP_MS
      for (let step = 0; step < Math.min(due, MAX_STEPS); step++) water.step()
      water.age(due - MAX_STEPS)
      if (water.calm) { stop(); return }
      if (stale || ink === null) { ink = inkNow(); quiet = sceneColumn(); stale = false }
      const { digits, ceiling } = ink
      const width = GLYPH_W * 1.4, height = GLYPH_H, strength = ceiling / GLYPH_ALPHA
      ctx.clearRect(0, 0, water.width, water.height)
      const stamped = water.draw((digit, x, y, alpha) => {
        if (quiet.some(rect => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom)) return
        ctx.globalAlpha = alpha * strength
        ctx.drawImage(digits[digit], x - width / 2, y - height / 2, width, height)
      })
      ctx.globalAlpha = 1
      if (counted) { canvas.dataset.clickEffectFrames = String(++frames); canvas.dataset.clickEffectGlyphs = String(stamped) }
      request = requestAnimationFrame(frame)
    }

    // Every primary press in the window, seen in the capture phase and passively, so nothing the page does can stop it or
    // wait on it. Many fast presses only add drops to the same water; the work per frame stays the same.
    const press = (event: PointerEvent): void => {
      if (event.button !== 0 || document.visibilityState === 'hidden') return
      if (event.target instanceof Element && event.target.closest(QUIET) !== null) return
      waterNow().press(event.clientX, event.clientY)
      if (request !== null) return
      stale = true
      last = performance.now()
      owed = STEP_MS
      request = requestAnimationFrame(frame)
      if (counted) canvas.dataset.clickEffectRunning = 'true'
    }
    const hidden = (): void => { if (document.visibilityState === 'hidden') stop() }
    // A new window size or pixel ratio stills the water; the next press starts water to fit.
    const resized = (): void => {
      if (water === null) return
      if (water.width === window.innerWidth && water.height === window.innerHeight && canvas.width === Math.round(water.width * dpr())) return
      stop()
      water = null
    }
    // A theme or mode change is read again before the next frame, so waves already running take the new accent.
    const theme = new MutationObserver(() => { stale = true })
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'data-theme-id'] })
    window.addEventListener('pointerdown', press, { capture: true, passive: true })
    window.addEventListener('resize', resized)
    const unwatchResolution = watchResolution(resized)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      theme.disconnect()
      window.removeEventListener('pointerdown', press, { capture: true })
      window.removeEventListener('resize', resized)
      unwatchResolution()
      document.removeEventListener('visibilitychange', hidden)
      stop()
    }
  }, [])
  return <canvas ref={ref} className="click-effect" aria-hidden="true" />
}
