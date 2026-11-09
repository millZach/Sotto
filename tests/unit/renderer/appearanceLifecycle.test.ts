import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GlassWindowBridge } from '../../../src/shared/glassWindow'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'
import { GLASS_THEME_ID } from '../../../src/shared/themes/glass'
import { deferred } from '../../fixtures/deferred'

const glassChoice = { ...DEFAULT_SETTINGS, lightTheme: GLASS_THEME_ID, darkTheme: GLASS_THEME_ID, customThemes: [] }
let stop: (() => void) | undefined

afterEach(() => {
  stop?.()
  stop = undefined
  vi.unstubAllGlobals()
})

function glassBridge(seeThrough = false) {
  let changed: ((value: boolean) => void) | undefined
  const unsubscribe = vi.fn()
  const bridge: GlassWindowBridge = {
    material: 'vibrancy',
    seeThrough,
    setSeeThrough: vi.fn(async on => on),
    onChanged: vi.fn(listener => { changed = listener; return unsubscribe }),
  }
  return { bridge, unsubscribe, changed: (value: boolean) => changed?.(value) }
}

async function loadAppearance(bridge?: GlassWindowBridge) {
  vi.stubGlobal('sotto', bridge === undefined ? undefined : { glassWindow: bridge })
  vi.resetModules()
  return import('../../../src/renderer/src/state/appearance')
}

describe('appearance subscription lifetime', () => {
  it('starts explicitly before the main window first paints and reuses its subscription', async () => {
    const { bridge, changed, unsubscribe } = glassBridge(true)
    const { startAppearance, applyAppearance } = await loadAppearance(bridge)
    expect(bridge.onChanged).not.toHaveBeenCalled()
    const root = document.createElement('html')
    stop = startAppearance(root)
    expect(startAppearance(root)).toBe(stop)
    expect(bridge.onChanged).toHaveBeenCalledOnce()
    applyAppearance(glassChoice, root, true)
    expect(root.dataset.glass).toBe('see-through')
    expect(bridge.setSeeThrough).not.toHaveBeenCalled()
    changed(false)
    expect(root.dataset.glass).toBe('in-app')
    changed(true)
    expect(root.dataset.glass).toBe('see-through')
    stop()
    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
    changed(false)
    expect(root.dataset.glass).toBe('see-through')
  })

  it('paints the popup without a Glass bridge and can start again after a bridge arrives', async () => {
    const { startAppearance, applyAppearance } = await loadAppearance()
    const root = document.createElement('html')
    stop = startAppearance(root)
    expect(startAppearance(root)).toBe(stop)
    applyAppearance(glassChoice, root, true)
    expect(root.dataset.glass).toBeUndefined()
    const { bridge, changed } = glassBridge(true)
    vi.stubGlobal('sotto', { glassWindow: bridge })
    stop = startAppearance(root)
    applyAppearance(glassChoice, root, true)
    expect(root.dataset.glass).toBe('see-through')
    changed(false)
    expect(root.dataset.glass).toBe('in-app')
  })

  it('keeps the backdrop until main confirms the material and removes it when leaving Glass', async () => {
    const { bridge, changed } = glassBridge()
    const pending = deferred<boolean>()
    vi.mocked(bridge.setSeeThrough).mockReturnValueOnce(pending.promise)
    const { startAppearance, applyAppearance } = await loadAppearance(bridge)
    const root = document.createElement('html')
    stop = startAppearance(root)
    applyAppearance(glassChoice, root, true)
    expect(root.dataset.glass).toBe('in-app')
    pending.resolve(true)
    await pending.promise
    expect(root.dataset.glass).toBe('see-through')
    applyAppearance({ ...DEFAULT_SETTINGS, customThemes: [] }, root, true)
    expect(root.dataset.glass).toBeUndefined()
    expect(bridge.setSeeThrough).toHaveBeenLastCalledWith(false)
    changed(true)
    expect(root.dataset.glass).toBeUndefined()
  })

  it('keeps Glass in-app when the system reduces transparency', async () => {
    const { bridge, changed } = glassBridge(true)
    const { startAppearance, applyAppearance } = await loadAppearance(bridge)
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const root = document.createElement('html')
    stop = startAppearance(root)
    applyAppearance(glassChoice, root, true)
    expect(root.dataset.glass).toBe('in-app')
    expect(bridge.setSeeThrough).toHaveBeenCalledWith(false)
    changed(true)
    expect(root.dataset.glass).toBe('in-app')
  })

  it('releases the old bridge and ignores its pending material confirmation after restarting', async () => {
    const old = glassBridge()
    const pending = deferred<boolean>()
    vi.mocked(old.bridge.setSeeThrough).mockReturnValue(pending.promise)
    const { startAppearance, applyAppearance } = await loadAppearance(old.bridge)
    const oldRoot = document.createElement('html')
    const stopOld = startAppearance(oldRoot)
    applyAppearance(glassChoice, oldRoot, true)
    const next = glassBridge()
    vi.stubGlobal('sotto', { glassWindow: next.bridge })
    const root = document.createElement('html')
    stop = startAppearance(root)
    applyAppearance(glassChoice, root, true)
    await Promise.resolve()
    expect(root.dataset.glass).toBe('see-through')
    expect(old.unsubscribe).toHaveBeenCalledOnce()
    stopOld()
    old.changed(true)
    pending.resolve(true)
    await pending.promise
    expect(oldRoot.dataset.glass).toBe('in-app')
    next.changed(false)
    expect(root.dataset.glass).toBe('in-app')
  })
})
