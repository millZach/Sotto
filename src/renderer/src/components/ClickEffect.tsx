import React, { useEffect, useRef, type ReactNode } from 'react'
import { useClickEffectOn } from '../state/clickEffect'
import { ClickWater, GLYPH_H, GLYPH_W, STEP_HZ } from './clickWater'
import './clickEffect.css'

/** The most steps one frame runs, so a frame that came late does not stall the next. */
const MAX_STEPS = 4

/**
 * The click effect (ADR-0154): a press anywhere in the main window sends waves of 0s and 1s in the theme's accent through
 * the room behind it. The canvas lies under the window's content, over only the room's own background, so a card, a
 * bubble or the composer sits over the waves and nothing pressed is ever covered; it never takes the pointer either. It
 * exists only while the effect is on, draws only while the water moves, and clears itself and stops when the water is
 * calm, the window is hidden or the effect goes.
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
    let water: ClickWater | null = null
    let request: number | null = null
    let last = 0
    let sprites: { readonly key: string; readonly digits: readonly [HTMLCanvasElement, HTMLCanvasElement] } | null = null
    // An end-to-end run marks whether the loop runs, and counts the frames drawn and the glyphs in the last, so a test can
    // tell the waves from the calm.
    let frames = 0
    const counted = window.sottoE2E !== undefined

    /** The water, sized to the window as it is now; a new size starts calm water. */
    const waterNow = (): ClickWater => {
      const width = window.innerWidth, height = window.innerHeight
      if (water?.width === width && water.height === height) return water
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      water = new ClickWater(width, height)
      return water
    }

    /** A 0 and a 1 in the accent, drawn once for the theme and font in force and stamped wherever the water shows one. */
    const digitsNow = (): readonly [HTMLCanvasElement, HTMLCanvasElement] => {
      const style = getComputedStyle(canvas)
      const dpr = window.devicePixelRatio || 1
      const key = `${style.color}|${style.fontFamily}|${dpr}`
      if (sprites?.key === key) return sprites.digits
      const draw = (digit: string): HTMLCanvasElement => {
        const sprite = document.createElement('canvas')
        sprite.width = Math.ceil(GLYPH_W * 1.4 * dpr)
        sprite.height = Math.ceil(GLYPH_H * dpr)
        const pen = sprite.getContext('2d')
        if (pen !== null) {
          pen.scale(dpr, dpr)
          pen.font = `500 11px ${style.fontFamily}`
          pen.fillStyle = style.color
          pen.textAlign = 'center'
          pen.textBaseline = 'middle'
          pen.fillText(digit, sprite.width / dpr / 2, GLYPH_H / 2)
        }
        return sprite
      }
      sprites = { key, digits: [draw('0'), draw('1')] }
      return sprites.digits
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
      const steps = Math.min(MAX_STEPS, Math.max(1, Math.round((now - last) / (1000 / STEP_HZ))))
      last = now
      for (let step = 0; step < steps; step++) water.step()
      if (water.calm) { stop(); return }
      const digits = digitsNow()
      const width = GLYPH_W * 1.4, height = GLYPH_H
      ctx.clearRect(0, 0, water.width, water.height)
      const stamped = water.draw((digit, x, y, alpha) => {
        ctx.globalAlpha = alpha
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
      waterNow().press(event.clientX, event.clientY)
      if (request === null) { last = performance.now(); request = requestAnimationFrame(frame); if (counted) canvas.dataset.clickEffectRunning = 'true' }
    }
    const hidden = (): void => { if (document.visibilityState === 'hidden') stop() }
    // A new window size stills the water; the next press starts water of the new size.
    const resized = (): void => { if (water !== null && (water.width !== window.innerWidth || water.height !== window.innerHeight)) { stop(); water = null } }
    window.addEventListener('pointerdown', press, { capture: true, passive: true })
    window.addEventListener('resize', resized)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('pointerdown', press, { capture: true })
      window.removeEventListener('resize', resized)
      document.removeEventListener('visibilitychange', hidden)
      stop()
    }
  }, [])
  return <canvas ref={ref} className="click-effect" aria-hidden="true" />
}
