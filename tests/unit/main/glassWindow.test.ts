// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { glassMaterialFor } from '../../../src/main/platformProfile'
import { readTransparencyEffects, transparencyEffectsFrom } from '../../../src/main/windows/transparencyEffects'
import { GLASS_WINDOW_ARGUMENT_PREFIX, GLASS_WINDOW_SEE_THROUGH_ARGUMENT } from '../../../src/shared/glassWindow'
import { createHarness, type FakeWindow } from '../../fixtures/windowManager'

/** A harness whose windows record every material call, in order, beside the room's notices. */
function glassHarness(seeThroughAtStart: boolean) {
  const calls: string[] = []
  const onSeeThroughChanged = vi.fn((seeThrough: boolean) => { calls.push(`room ${seeThrough}`) })
  const harness = createHarness({ glassWindow: { material: 'acrylic', seeThroughAtStart: () => seeThroughAtStart, onSeeThroughChanged } }, (window: FakeWindow) => {
    Object.assign(window, {
      setBackgroundMaterial: (material: string) => { calls.push(`material ${material}`) },
      setBackgroundColor: (color: string) => { calls.push(`background ${color}`) },
    })
  })
  return { ...harness, calls, onSeeThroughChanged }
}

describe('the see-through window (ADR-0150)', () => {
  it('draws Acrylic from Windows 11 22H2, vibrancy on every Mac, and nothing on Linux or Windows 10', () => {
    expect(glassMaterialFor('win32', '10.0.26200')).toBe('acrylic')
    expect(glassMaterialFor('win32', '10.0.22621')).toBe('acrylic')
    expect(glassMaterialFor('win32', '10.0.19045')).toBeNull()
    expect(glassMaterialFor('darwin', '24.0.0')).toBe('vibrancy')
    expect(glassMaterialFor('linux', '6.9.0')).toBeNull()
  })

  it('makes a window clear over its material when the saved look paints Glass, and tells the room', async () => {
    const { manager, options } = glassHarness(true)
    await manager.createMainWindow()
    expect(options[0]).toMatchObject({ backgroundColor: '#00000000', backgroundMaterial: 'acrylic' })
    expect(options[0]!.webPreferences.additionalArguments).toEqual(expect.arrayContaining([`${GLASS_WINDOW_ARGUMENT_PREFIX}acrylic`, GLASS_WINDOW_SEE_THROUGH_ARGUMENT]))
  })

  it('keeps a window solid, with no material, when the look is not Glass', async () => {
    const { manager, options } = glassHarness(false)
    await manager.createMainWindow()
    expect(options[0]).toMatchObject({ backgroundColor: '#000000' })
    expect(options[0]).not.toHaveProperty('backgroundMaterial')
    expect(options[0]!.webPreferences.additionalArguments).not.toContain(GLASS_WINDOW_SEE_THROUGH_ARGUMENT)
  })

  it('switches the material in place, and refuses it while Transparency effects are off', async () => {
    const { manager, calls, onSeeThroughChanged } = glassHarness(false)
    await manager.createMainWindow()
    expect(manager.setMainWindowSeeThrough(true)).toBe(true)
    expect(calls.splice(0)).toEqual(['material acrylic', 'background #00000000'])
    // Turned off: the room hears first, so it is opaque before the material goes.
    manager.setGlassMaterialAvailable(false)
    expect(calls.splice(0)).toEqual(['room false', 'material none', 'background #000000'])
    expect(manager.setMainWindowSeeThrough(true)).toBe(false)
    expect(calls.splice(0)).toEqual(['material none', 'background #000000'])
    // Back on: the material returns, then the room may let the desktop through again.
    manager.setGlassMaterialAvailable(true)
    expect(calls.splice(0)).toEqual(['material acrylic', 'background #00000000', 'room true'])
    expect(onSeeThroughChanged).toHaveBeenCalledTimes(2)
  })

  it('turns a window made see-through at start solid when Transparency effects go off, before the room asks', async () => {
    const { manager, calls } = glassHarness(true)
    await manager.createMainWindow()
    manager.setGlassMaterialAvailable(false)
    expect(calls.splice(0)).toEqual(['room false', 'material none', 'background #000000'])
    manager.setGlassMaterialAvailable(true)
    expect(calls.splice(0)).toEqual(['material acrylic', 'background #00000000', 'room true'])
  })

  it('makes a window solid when Transparency effects are off at start', async () => {
    const { manager, options } = glassHarness(true)
    manager.setGlassMaterialAvailable(false)
    await manager.createMainWindow()
    expect(options[0]).toMatchObject({ backgroundColor: '#000000' })
    expect(options[0]!.webPreferences.additionalArguments).not.toContain(GLASS_WINDOW_SEE_THROUGH_ARGUMENT)
  })

  it('reads Windows’ Transparency effects switch, and counts anything unreadable as on', async () => {
    expect(transparencyEffectsFrom('    EnableTransparency    REG_DWORD    0x0\r\n')).toBe(false)
    expect(transparencyEffectsFrom('    EnableTransparency    REG_DWORD    0x1\r\n')).toBe(true)
    expect(transparencyEffectsFrom('')).toBe(true)
    await expect(readTransparencyEffects((_file, _args, callback) => callback(null, 'EnableTransparency REG_DWORD 0x0'))).resolves.toBe(false)
    await expect(readTransparencyEffects((_file, _args, callback) => callback(new Error('no key'), ''))).resolves.toBe(true)
  })
})
