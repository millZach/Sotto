// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { startMenuBarOwl, menuBarOwlWanted, type MenuBarOwlEnvironment, type MenuBarOwlSettings } from '../../../../src/main/tray/menuBarOwl'
import type { OwlEvent, OwlTimers } from '../../../../src/main/tray/owl/animator'
import { owlFeaturesForTrack } from '../../../../src/shared/owlFeatures'

const OWL_FILES = join(__dirname, '../../../../resources/tray/owl')

class FakeTimers implements OwlTimers {
  time = 1000
  private nextId = 1
  readonly pending = new Map<number, { callback: () => void; at: number }>()
  set(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++
    this.pending.set(id, { callback, at: this.time + delayMs })
    return id
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number)
  }
  now(): number {
    return this.time
  }
  fireNext(): void {
    const [id, timer] = [...this.pending].sort((a, b) => a[1].at - b[1].at)[0]!
    this.pending.delete(id)
    this.time = Math.max(this.time, timer.at)
    timer.callback()
  }
}

interface Frame { readonly png1x: Buffer; readonly png2x: Buffer }

function setup(options: { settings?: Partial<MenuBarOwlSettings>; systemReduced?: boolean; missing?: readonly string[]; stopThrows?: boolean; env?: Partial<MenuBarOwlEnvironment<Frame>> } = {}) {
  const timers = new FakeTimers()
  const shown: Frame[] = []
  const events: OwlEvent[] = []
  const state = { systemReduced: options.systemReduced ?? false, created: 0, reducedListeners: new Set<() => void>(), powerListeners: new Set<(paused: boolean) => void>(), reads: [] as string[] }
  const env: MenuBarOwlEnvironment<Frame> = {
    readOwlFile(name) {
      state.reads.push(name)
      if (options.missing?.includes(name)) return null
      return readFileSync(join(OWL_FILES, name))
    },
    createImage(png1x, png2x) {
      state.created += 1
      return { png1x, png2x }
    },
    systemPrefersReducedMotion: () => state.systemReduced,
    watchSystemReducedMotion(listener) {
      state.reducedListeners.add(listener)
      return () => {
        state.reducedListeners.delete(listener)
        if (options.stopThrows) throw new Error('would not let go')
      }
    },
    watchPower(listener) {
      state.powerListeners.add(listener)
      return () => { state.powerListeners.delete(listener) }
    },
    random: () => 0.5,
    timers,
    log: event => events.push(event),
    ...options.env,
  }
  const settings: MenuBarOwlSettings = { menuBarOwlBody: 'slate', menuBarOwlEyes: 'teal', reducedMotion: 'system', ...options.settings }
  const owl = startMenuBarOwl({ setImage: image => shown.push(image) }, settings, env)
  return { owl, timers, shown, events, state, settings }
}

describe('the menu bar owl is wanted', () => {
  it('on a Mac in an Owl build, and nowhere else', () => {
    const owlBuild = owlFeaturesForTrack('owl')
    const stable = owlFeaturesForTrack('stable')
    expect(menuBarOwlWanted('darwin', owlBuild, false)).toBe(true)
    expect(menuBarOwlWanted('darwin', stable, false)).toBe(false)
    expect(menuBarOwlWanted('win32', owlBuild, false)).toBe(false)
    expect(menuBarOwlWanted('linux', owlBuild, false)).toBe(false)
    expect(menuBarOwlWanted('darwin', owlBuild, true)).toBe(false)
  })
})

