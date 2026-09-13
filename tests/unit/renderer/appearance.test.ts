import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AppearancePreview,
  applyAppearance,
  readCachedAppearance,
  resolveAppearance,
  systemPrefersDark,
} from '../../../src/renderer/src/state/appearance'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('main-window appearance', () => {
  it('resolves System from the scheme and treats an unknowable scheme as the dark default', () => {
    expect(resolveAppearance('system', true)).toBe('dark')
    expect(resolveAppearance('system', false)).toBe('light')
    expect(resolveAppearance('light', true)).toBe('light')
    expect(systemPrefersDark(undefined)).toBe(true)
    expect(systemPrefersDark({ matchMedia: (() => ({ matches: false })) as unknown as Window['matchMedia'] })).toBe(false)
  })

  it('suppresses transitions only when the painted mode changes, for two frames', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    const root = document.createElement('html')

    applyAppearance({ appearance: 'dark', accent: 'teal' }, root, true)
    expect(root.dataset.themeSwitching).toBeUndefined()
    applyAppearance({ appearance: 'dark', accent: 'rose' }, root, true)
    expect(root.dataset.themeSwitching).toBeUndefined()
    expect(root.dataset.accent).toBe('rose')

    expect(applyAppearance({ appearance: 'system', accent: 'rose' }, root, false)).toBe('light')
    expect(root.dataset.theme).toBe('light')
    expect(root.dataset.themeSwitching).toBe('')
    frames.shift()!(0)
    expect(root.dataset.themeSwitching).toBe('')
    frames.shift()!(0)
    expect(root.dataset.themeSwitching).toBeUndefined()
    expect(readCachedAppearance()).toEqual({ appearance: 'system', accent: 'rose' })
  })

  it('keeps each field of the newest pending choice, settles only matching saves, and drops a saved choice once settings catch up', () => {
    const preview = new AppearancePreview()
    const persisted = { ...DEFAULT_SETTINGS }
    const light = preview.choose({ appearance: 'light' })
    const violet = preview.choose({ accent: 'violet' })
    expect(preview.effective(persisted)).toEqual({ appearance: 'light', accent: 'violet' })

    // An older accent choice is superseded before its save answers.
    const amber = preview.choose({ accent: 'amber' })
    preview.settle(violet, false, persisted)
    expect(preview.effective(persisted)).toEqual({ appearance: 'light', accent: 'amber' })

    preview.settle(light, true, persisted)
    expect(preview.effective(persisted)).toEqual({ appearance: 'light', accent: 'amber' })
    const caughtUp = { ...persisted, appearance: 'light' as const }
    expect(preview.effective(caughtUp)).toEqual({ appearance: 'light', accent: 'amber' })

    preview.settle(amber, false, caughtUp)
    expect(preview.effective(caughtUp)).toEqual({ appearance: 'light', accent: 'teal' })
  })

  it('notifies subscribers on each edit and settle', () => {
    const preview = new AppearancePreview()
    const listener = vi.fn()
    const unsubscribe = preview.subscribe(listener)
    const sequence = preview.choose({ accent: 'green' })
    preview.settle(sequence, true, DEFAULT_SETTINGS)
    preview.settle(sequence + 10, true, DEFAULT_SETTINGS)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    preview.reset()
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
