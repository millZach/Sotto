import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ClickEffect } from '../../../src/renderer/src/components/ClickEffect'
import type { AppSettings } from '../../../src/shared/settings'

// The effect is an Owl feature (ADR-0072); each test says whether this build has it, what the settings say and whether
// motion is reduced.
const gate = vi.hoisted(() => ({ owl: true, reduced: false, settings: undefined as Partial<AppSettings> | undefined }))
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
  useReducedMotion: () => gate.reduced,
}))

const originalGetContext = HTMLCanvasElement.prototype.getContext
let drawn = 0
let cleared = 0

beforeEach(() => {
  vi.useFakeTimers()
  drawn = 0
  cleared = 0
  // jsdom has no canvas; a stand-in counts what the layer draws.
  HTMLCanvasElement.prototype.getContext = (() => ({
    setTransform() {}, scale() {}, fillText() {}, globalAlpha: 1, font: '', fillStyle: '', textAlign: '', textBaseline: '',
    clearRect() { cleared++ }, drawImage() { drawn++ },
  })) as never
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  HTMLCanvasElement.prototype.getContext = originalGetContext
  gate.owl = true
  gate.reduced = false
  gate.settings = undefined
})

const layer = (container: HTMLElement): HTMLCanvasElement | null => container.querySelector('canvas.click-effect')
const pressAt = (target: EventTarget, x: number, y: number, button = 0): void => {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, button }))
}
const frames = (count: number): Promise<void> => act(async () => { await vi.advanceTimersByTimeAsync(count * 17) })

describe('the click effect', () => {
  it('is there, hidden from assistive technology and never pressed, when the build has it and the settings leave it on', () => {
    const { container } = render(<ClickEffect />)
    expect(layer(container)?.getAttribute('aria-hidden')).toBe('true')
    cleanup()
    gate.settings = { clickEffect: true }
    expect(layer(render(<ClickEffect />).container)).not.toBeNull()
  })

  it('does not exist where the build holds it, the switch is off, or motion is reduced', () => {
    gate.owl = false
    expect(layer(render(<ClickEffect />).container)).toBeNull()
    cleanup()
    gate.owl = true
    gate.settings = { clickEffect: false }
    expect(layer(render(<ClickEffect />).container)).toBeNull()
    cleanup()
    gate.settings = { clickEffect: true }
    gate.reduced = true
    expect(layer(render(<ClickEffect />).container)).toBeNull()
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
})
