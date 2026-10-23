// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { frontEdge, NIGHT_FALLS_MS, nightFallsAvailable, playNightFalls, revealPolygon } from '../../../src/renderer/src/watcher/nightFalls'
import { NightFallsSettings, speedLabel } from '../../../src/renderer/src/features/settings/NightFallsSettings'

type StartViewTransition = (update: () => void) => ViewTransition

/** A stand-in for the View Transitions API: runs the update at once and settles when told. */
function fakeViewTransitions(): { finish: () => Promise<void>, skipped: () => number } {
  let finish = (): void => {}
  let skips = 0
  const finished = new Promise<void>(resolve => { finish = resolve })
  const start: StartViewTransition = update => {
    update()
    return { ready: Promise.resolve(), finished, updateCallbackDone: Promise.resolve(), skipTransition: () => { skips++ }, types: new Set() } as unknown as ViewTransition
  }
  Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start })
  document.documentElement.animate = vi.fn() as never
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} }) as never
  return { finish: async () => { finish(); await finished; await Promise.resolve() }, skipped: () => skips }
}

afterEach(() => {
  cleanup()
  delete (document as { startViewTransition?: unknown }).startViewTransition
  delete document.documentElement.dataset.roomTransition
  delete document.documentElement.dataset.reducedMotion
  vi.restoreAllMocks()
})

describe('the night falls front', () => {
  it('starts off the window and ends past it, left to right going in and right to left going back', () => {
    for (const x of frontEdge(0, 1280, 10, true)) expect(x).toBeLessThan(0)
    for (const x of frontEdge(1, 1280, 10, true)) expect(x).toBeGreaterThan(1280)
    for (const x of frontEdge(0, 1280, 10, false)) expect(x).toBeGreaterThan(1280)
    for (const x of frontEdge(1, 1280, 10, false)) expect(x).toBeLessThan(0)
  })

  it('is ragged by at most one cell and the same on every run', () => {
    const edge = frontEdge(0.5, 1280, 60, true)
    expect(Math.max(...edge) - Math.min(...edge)).toBeLessThanOrEqual(14)
    expect(frontEdge(0.5, 1280, 60, true)).toEqual(edge)
  })

  it('reveals nothing of the opened page at the start and all of it at the end', () => {
    const xs = (polygon: string): number[] => [...polygon.matchAll(/(-?\d+)px -?\d+px/g)].map(m => Number(m[1]))
    expect(Math.max(...xs(revealPolygon(0, 1280, 800, true)))).toBeLessThanOrEqual(0)
    expect(Math.min(...xs(revealPolygon(0, 1280, 800, false)))).toBeGreaterThanOrEqual(1280)
    const end = revealPolygon(1, 1280, 800, true)
    expect(end).toContain('1281px 0px')
    expect(revealPolygon(0, 1280, 800, false)).toMatch(/^polygon\(1280px 0px/)
  })
})

describe('playing night falls', () => {
  it('swaps the page at once where view transitions are missing', () => {
    const update = vi.fn()
    expect(nightFallsAvailable()).toBe(false)
    playNightFalls(update, { forward: true, speed: 1 })
    expect(update).toHaveBeenCalledOnce()
    expect(document.querySelector('.night-falls-band')).toBeNull()
  })

  it('swaps the page at once under Sotto\'s reduced motion', () => {
    fakeViewTransitions()
    document.documentElement.dataset.reducedMotion = 'on'
    const update = vi.fn()
    playNightFalls(update, { forward: true, speed: 1 })
    expect(update).toHaveBeenCalledOnce()
    expect(document.documentElement.dataset.roomTransition).toBeUndefined()
  })

  it('runs the swap inside a view transition with the band, the clip and the speed, then clears up', async () => {
    const fake = fakeViewTransitions()
    const update = vi.fn()
    playNightFalls(update, { forward: false, speed: 2 })
    expect(update).toHaveBeenCalledOnce()
    expect(document.documentElement.dataset.roomTransition).toBe('out')
    expect(document.documentElement.style.getPropertyValue('--room-transition-ms')).toBe(`${NIGHT_FALLS_MS / 2}ms`)
    expect(document.querySelector('.night-falls-band')).not.toBeNull()
    await act(async () => { await Promise.resolve() })
    const animate = document.documentElement.animate as unknown as ReturnType<typeof vi.fn>
    expect(animate).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ duration: NIGHT_FALLS_MS / 2, pseudoElement: '::view-transition-new(root)' }))
    await fake.finish()
    expect(document.querySelector('.night-falls-band')).toBeNull()
    expect(document.documentElement.dataset.roomTransition).toBeUndefined()
    expect(document.documentElement.style.getPropertyValue('--room-transition-ms')).toBe('')
  })

  it('keeps the speed on the dial', () => {
    fakeViewTransitions()
    playNightFalls(() => {}, { forward: true, speed: 9 })
    expect(document.documentElement.style.getPropertyValue('--room-transition-ms')).toBe(`${NIGHT_FALLS_MS / 2}ms`)
  })
})

describe('night falls settings', () => {
  it('names the speed the way the dial shows it', () => {
    expect(speedLabel(1)).toBe('1x')
    expect(speedLabel(0.75)).toBe('0.75x')
    expect(speedLabel(1.5)).toBe('1.5x')
  })

  it('switches night falls off and saves the speed when the dial is let go', () => {
    const onSave = vi.fn()
    render(<NightFallsSettings settings={{ roomTransition: true, roomTransitionSpeed: 1 }} onSave={onSave} />)
    fireEvent.click(screen.getByRole('switch', { name: /Night falls between Threads and Watcher/ }))
    expect(onSave).toHaveBeenCalledWith({ roomTransition: false })
    const dial = screen.getByRole('slider', { name: 'Night falls speed' })
    fireEvent.change(dial, { target: { value: '1.5' } })
    expect(onSave).not.toHaveBeenCalledWith({ roomTransitionSpeed: 1.5 })
    fireEvent.pointerUp(dial)
    expect(onSave).toHaveBeenCalledWith({ roomTransitionSpeed: 1.5 })
    expect(screen.getByText('1.5x')).toBeTruthy()
  })

  it('rests the dial while night falls is off', () => {
    render(<NightFallsSettings settings={{ roomTransition: false, roomTransitionSpeed: 1 }} onSave={() => {}} />)
    expect((screen.getByRole('slider', { name: 'Night falls speed' }) as HTMLInputElement).disabled).toBe(true)
  })
})
