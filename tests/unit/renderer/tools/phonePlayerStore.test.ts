import { describe, expect, it } from 'vitest'
import { TEST_IPHONE } from '../../../../src/shared/browser'
import { BROWSER_PLAYER_STRIP_HEIGHT } from '../../../../src/renderer/src/tools/browserPlayerStore'
import { clampPhonePoint, phoneLayout, PhonePlayerStore } from '../../../../src/renderer/src/tools/phonePlayerStore'

const WINDOW = { width: 1280, height: 800 }
/** The narrowest the label above the phone is allowed to make the player (`phonePlayerStore.ts`'s private `LABEL_WIDTH`). */
const LABEL_WIDTH = 292

describe('phoneLayout', () => {
  it('always lays the screen out at the test iPhone’s 393:852 shape', () => {
    const layout = phoneLayout('medium', WINDOW)
    expect(layout.screen.height / layout.screen.width).toBeCloseTo(TEST_IPHONE.height / TEST_IPHONE.width, 2)
    const large = phoneLayout('large', WINDOW)
    expect(large.screen.height / large.screen.width).toBeCloseTo(TEST_IPHONE.height / TEST_IPHONE.width, 2)
  })
  it('shrinks to fit a short window rather than running off the bottom', () => {
    const short = { width: 820, height: 560 }
    const layout = phoneLayout('medium', short)
    // The whole player (label, phone and status) must fit below the drag strip with the usual edge gap.
    expect(layout.height).toBeLessThanOrEqual(short.height - BROWSER_PLAYER_STRIP_HEIGHT - 32)
    // Unclamped by a short window, medium is wider than that.
    const tall = phoneLayout('medium', { width: 1600, height: 1000 })
    expect(layout.screen.width).toBeLessThan(tall.screen.width)
  })
  it('never shrinks the screen narrower than 120, however short the window', () => {
    const tiny = { width: 400, height: 150 }
    const layout = phoneLayout('large', tiny)
    expect(layout.screen.width).toBeGreaterThanOrEqual(120)
  })
  it('never makes the whole player narrower than the label above it', () => {
    const tiny = { width: 400, height: 150 }
    const layout = phoneLayout('large', tiny)
    expect(layout.screen.width).toBe(120) // clamped to the minimum, well under the label's width
    expect(layout.width).toBeGreaterThanOrEqual(LABEL_WIDTH)
  })
  it('fits a smaller screen in when the chrome (label and status) grows, at the same window size', () => {
    const window = { width: 1280, height: 800 }
    const roomy = phoneLayout('medium', window, 124)
    const cramped = phoneLayout('medium', window, 700)
    expect(cramped.screen.width).toBeLessThan(roomy.screen.width)
  })
})

describe('clampPhonePoint', () => {
  const layout = phoneLayout('medium', WINDOW)
  it('keeps a point already inside the window untouched', () => {
    const point = { x: 800, y: 100 }
    expect(clampPhonePoint(point, layout, WINDOW)).toEqual(point)
  })
  it('pulls a point back inside the window on every edge, and below the drag strip', () => {
    expect(clampPhonePoint({ x: -50, y: 10 }, layout, WINDOW)).toMatchObject({ x: 0, y: BROWSER_PLAYER_STRIP_HEIGHT })
    expect(clampPhonePoint({ x: 2000, y: 300 }, layout, WINDOW)).toMatchObject({ x: WINDOW.width - layout.width })
    expect(clampPhonePoint({ x: 800, y: 2000 }, layout, WINDOW)).toMatchObject({ y: WINDOW.height - layout.height })
  })
  it('never lets the player sit above the drag strip', () => {
    expect(clampPhonePoint({ x: 100, y: 0 }, layout, WINDOW).y).toBe(BROWSER_PLAYER_STRIP_HEIGHT)
  })
})

describe('PhonePlayerStore taskSeen', () => {
  it('opens on a new task when auto-show is on, and keeps threads independent', () => {
    const store = new PhonePlayerStore()
    store.taskSeen('workshop', 'task-1', true)
    store.taskSeen('docs', 'task-2', false)
    expect(store.isOpen('workshop')).toBe(true)
    expect(store.isOpen('docs')).toBe(false)
  })
  it('leaves a hide alone while the same task keeps progressing, never reopening it', () => {
    const store = new PhonePlayerStore()
    store.taskSeen('workshop', 'task-1', true)
    store.hide('workshop')
    store.taskSeen('workshop', 'task-1', true) // the same task, progress only
    expect(store.isOpen('workshop')).toBe(false)
  })
  it('opens again for a genuinely new task, overriding what the last one was left at', () => {
    const store = new PhonePlayerStore()
    store.taskSeen('workshop', 'task-1', true)
    store.hide('workshop')
    store.taskSeen('workshop', 'task-2', true)
    expect(store.isOpen('workshop')).toBe(true)
  })
  it('stays hidden for every task while auto-show is off', () => {
    const store = new PhonePlayerStore()
    store.taskSeen('workshop', 'task-1', false)
    store.taskSeen('workshop', 'task-2', false)
    expect(store.isOpen('workshop')).toBe(false)
  })
})

describe('PhonePlayerStore show/hide', () => {
  it('is per thread: hiding one thread’s phone leaves another’s alone', () => {
    const store = new PhonePlayerStore()
    store.show('workshop')
    store.show('docs')
    store.hide('workshop')
    expect(store.isOpen('workshop')).toBe(false)
    expect(store.isOpen('docs')).toBe(true)
  })
  it('starts hidden for a thread it has not seen a task for', () => {
    const store = new PhonePlayerStore()
    expect(store.isOpen('workshop')).toBe(false)
  })
})

describe('PhonePlayerStore setSize', () => {
  it('changes the placement size and notifies subscribers only on an actual change', () => {
    const store = new PhonePlayerStore()
    expect(store.placement().size).toBe('medium')
    let notified = 0
    store.subscribe(() => { notified++ })
    store.setSize('medium') // already medium: no change
    expect(notified).toBe(0)
    store.setSize('large')
    expect(notified).toBe(1)
    expect(store.placement().size).toBe('large')
  })
})
