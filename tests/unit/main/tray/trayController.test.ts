// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  TrayController,
  type TrayAdapter,
  type TrayMenuItem,
} from '../../../../src/main/tray/trayController'


describe('TrayController', () => {
  it('builds deterministic state-sensitive menu items and destroys once', () => {
    const setMenu = vi.fn<(items: readonly TrayMenuItem[]) => void>()
    const destroy = vi.fn()
    const adapter: TrayAdapter = { setMenu, destroy }
    const toggleDictation = vi.fn()
    const autoPaste = vi.fn()
    const show = vi.fn()
    const quit = vi.fn()
    const controller = new TrayController(adapter, {
      toggleDictation,
      setAutoPaste: autoPaste,
      show,
      quit,
    })

    controller.update({ dictating: false, autoPaste: true })
    const idleMenu = setMenu.mock.calls.at(-1)?.[0]
    expect(idleMenu?.map((item) => item.label ?? item.type)).toEqual([
      'Start Dictation',
      'Show Sotto',
      'separator',
      'Auto-paste',
      'separator',
      'Quit',
    ])
    idleMenu?.[0]?.click?.()
    idleMenu?.[3]?.click?.()
    expect(toggleDictation).toHaveBeenCalledOnce()
    expect(autoPaste).toHaveBeenCalledWith(false)

    controller.update({ dictating: true, autoPaste: false })
    const activeMenu = setMenu.mock.calls.at(-1)?.[0]
    expect(activeMenu?.[0]?.label).toBe('Stop Dictation')
    expect(activeMenu?.[3]).toMatchObject({ type: 'checkbox', checked: false })

    controller.dispose()
    controller.dispose()
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('offers an update check from the tray only when the build can answer one', () => {
    const setMenu = vi.fn<(items: readonly TrayMenuItem[]) => void>()
    const checkForUpdates = vi.fn()
    const controller = new TrayController({ setMenu, destroy: vi.fn() }, {
      toggleDictation: vi.fn(),
      setAutoPaste: vi.fn(),
      show: vi.fn(),
      checkForUpdates,
      quit: vi.fn(),
    })

    controller.update({ dictating: false, autoPaste: true })
    const menu = setMenu.mock.calls.at(-1)?.[0]
    expect(menu?.map((item) => item.label ?? item.type)).toEqual([
      'Start Dictation',
      'Show Sotto',
      'Check for Updates…',
      'separator',
      'Auto-paste',
      'separator',
      'Quit',
    ])
    menu?.[2]?.click?.()
    expect(checkForUpdates).toHaveBeenCalledOnce()
  })
})
