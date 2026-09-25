import { describe, expect, it } from 'vitest'
import {
  BROWSER_PLAYER_MIN_HEIGHT, BROWSER_PLAYER_MIN_WIDTH, BROWSER_PLAYER_MOVE_STEP, BROWSER_PLAYER_MOVE_STEP_LARGE, BROWSER_PLAYER_STRIP_HEIGHT,
  BrowserPlayerStore, clampBrowserPlayerRect,
} from '../../../../src/renderer/src/tools/browserPlayerStore'

const WINDOW = { width: 1280, height: 800 }

describe('clampBrowserPlayerRect', () => {
  it('keeps a rectangle already inside the window untouched', () => {
    const rect = { x: 800, y: 500, width: 340, height: 250 }
    expect(clampBrowserPlayerRect(rect, WINDOW)).toEqual(rect)
  })
  it('pulls a rectangle back inside the window on every edge, and below the drag strip', () => {
    expect(clampBrowserPlayerRect({ x: -50, y: 10, width: 340, height: 250 }, WINDOW)).toMatchObject({ x: 0, y: BROWSER_PLAYER_STRIP_HEIGHT })
    expect(clampBrowserPlayerRect({ x: 2000, y: 500, width: 340, height: 250 }, WINDOW)).toMatchObject({ x: WINDOW.width - 340 })
    expect(clampBrowserPlayerRect({ x: 800, y: 900, width: 340, height: 250 }, WINDOW)).toMatchObject({ y: WINDOW.height - 250 })
  })
  it('never lets the rectangle sit above the drag strip', () => {
    expect(clampBrowserPlayerRect({ x: 100, y: 0, width: 340, height: 250 }, WINDOW).y).toBe(BROWSER_PLAYER_STRIP_HEIGHT)
  })
  it('enforces the minimum size, growing rather than shrinking below it', () => {
    const clamped = clampBrowserPlayerRect({ x: 100, y: 100, width: 100, height: 50 }, WINDOW)
    expect(clamped.width).toBe(BROWSER_PLAYER_MIN_WIDTH)
    expect(clamped.height).toBe(BROWSER_PLAYER_MIN_HEIGHT)
  })
  it('shrinks a placement that no longer fits a smaller window, keeping it inside', () => {
    const clamped = clampBrowserPlayerRect({ x: 100, y: 100, width: 340, height: 250 }, { width: 300, height: 260 })
    expect(clamped.width).toBeLessThanOrEqual(300)
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(300)
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(260)
  })
})

describe('BrowserPlayerStore placement', () => {
  it('computes a default placement inside the window before anything is ever moved', () => {
    const store = new BrowserPlayerStore()
    expect(store.getRect()).toBeNull()
    const rect = store.rectFor(WINDOW)
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.y).toBeGreaterThanOrEqual(BROWSER_PLAYER_STRIP_HEIGHT)
    expect(rect.x + rect.width).toBeLessThanOrEqual(WINDOW.width)
    expect(rect.y + rect.height).toBeLessThanOrEqual(WINDOW.height)
  })
  it('is one placement for every thread: moving it for one thread moves it for all of them', () => {
    const store = new BrowserPlayerStore()
    store.move(50, 20, WINDOW)
    const afterWorkshop = store.rectFor(WINDOW)
    // A different thread reads the very same placement; there is nothing thread-keyed about it.
    expect(store.rectFor(WINDOW)).toEqual(afterWorkshop)
  })
  it('moves by the arrow-key step, and further with the large step', () => {
    const store = new BrowserPlayerStore()
    // Well clear of every edge, so the clamp never masks the step size being asserted.
    store.setRect({ x: 400, y: 300, width: 340, height: 250 }, WINDOW)
    const start = store.rectFor(WINDOW)
    store.move(BROWSER_PLAYER_MOVE_STEP, 0, WINDOW)
    expect(store.rectFor(WINDOW).x).toBe(start.x + BROWSER_PLAYER_MOVE_STEP)
    store.move(BROWSER_PLAYER_MOVE_STEP_LARGE, 0, WINDOW)
    expect(store.rectFor(WINDOW).x).toBe(start.x + BROWSER_PLAYER_MOVE_STEP + BROWSER_PLAYER_MOVE_STEP_LARGE)
  })
  it('resizes down to the minimum and no further', () => {
    const store = new BrowserPlayerStore()
    store.resize(50, 50, WINDOW)
    expect(store.rectFor(WINDOW)).toMatchObject({ width: BROWSER_PLAYER_MIN_WIDTH, height: BROWSER_PLAYER_MIN_HEIGHT })
  })
  it('leaves a placement that still fits alone when the window resizes, and pulls in one that does not', () => {
    const store = new BrowserPlayerStore()
    store.setRect({ x: 100, y: 100, width: 340, height: 250 }, WINDOW)
    store.reclamp({ width: 1600, height: 1000 })
    expect(store.getRect()).toEqual({ x: 100, y: 100, width: 340, height: 250 })
    store.reclamp({ width: 300, height: 260 })
    const shrunk = store.getRect()!
    expect(shrunk.x + shrunk.width).toBeLessThanOrEqual(300)
    expect(shrunk.y + shrunk.height).toBeLessThanOrEqual(260)
  })
  it('notifies subscribers only when the placement actually changes', () => {
    const store = new BrowserPlayerStore()
    let notified = 0
    store.subscribe(() => { notified++ })
    store.reclamp(WINDOW) // no placement set yet: nothing to reclamp
    expect(notified).toBe(0)
    store.move(10, 0, WINDOW)
    expect(notified).toBe(1)
    store.reclamp(WINDOW) // already fits: no change
    expect(notified).toBe(1)
  })
})

describe('BrowserPlayerStore visibility', () => {
  it('starts hidden for a thread it has not seen a task for', () => {
    const store = new BrowserPlayerStore()
    expect(store.visibilityFor('workshop')).toBe('hidden')
  })
  it('opens on a new task when auto-show is on, and keeps threads independent', () => {
    const store = new BrowserPlayerStore()
    store.taskSeen('workshop', 'task-1', true)
    store.taskSeen('docs', 'task-2', false)
    expect(store.visibilityFor('workshop')).toBe('open')
    expect(store.visibilityFor('docs')).toBe('hidden')
  })
  it('leaves a shrink or hide alone while the same task keeps working', () => {
    const store = new BrowserPlayerStore()
    store.taskSeen('workshop', 'task-1', true)
    store.shrink('workshop')
    store.taskSeen('workshop', 'task-1', true) // the same task, progress only
    expect(store.visibilityFor('workshop')).toBe('shrunk')
  })
  it('opens again for a genuinely new task, overriding what the last one was left at', () => {
    const store = new BrowserPlayerStore()
    store.taskSeen('workshop', 'task-1', true)
    store.hide('workshop')
    store.taskSeen('workshop', 'task-2', true)
    expect(store.visibilityFor('workshop')).toBe('open')
  })
  it('restore and hide move a thread between states directly', () => {
    const store = new BrowserPlayerStore()
    store.taskSeen('workshop', 'task-1', true)
    store.shrink('workshop')
    expect(store.visibilityFor('workshop')).toBe('shrunk')
    store.restore('workshop')
    expect(store.visibilityFor('workshop')).toBe('open')
    store.hide('workshop')
    expect(store.visibilityFor('workshop')).toBe('hidden')
  })
})
