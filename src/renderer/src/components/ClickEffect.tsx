import React, { useEffect, useRef, type ReactNode } from 'react'
import { rootStyleUnchanged } from '../state/appearance'
import { toRgb } from '../watcher/canvasColor'
import { over, WORD_CONTRAST, wordContrast, type Rgb, type Word } from '../watcher/nightScene'
import { measureRoom, surfaceOf, toWord } from '../watcher/WatcherNightScene'
import { watchResolution } from '../watcher/watchResolution'
import { ClickWater, GLYPH_ALPHA, GLYPH_H, GLYPH_W, STEP_HZ } from './clickWater'
import './clickEffect.css'

/** The most steps one frame runs, so a frame that came late does not stall the next; it ages the water by the rest. */
const MAX_STEPS = 4
const STEP_MS = 1000 / STEP_HZ
/** A digit's sprite: a little wider than its cell, so a glyph nudged along the water's slope keeps its edges. */
const SPRITE_W = GLYPH_W * 1.4
/** Where a press sends no waves: every composer, the thread's, Watcher's and a new thread's draft (Zach, October 27). */
const QUIET = '.thread-prompt'

/** A menu or dialog a composer opens (its model picker); it lives inside the composer in the page but is not its card. */
const COMPOSER_MENU = 'dialog, [role="dialog"], [role="menu"], [role="listbox"]'

/**
 * Whether a press lands on a composer's own card. A menu the composer opens is not the card, wherever it stands, and
 * neither is that menu's backdrop over the conversation: a press on either still sends waves.
 */
function onComposer(event: PointerEvent): boolean {
  const composer = event.target instanceof Element ? event.target.closest(QUIET) : null
  if (composer === null) return false
  const menu = (event.target as Element).closest(COMPOSER_MENU)
  if (menu !== null && composer.contains(menu)) return false
  const card = composer.getBoundingClientRect()
  return event.clientX >= card.left && event.clientX <= card.right && event.clientY >= card.top && event.clientY <= card.bottom
}
/**
 * Every colour words over the room are written in, which the glyphs must leave at 4.5:1: the text and its secondary and
 * muted tiers, links at rest and pointed at, the accent's text tone and the working words', and the status colours. The
 * faint tier is left out (Zach, October 27, ADR-0156): holding it too would leave the waves nearly invisible.
 */
const WORD_TOKENS = ['--tt-text', '--tt-text-2', '--tt-text-muted', '--tt-link', '--tt-primary-hover', '--tt-accent-text', '--tt-activity',
  '--tt-error', '--tt-error-text', '--tt-warning-text', '--tt-success'] as const
/** What every word over the waves keeps, as AGENTS.md asks of all text. */
const READABLE = 4.5
/** The translucent fills a control lays over the room when pointed at, pressed or selected, which sit over the waves too. */
const TINT_TOKENS = ['--tt-hover', '--tt-hover-strong', '--tt-selected'] as const

/**
 * The strongest the glyphs may be, in hundredths up to GLYPH_ALPHA: the accent laid over `surface` at that strength, bare
 * or under each of `tints`, leaves every one of `words` that reads at 4.5:1 without the waves still at 4.5:1, and at
 * WORD_CONTRAST, the night scene's margin for rounding, where it had that much to begin with. A word that reads under
 * 4.5:1 even without waves, on some fill, is the theme's own matter and is left out for that fill.
 */
export function waveCeiling(surface: Rgb, accent: Rgb, words: readonly Word[], tints: readonly Word[]): number {
  const under = (alpha: number): Rgb[] => [over(surface, accent, alpha), ...tints.map(tint => over(over(surface, accent, alpha), tint, tint.a ?? 1))]
  const pairs = under(0).flatMap((pixel, fill) => words.flatMap(word => {
    const without = wordContrast(word, pixel)
    return without >= READABLE ? [{ fill, word, keep: without >= WORD_CONTRAST ? WORD_CONTRAST : READABLE }] : []
  }))
  let best = 0
  for (let step = 1; step <= Math.round(GLYPH_ALPHA * 100); step++) {
    const pixels = under(step / 100)
    if (pairs.some(({ fill, word, keep }) => wordContrast(word, pixels[fill]!) < keep)) break
    best = step / 100
  }
  return best
}

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
 * Where Watcher's night scene already spends what the words and marks over it allow (ADR-0126): the conversation's
 * column, the header band above it and the message scrubber's lane (ADR-0109), measured as the scene measures them (`measureRoom`). Waves drawn under the scene's glyphs there
 * would add to them, so none are; the margins keep theirs. A room the scene cannot measure is kept clear whole.
 */
