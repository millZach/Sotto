import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ClickEffect, waveCeiling } from '../../../src/renderer/src/components/ClickEffect'
import { ClickWater, GLYPH_ALPHA } from '../../../src/renderer/src/components/clickWater'
import { over, wordContrast } from '../../../src/renderer/src/watcher/nightScene'
import { AppShell } from '../../../src/renderer/src/components/AppShell'
import type { AppSettings } from '../../../src/shared/settings'

// The effect is an Owl feature (ADR-0072); each test says whether this build has it, what the settings say and whether
// motion is reduced.
const gate = vi.hoisted(() => ({ owl: true, reduced: false, settings: undefined as Partial<AppSettings> | undefined, watched: [] as boolean[] }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'click-effect' && gate.owl,
}))
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: () => (gate.settings === undefined ? null : { settings: gate.settings }),
}))
vi.mock('../../../src/renderer/src/state/reducedMotion', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/reducedMotion')>(),
  useReducedMotion: (watch = true) => { gate.watched.push(watch); return gate.reduced },
}))

const originalGetContext = HTMLCanvasElement.prototype.getContext
let drawn = 0
let cleared = 0

/** jsdom has no canvas; a stand-in counts what the layer draws, and reads `pixel` for every colour it is asked for. */
function stubCanvas(pixel: readonly number[]): void {
  HTMLCanvasElement.prototype.getContext = (() => ({
    setTransform() {}, scale() {}, fillText() {}, save() {}, restore() {}, globalAlpha: 1, font: '', fillStyle: '', textAlign: '', textBaseline: '',
    clearRect() { cleared++ }, drawImage() { drawn++ }, fillRect() {}, getImageData: () => ({ data: pixel }),
  })) as never
}

beforeEach(() => {
  vi.useFakeTimers()
  drawn = 0
  cleared = 0
  stubCanvas([20, 20, 20, 255])
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  HTMLCanvasElement.prototype.getContext = originalGetContext
  gate.owl = true
  gate.reduced = false
  gate.settings = undefined
  gate.watched = []
})

const layer = (container: HTMLElement): HTMLCanvasElement | null => container.querySelector('canvas.click-effect')
const pressAt = (target: EventTarget, x: number, y: number, button = 0): void => {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button }))
}
const frames = (count: number): Promise<void> => act(async () => { await vi.advanceTimersByTimeAsync(count * 17) })