describe('starting the menu bar owl', () => {
  it('shows the rest frame of the chosen palette and sets one timer', () => {
    const { owl, shown, timers, events, state } = setup({ settings: { menuBarOwlBody: 'ink', menuBarOwlEyes: 'amber' } })
    expect(owl).not.toBeNull()
    expect(shown).toHaveLength(1)
    expect(shown[0]!.png2x.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(state.reads).toEqual(['manifest.json', 'ink-amber.bin'])
    expect(state.created).toBe(73)
    expect(timers.pending.size).toBe(1)
    expect(events).toEqual(['owl-started'])
  })

  it('sits still when Sotto asks for reduced motion', () => {
    const { shown, timers } = setup({ settings: { reducedMotion: 'on' } })
    expect(shown).toHaveLength(1)
    expect(timers.pending.size).toBe(0)
  })

  it('sits still when the system asks for reduced motion, and follows it live', () => {
    const { owl, shown, timers, state } = setup({ systemReduced: true })
    expect(owl).not.toBeNull()
    expect(timers.pending.size).toBe(0)
    state.systemReduced = false
    for (const listener of state.reducedListeners) listener()
    expect(timers.pending.size).toBe(1)
    state.systemReduced = true
    for (const listener of state.reducedListeners) listener()
    expect(timers.pending.size).toBe(0)
    expect(shown.length).toBeGreaterThanOrEqual(1)
  })

  it('leaves the tray as it is when its frames cannot be read', () => {
    for (const missing of [['manifest.json'], ['slate-teal.bin']]) {
      const { owl, shown, timers, events } = setup({ missing })
      expect(owl).toBeNull()
      expect(shown).toHaveLength(0)
      expect(timers.pending.size).toBe(0)
      expect(events).toEqual(['owl-frames-unavailable'])
    }
  })
})

describe('following the settings', () => {
  it('swaps the frames when a colour changes, and only then', () => {
    const { owl, shown, state, settings } = setup()
    const before = shown.length
    owl!.applySettings({ ...settings, reducedMotion: 'system' })
    expect(state.created).toBe(73)
    owl!.applySettings({ ...settings, menuBarOwlBody: 'ink', menuBarOwlEyes: 'amber' })
    expect(state.created).toBe(146)
    expect(shown.length).toBe(before + 1)
    owl!.applySettings({ ...settings })
    expect(state.created).toBe(146)
    expect(shown.length).toBe(before + 2)
  })

  it('keeps a palette it has made for the next press', () => {
    const { owl, state, settings } = setup()
    owl!.applySettings({ ...settings, menuBarOwlBody: 'light' })
    owl!.applySettings({ ...settings, menuBarOwlBody: 'ink' })
    owl!.applySettings({ ...settings, menuBarOwlBody: 'slate' })
    const made = state.created
    owl!.applySettings({ ...settings, menuBarOwlBody: 'light' })
    expect(state.created).toBe(made)
  })

  it('stops for reduced motion in the settings and starts again', () => {
    const { owl, timers, settings } = setup()
    owl!.applySettings({ ...settings, reducedMotion: 'on' })
    expect(timers.pending.size).toBe(0)
    owl!.applySettings({ ...settings, reducedMotion: 'system' })
    expect(timers.pending.size).toBe(1)
  })

  it('keeps the old colours when the new ones cannot be read', () => {
    const { owl, shown, settings } = setup({ missing: ['light-ice.bin'] })
    const before = shown.length
    owl!.applySettings({ ...settings, menuBarOwlBody: 'light', menuBarOwlEyes: 'ice' })
    expect(shown.length).toBe(before)
    owl!.applySettings({ ...settings, menuBarOwlBody: 'ink' })
    expect(shown.length).toBe(before + 1)
  })
})

describe('the screen locking and the Mac sleeping', () => {
  it('stops the timer while either holds and starts a fresh one after', () => {
    const { timers, state } = setup()
    for (const listener of state.powerListeners) listener(true)
    expect(timers.pending.size).toBe(0)
    for (const listener of state.powerListeners) listener(false)
    expect(timers.pending.size).toBe(1)
  })
})

describe('a failure inside the menu bar owl', () => {
  const broken = (): never => { throw new Error('Electron said no') }

  it('leaves the tray alone and holds nothing when the system will not say whether to move', () => {
    const { owl, shown, timers, events, state } = setup({ env: { systemPrefersReducedMotion: broken } })
    expect(owl).toBeNull()
    expect(shown).toHaveLength(0)
    expect(timers.pending.size).toBe(0)
    expect(events).toEqual(['owl-failed'])
    expect(state.reducedListeners.size + state.powerListeners.size).toBe(0)
  })

  it('stops and lets go of what it took when a watcher cannot start', () => {
    const power = setup({ env: { watchPower: broken } })
    expect(power.owl).toBeNull()
    expect(power.timers.pending.size).toBe(0)
    expect(power.state.reducedListeners.size).toBe(0)
    expect(power.events).toEqual(['owl-started', 'owl-stopped', 'owl-failed'])
    const reduced = setup({ env: { watchSystemReducedMotion: broken } })
    expect(reduced.owl).toBeNull()
    expect(reduced.timers.pending.size).toBe(0)
    expect(reduced.events).toEqual(['owl-started', 'owl-stopped', 'owl-failed'])
  })

  it('stops where it is, and does not throw, when a settings change fails', () => {
    let calls = 0
    const { owl, timers, settings, events, state } = setup({ env: { systemPrefersReducedMotion: () => { calls += 1; if (calls > 1) broken(); return false } } })
    expect(() => owl!.applySettings({ ...settings, menuBarOwlBody: 'ink' })).not.toThrow()
    expect(timers.pending.size).toBe(0)
    expect(events).toEqual(['owl-started', 'owl-stopped', 'owl-failed'])
    expect(state.reducedListeners.size + state.powerListeners.size).toBe(0)
    expect(() => owl!.applySettings({ ...settings, menuBarOwlBody: 'light' })).not.toThrow()
  })

  it('does not let a watcher callback throw out into the system', () => {
    let calls = 0
    const { timers, state, events } = setup({ env: { systemPrefersReducedMotion: () => { calls += 1; if (calls > 1) broken(); return false } } })
    expect(() => { for (const listener of state.reducedListeners) listener() }).not.toThrow()
    expect(timers.pending.size).toBe(0)
    expect(events).toContain('owl-failed')
  })

  it('stops its timer and every other watcher even when one will not let go', () => {
    const { owl, timers, state } = setup({ stopThrows: true })
    expect(() => owl!.dispose()).not.toThrow()
    expect(timers.pending.size).toBe(0)
    expect(state.reducedListeners.size).toBe(0)
    expect(state.powerListeners.size).toBe(0)
  })

  it('tries a palette it could not read only when the choice changes', () => {
    const { owl, state, settings } = setup({ missing: ['light-ice.bin'] })
    const reads = (): number => state.reads.filter(name => name === 'light-ice.bin').length
    owl!.applySettings({ ...settings, menuBarOwlBody: 'light', menuBarOwlEyes: 'ice' })
    expect(reads()).toBe(1)
    owl!.applySettings({ ...settings, menuBarOwlBody: 'light', menuBarOwlEyes: 'ice', reducedMotion: 'on' })
    owl!.applySettings({ ...settings, menuBarOwlBody: 'light', menuBarOwlEyes: 'ice', reducedMotion: 'system' })
    expect(reads()).toBe(1)
    owl!.applySettings({ ...settings, menuBarOwlBody: 'ink', menuBarOwlEyes: 'ice' })
    owl!.applySettings({ ...settings, menuBarOwlBody: 'light', menuBarOwlEyes: 'ice' })
    expect(reads()).toBe(2)
  })
})

describe('stopping the menu bar owl', () => {
  it('clears its timer, lets go of both watchers and ignores later changes', () => {
    const { owl, timers, state, shown, settings } = setup()
    const before = shown.length
    owl!.dispose()
    expect(timers.pending.size).toBe(0)
    expect(state.reducedListeners.size).toBe(0)
    expect(state.powerListeners.size).toBe(0)
    owl!.applySettings({ ...settings, menuBarOwlBody: 'ink' })
    owl!.dispose()
    expect(shown.length).toBe(before)
    expect(timers.pending.size).toBe(0)
  })

  it('swaps the picture on a timer while it runs', () => {
    const { timers, shown } = setup()
    const before = shown.length
    for (let i = 0; i < 40; i++) timers.fireNext()
    expect(shown.length).toBeGreaterThan(before + 10)
    expect(timers.pending.size).toBe(1)
  })
})