function sceneColumn(): readonly Rect[] {
  const pane = document.querySelector<HTMLElement>('.watcher-pane')
  if (pane?.querySelector(':scope > .watcher-scene--land') == null) return []
  const base = pane.getBoundingClientRect()
  const room = measureRoom(pane)
  if (room === null) return [{ left: base.left, top: base.top, right: base.right, bottom: base.bottom }]
  // The scene measures in the pane's scrolled content; the canvas draws in the window.
  const down = base.top - pane.scrollTop
  return [
    { left: base.left, top: base.top, right: base.right, bottom: down + room.header },
    { left: base.left + room.composer.x, top: base.top, right: base.left + room.composer.x + room.composer.w, bottom: base.bottom },
    ...room.lane === undefined ? [] : [{ left: base.left + room.lane.x, top: base.top, right: base.left + room.lane.x + room.lane.w, bottom: base.bottom }],
  ]
}

/**
 * The click effect (ADR-0156): a press anywhere in the main window but a composer sends waves of 0s and 1s in the theme's
 * accent through the room behind it. The canvas lies under the window's content, over only the room's own background, so
 * a card, a bubble or the composer sits over the waves and nothing pressed is ever covered; it never takes the pointer
 * either. Its glyphs are never stronger than leaves every word written over them at 4.5:1 against the room, and none are
 * drawn where Watcher's night scene already spends that. A theme change takes effect in the next frame. It exists only
 * while the effect is on, draws only while the water moves, and clears itself and stops when the water is calm, the
 * window is hidden or the effect goes. The shell mounts it only while `useClickEffectOn` says the effect is on.
 */