describe('the click effect', () => {
  const shell = (): HTMLElement => render(<AppShell navigation={null} platform="win32" onMinimize={() => undefined} onMaximize={() => undefined} onClose={() => undefined}>room</AppShell>).container

  it('is there, hidden from assistive technology and never pressed, when the build has it and the settings leave it on', () => {
    expect(layer(shell())?.getAttribute('aria-hidden')).toBe('true')
    cleanup()
    gate.settings = { clickEffect: true }
    expect(layer(shell())).not.toBeNull()
  })

  it('does not exist where the build holds it, the switch is off, or motion is reduced', () => {
    gate.owl = false
    expect(layer(shell())).toBeNull()
    cleanup()
    gate.owl = true
    gate.settings = { clickEffect: false }
    expect(layer(shell())).toBeNull()
    cleanup()
    gate.settings = { clickEffect: true }
    gate.reduced = true
    expect(layer(shell())).toBeNull()
  })

  it('follows reduced motion only while the effect is chosen, so a held or switched-off effect starts nothing', () => {
    gate.owl = false
    shell()
    expect(gate.watched.length).toBeGreaterThan(0)
    expect(gate.watched.every(watch => !watch)).toBe(true)
    cleanup()
    gate.watched = []
    gate.owl = true
    gate.settings = { clickEffect: false }
    shell()
    expect(gate.watched.every(watch => !watch)).toBe(true)
  })

  it('draws after a primary press, even one the page stops, and never for another button', async () => {
    const { container } = render(<><ClickEffect /><button type="button" onPointerDown={event => event.stopPropagation()}>Send</button></>)
    pressAt(document.body, 300, 200, 2)
    await frames(6)
    expect(drawn).toBe(0)
    pressAt(container.querySelector('button')!, 300, 200)
    await frames(6)
    expect(drawn).toBeGreaterThan(0)
  })

  it('marks the shell while its layer is there, so the shell stacks it under the page, and never otherwise', () => {
    expect(shell().querySelector('.app-shell')?.hasAttribute('data-click-effect')).toBe(true)
    expect(document.querySelector('.app-shell > canvas.click-effect')).not.toBeNull()
    cleanup()
    gate.settings = { clickEffect: false }
    expect(shell().querySelector('.app-shell')?.hasAttribute('data-click-effect')).toBe(false)
    expect(document.querySelector('canvas.click-effect')).toBeNull()
  })

  it('sends no waves for a press on a composer, but does for one on a menu it opened outside its card', async () => {
    const { container } = render(<><ClickEffect /><form className="thread-prompt"><textarea aria-label="Message" /><button type="button">Send</button><dialog open><button type="button">GPT-5.4</button></dialog></form></>)
    // The composer's card stands at 280..720 by 580..680; jsdom lays nothing out, so its box is given here.
    vi.spyOn(container.querySelector('form')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(280, 580, 440, 100))
    pressAt(container.querySelector('textarea')!, 300, 600)
    pressAt(container.querySelector('button')!, 320, 620)
    pressAt(container.querySelector('form')!, 340, 640)
    await frames(6)
    expect(drawn).toBe(0)
    pressAt(container.querySelector('dialog button')!, 300, 300)
    await frames(6)
    expect(drawn).toBeGreaterThan(0)
  })

  it('sends no waves for a press in the sidebar', async () => {
    const { container } = render(<><ClickEffect /><aside className="thread-nav" aria-label="Thread sidebar"><button type="button">Footer links</button></aside></>)
    pressAt(container.querySelector('aside button')!, 40, 120)
    pressAt(container.querySelector('aside')!, 40, 400)
    await frames(6)
    expect(drawn).toBe(0)
    pressAt(document.body, 600, 300)
    await frames(6)
    expect(drawn).toBeGreaterThan(0)
  })

  it("sends waves for a press on a composer's menu even where the menu stands over the composer's card", async () => {
    const { container } = render(<><ClickEffect /><form className="thread-prompt"><textarea aria-label="Message" /><dialog open><button type="button">GPT-5.4</button></dialog></form></>)
    vi.spyOn(container.querySelector('form')!, 'getBoundingClientRect').mockReturnValue(new DOMRect(280, 580, 440, 100))
    pressAt(container.querySelector('dialog button')!, 300, 600)
    await frames(6)
    expect(drawn).toBeGreaterThan(0)
  })

  it('moves no water for a theme that leaves no room for the glyphs, and starts nothing for a press after, until the theme changes', async () => {
    // Every colour reads as transparent, so the ceiling is nothing.
    stubCanvas([0, 0, 0, 0])
    const step = vi.spyOn(ClickWater.prototype, 'step')
    render(<ClickEffect />)
    pressAt(document.body, 300, 200)
    await frames(6)
    expect(step).not.toHaveBeenCalled()
    expect(drawn).toBe(0)
    const frame = vi.spyOn(window, 'requestAnimationFrame')
    pressAt(document.body, 300, 200)
    expect(frame).not.toHaveBeenCalled()
    // A theme change is read again at the next press.
    document.documentElement.setAttribute('data-theme', 'light')
    await act(async () => { await Promise.resolve() })
    pressAt(document.body, 300, 200)
    expect(frame).toHaveBeenCalledTimes(1)
    await frames(6)
    expect(step).not.toHaveBeenCalled()
    document.documentElement.removeAttribute('data-theme')
  })

  it('stops and clears when it goes, and a press afterwards draws nothing', async () => {
    const { unmount } = render(<ClickEffect />)
    pressAt(document.body, 300, 200)
    await frames(3)
    const before = cleared
    unmount()
    expect(cleared).toBeGreaterThan(before)
    drawn = 0
    pressAt(document.body, 300, 200)
    await frames(6)
    expect(drawn).toBe(0)
  })

  describe("the waves' ceiling", () => {
    const night = { r: 18, g: 19, b: 24 }, teal = { r: 52, g: 190, b: 170 }
    const white = { r: 240, g: 240, b: 245 }, grey = { r: 150, g: 152, b: 160 }

    it("is in hundredths, no more than the effect's own strength, and leaves every word at 4.5:1 over a glyph", () => {
      const ceiling = waveCeiling(night, teal, [white, grey], [])
      expect(Math.round(ceiling * 100)).toBe(ceiling * 100)
      expect(ceiling).toBeGreaterThan(0)
      expect(ceiling).toBeLessThanOrEqual(GLYPH_ALPHA)
      for (const word of [white, grey]) expect(wordContrast(word, over(night, teal, ceiling))).toBeGreaterThanOrEqual(4.5)
    })

    it('counts a translucent fill laid over the waves, and leaves out a word the theme already writes under 4.5:1', () => {
      const bare = waveCeiling(night, teal, [grey], [])
      expect(waveCeiling(night, teal, [grey], [{ r: 255, g: 255, b: 255, a: 0.06 }])).toBeLessThanOrEqual(bare)
      // An opaque fill hides the waves under it; a word that never read is no reason to hold them back.
      expect(waveCeiling(night, teal, [grey], [{ r: 40, g: 42, b: 50 }])).toBe(bare)
      expect(waveCeiling(night, teal, [grey, { r: 30, g: 31, b: 36 }], [])).toBe(bare)
    })

    it('holds a word that reads just over 4.5:1 without the waves at 4.5:1, rather than letting it go', () => {
      const black = { r: 0, g: 0, b: 0 }, justOver = { r: 117, g: 117, b: 117 }
      expect(wordContrast(justOver, black)).toBeGreaterThan(4.5)
      expect(wordContrast(justOver, black)).toBeLessThan(4.6)
      const ceiling = waveCeiling(black, teal, [justOver], [])
      expect(wordContrast(justOver, over(black, teal, ceiling))).toBeGreaterThanOrEqual(4.5)
    })
  })
})
