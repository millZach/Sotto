// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  cancelNightFalls, frontEdge, frontStar, frontTimeAt, NIGHT_FALLS_MS, nightFallsAvailable, nightFallsRun, nightFallsShipped, playNightFalls, revealPolygon, STARS,
  starsCells, starsInk, TRAIL, trailMark, trailStrength,
} from '../../../src/renderer/src/watcher/nightFalls'
import { inkAt, LIGHT_ACCENT_BOOST } from '../../../src/renderer/src/watcher/nightScene'
import { settingsIndex } from '../../../src/renderer/src/features/settings/settingsPages'
import { owlFeaturesForTrack } from '../../../src/shared/owlFeatures'
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

/**
 * A canvas that remembers every glyph written on it and the ink it was written in, and reads back the colour last filled
 * as its pixel, so the Stars look can read the theme's colours. Frames are held until `frame` runs the next one.
 */
function fakeCanvas(): { glyphs: string[], inks: string[], frame: (elapsed: number) => void } {
  const glyphs: string[] = [], inks: string[] = []
  let fill = ''
  const ctx = {
    font: '', textBaseline: '', globalAlpha: 1,
    get fillStyle() { return fill },
    set fillStyle(value: string) { fill = value },
    setTransform() {}, clearRect() {}, fillRect() {},
    fillText(glyph: string) { glyphs.push(glyph); inks.push(fill) },
    getImageData() {
      const rgb = /^rgb\((\d+), (\d+), (\d+)\)$/u.exec(fill)
      return { data: rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), 255] : [0, 0, 0, 0] }
    },
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const root = document.documentElement.style
  root.setProperty('--tt-canvas', 'rgb(16, 18, 24)')
  root.setProperty('--tt-text', 'rgb(230, 232, 238)')
  root.setProperty('--tt-accent', 'rgb(120, 160, 255)')
  return { glyphs, inks, frame: elapsed => frames.shift()?.(performance.now() + elapsed) }
}