export function ClickEffect(): ReactNode {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    // Without a canvas to draw on (a test's DOM) nothing listens.
    if (canvas == null || ctx == null) return
    const pixel = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true })
    let water: ClickWater | null = null
    let ink: Ink | null = null
    /** The ink is read again before the next frame: a run starts, or the theme changed. */
    let stale = true
    /** Watcher's column and header, measured every frame, so a room opened or resized mid-run is kept clear at once. */
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

    /** Whether water and the canvas still fit the window and its pixel ratio as they are now. */
    const fits = (current: ClickWater): boolean =>
      current.width === window.innerWidth && current.height === window.innerHeight && canvas.width === Math.round(current.width * dpr())

    /** The water, sized to the window and its pixel ratio as they are now; a new size starts calm water. */
    const waterNow = (): ClickWater => {
      const width = window.innerWidth, height = window.innerHeight, scale = dpr()
      if (water !== null && fits(water)) return water
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      water = new ClickWater(width, height)
      return water
    }

    /** Tokens as the theme in force computes them, each read off the canvas's own colour in turn. */
    const tokenColors = (tokens: readonly string[]): string[] => {
      const colors = tokens.map(token => { canvas.style.color = `var(${token})`; return getComputedStyle(canvas).color })
      canvas.style.removeProperty('color')
      return colors
    }

    /**
     * The ink for the theme in force, read when a run starts or the theme changes: the accent (the canvas's outline), the
     * words' colours (WORD_TOKENS), the fills controls lay over the waves (TINT_TOKENS) and the room's surface under them,
     * as the night scene reads its own (ADR-0126). The glyphs go no stronger than `waveCeiling` allows.
     */
    const inkNow = (): Ink => {
      const style = getComputedStyle(canvas)
      const scale = dpr()
      const shell = canvas.parentElement ?? document.body
      const colors = tokenColors(WORD_TOKENS), fills = tokenColors(TINT_TOKENS)
      const key = [style.outlineColor, ...colors, ...fills, getComputedStyle(shell).backgroundColor, style.fontFamily, scale].join('|')
      if (ink?.key === key) return ink
      const accent = pixel === null ? null : toRgb(style.outlineColor, pixel)
      const read = (values: readonly string[]): Word[] => pixel === null ? [] : values.map(value => toWord(value, pixel)).filter((word): word is Word => word !== null)
      const words = read(colors), tints = read(fills)
      const surface = pixel === null || words[0] === undefined ? null : surfaceOf(shell, pixel, words[0])
      // Colours that cannot be read draw nothing rather than risk a word.
      const ceiling = accent === null || surface === null ? 0 : waveCeiling(surface, accent, words, tints)
      const draw = (digit: string): HTMLCanvasElement => {
        const sprite = document.createElement('canvas')
        sprite.width = Math.ceil(SPRITE_W * scale)
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
      // The face may still be loading; the 0s and 1s are drawn again once it has (fontsLoaded below).
      void document.fonts?.load(`500 11px ${style.fontFamily}`).catch(() => undefined)
      if (counted) { canvas.dataset.clickEffectCeiling = String(ceiling); canvas.dataset.clickEffectInk = style.outlineColor }
      return ink
    }

    const stop = (): void => {
      if (request !== null) cancelAnimationFrame(request)
      request = null
      water?.clear()
      // In the canvas's own pixels, whatever its scale, so a ratio under 1 clears the whole of it too.
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.restore()
      if (counted) { canvas.dataset.clickEffectRunning = 'false'; canvas.dataset.clickEffectGlyphs = '0' }
    }

    const frame = (now: number): void => {
      request = null
      if (water === null) return
      if (stale || ink === null) {
        ink = inkNow()
        // The ceiling is the canvas's own opacity, so glyphs that overlap still add up to no more than it.
        canvas.style.opacity = String(ink.ceiling)
        stale = false
      }
      // A theme that leaves no room for the glyphs moves no water, draws nothing, and nothing keeps running for it.
      if (ink.ceiling <= 0) { stop(); return }
      // Steps are owed by the clock, not by frames, so the waves keep their speed and their cost on any display.
      owed += now - last
      last = now
      const due = Math.floor(owed / STEP_MS)
      if (due < 1) { request = requestAnimationFrame(frame); return }
      owed -= due * STEP_MS
      for (let step = 0; step < Math.min(due, MAX_STEPS); step++) water.step()
      water.age(due - MAX_STEPS)
      if (water.calm) { stop(); return }
      quiet = sceneColumn()
      const { digits } = ink
      const width = SPRITE_W, height = GLYPH_H
      ctx.clearRect(0, 0, water.width, water.height)
      const stamped = water.draw((digit, x, y, alpha) => {
        // A glyph whose box reaches into a quiet part is not drawn, so none spills over its edge.
        if (quiet.some(rect => x + width / 2 > rect.left && x - width / 2 < rect.right && y + height / 2 > rect.top && y - height / 2 < rect.bottom)) return
        ctx.globalAlpha = alpha / GLYPH_ALPHA
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
      if (onComposer(event)) return
      // Until the theme changes, a theme found to leave no room for the glyphs starts nothing at all.
      if (request === null && ink !== null && ink.ceiling <= 0) return
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
      if (fits(water)) return
      stop()
      water = null
    }
    // A theme or mode change is read again before the next frame, so waves already running take the new accent.
    // The theme inspector's probes, which restore the root's style in the same task, are not a change (ADR-0011).
    // A face that finished loading draws the 0s and 1s again, in it rather than its fallback.
    const fontsLoaded = (): void => { ink = null; stale = true }
    document.fonts?.addEventListener('loadingdone', fontsLoaded)
    const theme = new MutationObserver(records => { if (!rootStyleUnchanged(records, document.documentElement)) { ink = null; stale = true } })
    theme.observe(document.documentElement, { attributes: true, attributeOldValue: true, attributeFilter: ['style', 'data-theme', 'data-theme-id'] })
    window.addEventListener('pointerdown', press, { capture: true, passive: true })
    window.addEventListener('resize', resized)
    const unwatchResolution = watchResolution(resized)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      theme.disconnect()
      document.fonts?.removeEventListener('loadingdone', fontsLoaded)
      window.removeEventListener('pointerdown', press, { capture: true })
      window.removeEventListener('resize', resized)
      unwatchResolution()
      document.removeEventListener('visibilitychange', hidden)
      stop()
    }
  }, [])
  return <canvas ref={ref} className="click-effect" aria-hidden="true" />
}
