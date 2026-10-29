import React, { useEffect, useRef, type ReactNode } from 'react'
import { rootStyleUnchanged } from '../state/appearance'
import { watchResolution } from '../watcher/watchResolution'
import { ClickWater, GLYPH_H, GLYPH_W, STEP_HZ } from './clickWater'
import './clickEffect.css'

/** The most steps one frame runs, so a frame that came late does not stall the next; it ages the water by the rest. */
const MAX_STEPS = 4
const STEP_MS = 1000 / STEP_HZ
/** A digit's sprite: a little wider than its cell, so a glyph nudged along the water's slope keeps its edges. */
const SPRITE_W = GLYPH_W * 1.4
/**
 * The room's bare backdrop: the open space behind the panes, around a thread's messages and around its composer, in the
 * Threads page, Watcher's room and the Dictate room. Each surface where the room's background shows wears this mark.
 */
const BACKDROP = 'data-room-backdrop'

/**
 * Whether a press lands on the bare backdrop itself (Zach, October 28): never on a message, its words, a card, a control,
 * a menu, a dialog, the sidebar or Settings, nor anything inside them, so only the element pressed counts, not those
 * around it.
 */
const onBackdrop = (event: PointerEvent): boolean => event.target instanceof Element && event.target.hasAttribute(BACKDROP)

/** What a run draws with: a 0 and a 1 in the accent, in the theme's monospace face. */
interface Ink {
  readonly key: string
  readonly digits: readonly [HTMLCanvasElement, HTMLCanvasElement]
}

/**
 * The click effect (ADR-0156): a press on the room's bare backdrop sends waves of 0s and 1s in the theme's accent through
 * the room, as strong in every theme (Zach's pick N, October 27). The canvas lies under the window's content, over only
 * the room's own background, so a card, a bubble or the composer sits over the waves; it never takes the pointer either.
 * A theme change takes effect in the next frame. It exists only while the effect is on, draws only while the water moves,
 * and clears itself and stops when the water is calm, the window is hidden or the effect goes. The shell mounts it only
 * while `useClickEffectOn` says the effect is on.
 */
export function ClickEffect(): ReactNode {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    // Without a canvas to draw on (a test's DOM) nothing listens.
    if (canvas == null || ctx == null) return
    let water: ClickWater | null = null
    let ink: Ink | null = null
    /** The ink is read again before the next frame: a run starts, or the theme changed. */
    let stale = true
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

    /** The ink for the theme in force, read when a run starts or the theme changes: the accent, the canvas's outline. */
    const inkNow = (): Ink => {
      const style = getComputedStyle(canvas)
      const scale = dpr()
      const key = [style.outlineColor, style.fontFamily, scale].join('|')
      if (ink?.key === key) return ink
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
      ink = { key, digits: [draw('0'), draw('1')] }
      // The face may still be loading; the 0s and 1s are drawn again once it has (fontsLoaded below).
      void document.fonts?.load(`500 11px ${style.fontFamily}`).catch(() => undefined)
      if (counted) canvas.dataset.clickEffectInk = style.outlineColor
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
      // Steps are owed by the clock, not by frames, so the waves keep their speed and their cost on any display.
      owed += now - last
      last = now
      const due = Math.floor(owed / STEP_MS)
      if (due < 1) { request = requestAnimationFrame(frame); return }
      owed -= due * STEP_MS
      for (let step = 0; step < Math.min(due, MAX_STEPS); step++) water.step()
      water.age(due - MAX_STEPS)
      if (water.calm) { stop(); return }
      if (stale || ink === null) { ink = inkNow(); stale = false }
      const { digits } = ink
      const width = SPRITE_W, height = GLYPH_H
      ctx.clearRect(0, 0, water.width, water.height)
      const stamped = water.draw((digit, x, y, alpha) => {
        ctx.globalAlpha = alpha
        ctx.drawImage(digits[digit], x - width / 2, y - height / 2, width, height)
      })
      ctx.globalAlpha = 1
      if (counted) { canvas.dataset.clickEffectFrames = String(++frames); canvas.dataset.clickEffectGlyphs = String(stamped) }
      request = requestAnimationFrame(frame)
    }

    // Every primary press on the backdrop, seen in the capture phase and passively, so nothing the page does can stop it or
    // wait on it. Many fast presses only add drops to the same water; the work per frame stays the same.
    const press = (event: PointerEvent): void => {
      if (event.button !== 0 || document.visibilityState === 'hidden') return
      if (!onBackdrop(event)) return
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
    const theme = new MutationObserver(records => { if (!rootStyleUnchanged(records, document.documentElement)) stale = true })
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