afterEach(() => {
  cleanup()
  cancelNightFalls()
  // A run whose fake transition never finished leaves its canvas behind.
  for (const band of document.querySelectorAll('.night-falls-band')) band.remove()
  vi.unstubAllGlobals()
  for (const name of ['--tt-canvas', '--tt-text', '--tt-accent']) document.documentElement.style.removeProperty(name)
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

  it('reaches a point later the further along the way it is, in either direction', () => {
    expect(frontTimeAt(40, 1280, true)).toBeLessThan(frontTimeAt(560, 1280, true))
    expect(frontTimeAt(560, 1280, false)).toBeLessThan(frontTimeAt(40, 1280, false))
    expect(frontTimeAt(-500, 1280, true)).toBeCloseTo(0, 6)
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

describe('the night falls Owl gate', () => {
  it('is on in Owl and off in stable, and needs Watcher\'s room as well as its own feature', () => {
    expect(nightFallsShipped({ owlFeatures: owlFeaturesForTrack('owl') } as never)).toBe(true)
    expect(nightFallsShipped({ owlFeatures: owlFeaturesForTrack('stable') } as never)).toBe(false)
    expect(nightFallsShipped({ owlFeatures: { ...owlFeaturesForTrack('owl'), watcher: false } } as never)).toBe(false)
    expect(nightFallsShipped({ owlFeatures: { ...owlFeaturesForTrack('owl'), 'night-falls': false } } as never)).toBe(false)
  })

  it('stays off when main has not answered, including the old Watcher-only alias', () => {
    expect(nightFallsShipped(null)).toBe(false)
    expect(nightFallsShipped({ watcherEnabled: true } as never)).toBe(false)
  })

  it('keeps its settings out of Find a setting unless its gate is open', () => {
    const entries = settingsIndex('win32').filter(entry => entry.label.startsWith('Night falls'))
    expect(entries.map(entry => entry.id)).toEqual(['night-falls', 'night-falls-look', 'night-falls-speed'])
    for (const entry of entries) expect(entry.gate).toBe('night-falls')
  })
})

describe('the run a move plays', () => {
  const owl = { owlFeatures: owlFeaturesForTrack('owl') } as never
  const stars = { roomTransition: true, roomTransitionSpeed: 1.5, roomTransitionLook: 'stars' } as const
  // A run can play only where view transitions exist and motion is not reduced.
  beforeEach(() => { fakeViewTransitions() })

  it('plays the look and the speed set, the way the move goes', () => {
    expect(nightFallsRun('threads', 'watcher', owl, stars)).toEqual({ forward: true, speed: 1.5, look: 'stars' })
    expect(nightFallsRun('watcher', 'threads', owl, { ...stars, roomTransitionLook: 'band' })).toEqual({ forward: false, speed: 1.5, look: 'band' })
  })

  it('plays nothing where night falls is not shipped, whatever look is set', () => {
    expect(nightFallsRun('threads', 'watcher', { owlFeatures: owlFeaturesForTrack('stable') } as never, stars)).toBeNull()
    expect(nightFallsRun('threads', 'watcher', null, stars)).toBeNull()
  })

  it('plays nothing with the switch off, or for a move that is not between the rooms', () => {
    expect(nightFallsRun('threads', 'watcher', owl, { ...stars, roomTransition: false })).toBeNull()
    expect(nightFallsRun('threads', 'settings', owl, stars)).toBeNull()
    expect(nightFallsRun('watcher', 'watcher', owl, stars)).toBeNull()
  })

  it('plays the band at speed 1 before the settings are read', () => {
    expect(nightFallsRun('threads', 'watcher', owl, null)).toEqual({ forward: true, speed: 1, look: 'band' })
  })

  it('plays nothing and never reads the look under reduced motion', () => {
    document.documentElement.dataset.reducedMotion = 'on'
    let lookReads = 0
    const settings = { roomTransition: true, roomTransitionSpeed: 1, get roomTransitionLook() { lookReads++; return 'stars' as const } }
    expect(nightFallsRun('threads', 'watcher', owl, settings)).toBeNull()
    expect(lookReads).toBe(0)
  })

  it('plays nothing where view transitions do not exist', () => {
    delete (document as { startViewTransition?: unknown }).startViewTransition
    expect(nightFallsRun('threads', 'watcher', owl, stars)).toBeNull()
  })
})

describe('the Stars look', () => {
  it('gives each row the same star at the same flicker step, and leaves about a quarter of the rows without one', () => {
    const rows = Array.from({ length: 400 }, (_, row) => frontStar(row, 7))
    expect(Array.from({ length: 400 }, (_, row) => frontStar(row, 7))).toEqual(rows)
    for (const star of rows) if (star !== null) expect(STARS).toContain(star.glyph)
    const empty = rows.filter(star => star === null).length
    expect(empty).toBeGreaterThan(60)
    expect(empty).toBeLessThan(140)
    expect(new Set(Array.from({ length: 20 }, (_, step) => frontStar(1, step)?.glyph)).size).toBeGreaterThan(1)
  })

  it('thins the trail with distance: fewer cells, fainter, and none past its length', () => {
    expect(trailStrength(0)).toBe(1)
    expect(trailStrength(TRAIL / 2)).toBeCloseTo(0.5, 6)
    expect(trailStrength(TRAIL)).toBe(0)
    const shown = (cells: number): number => {
      let count = 0
      for (let row = 0; row < 60; row++) for (let col = 0; col < 60; col++) if (trailMark(cells, col, row, 3) !== null) count++
      return count
    }
    expect(shown(1)).toBeGreaterThan(shown(8))
    expect(shown(8)).toBeGreaterThan(shown(16))
    expect(shown(TRAIL / 7)).toBe(0)
    const marks = (cells: number): number[] => Array.from({ length: 400 }, (_, col) => trailMark(cells, col, 0, 0)?.strength).filter((value): value is number => value !== undefined)
    expect(Math.min(...marks(2))).toBeGreaterThan(Math.max(...marks(14)))
  })

  it('puts each row\'s star on the edge the room is revealed to, with the trail behind it in the room being opened', () => {
    for (const forward of [true, false]) {
      const cells = starsCells(0.5, 300, 1280, 800, forward)
      const edge = frontEdge(0.5, 1280, Math.ceil(800 / 12), forward)
      const fronts = cells.filter(cell => cell.ink === 'accent')
      expect(fronts).toHaveLength(edge.length)
      for (const cell of fronts) {
        const x = edge[cell.y / 12]!
        expect(cell.ground).toBe(true)
        expect(x).toBeGreaterThanOrEqual(cell.x)
        expect(x).toBeLessThan(cell.x + 7)
      }
      const trail = cells.filter(cell => cell.ink === 'text')
      expect(trail.length).toBeGreaterThan(0)
      for (const cell of trail) {
        const star = fronts.find(front => front.y === cell.y)!
        if (forward) expect(cell.x).toBeLessThan(star.x)
        else expect(cell.x).toBeGreaterThan(star.x)
        expect(Math.abs(cell.x - star.x)).toBeLessThan(TRAIL)
      }
    }
  })

  it('paints nothing before the front comes in or once it and its trail have left the window', () => {
    expect(starsCells(0, 0, 1280, 800, true)).toEqual([])
    expect(starsCells(1, NIGHT_FALLS_MS, 1280, 800, true)).toEqual([])
    expect(starsCells(1, NIGHT_FALLS_MS, 1280, 800, false)).toEqual([])
  })

  it('takes the accent stronger on a light surface, as the night scene does', () => {
    const dark = starsInk({ r: 16, g: 18, b: 24 }, { r: 230, g: 232, b: 238 }, { r: 120, g: 160, b: 255 })
    const light = starsInk({ r: 250, g: 250, b: 250 }, { r: 20, g: 20, b: 24 }, { r: 40, g: 80, b: 200 })
    expect(dark.ground).toBe('rgb(16, 18, 24)')
    expect(inkAt(dark.accent, 0.5)).toBe('rgba(120, 160, 255, 0.50)')
    expect(inkAt(light.accent, 0.5)).toBe(`rgba(40, 80, 200, ${(0.5 * LIGHT_ACCENT_BOOST).toFixed(2)})`)
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

  it('clears up when the transition cannot start, and the page still changes', async () => {
    const update = vi.fn()
    const start: StartViewTransition = cb => { cb(); return { ready: Promise.reject(new Error('InvalidStateError')), finished: Promise.resolve(), updateCallbackDone: Promise.resolve(), skipTransition() {} } as unknown as ViewTransition }
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: start })
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} }) as never
    playNightFalls(update, { forward: true, speed: 1 })
    expect(update).toHaveBeenCalledOnce()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(document.querySelector('.night-falls-band')).toBeNull()
    expect(document.documentElement.dataset.roomTransition).toBeUndefined()
  })

  it('cancels the clip when the run ends, and a second run skips the first', async () => {
    const fake = fakeViewTransitions()
    const cancel = vi.fn()
    document.documentElement.animate = vi.fn().mockReturnValue({ cancel }) as never
    playNightFalls(() => {}, { forward: true, speed: 1 })
    await act(async () => { await Promise.resolve() })
    playNightFalls(() => {}, { forward: false, speed: 1 })
    expect(fake.skipped()).toBe(1)
    await fake.finish()
    expect(cancel).toHaveBeenCalled()
    expect(document.querySelectorAll('.night-falls-band')).toHaveLength(0)
  })

  it('paints stars, not the band, with Stars set, in the theme\'s accent', async () => {
    fakeViewTransitions()
    const canvas = fakeCanvas()
    playNightFalls(() => {}, { forward: true, speed: 1, look: 'stars' })
    await act(async () => { await Promise.resolve() })
    canvas.frame(NIGHT_FALLS_MS * 0.4)
    expect(canvas.glyphs).toContain('·')
    expect(canvas.glyphs.filter(glyph => '#%@'.includes(glyph))).toEqual([])
    expect(canvas.inks.some(ink => ink.startsWith('rgba(120, 160, 255,'))).toBe(true)
  })

  it.each([['band' as const], [undefined]])('paints the band with the look %s', async look => {
    fakeViewTransitions()
    const canvas = fakeCanvas()
    playNightFalls(() => {}, { forward: true, speed: 1, ...look ? { look } : {} })
    await act(async () => { await Promise.resolve() })
    canvas.frame(NIGHT_FALLS_MS * 0.4)
    expect(canvas.glyphs.some(glyph => '#%@'.includes(glyph))).toBe(true)
    expect(canvas.glyphs).not.toContain('·')
  })

  it('swaps the page at once under reduced motion with Stars set, and starts no transition', () => {
    fakeViewTransitions()
    const start = vi.spyOn(document, 'startViewTransition')
    document.documentElement.dataset.reducedMotion = 'on'
    const update = vi.fn()
    playNightFalls(update, { forward: true, speed: 1, look: 'stars' })
    expect(update).toHaveBeenCalledOnce()
    expect(start).not.toHaveBeenCalled()
    expect(document.querySelector('.night-falls-band')).toBeNull()
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
    render(<NightFallsSettings settings={{ roomTransition: true, roomTransitionSpeed: 1, roomTransitionLook: 'band' }} onSave={onSave} />)
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
    render(<NightFallsSettings settings={{ roomTransition: false, roomTransitionSpeed: 1, roomTransitionLook: 'band' }} onSave={() => {}} />)
    expect((screen.getByRole('slider', { name: 'Night falls speed' }) as HTMLInputElement).disabled).toBe(true)
  })
})
