// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  NativeRuntimeController
} from '../../../../src/main/app/bootstrap'
import {
  registerIpc
} from '../../../../src/main/ipc/registerIpc'
import {
  HOTKEY_GET,
  STARTUP_GET
} from '../../../../src/shared/channels'
import {
  DEFAULT_SETTINGS
} from '../../../../src/shared/settings'
import { createDeferred } from '../../../fixtures/bootstrapHarness'
import { createIpcHarness } from '../../../fixtures/ipcHarness'


describe('NativeRuntimeController', () => {
  it('fully initializes native state and handlers before renderer construction begins', async () => {
    const ipcHarness = createIpcHarness()
    ipcHarness.cleanup()
    const order: string[] = []
    let activeHotkey: string | null = null
    let startupEnabled = false
    let trayAutoPaste = true
    let permissionsInstalled = false
    let rendererObservation: Readonly<{
      hotkey: string | null
      startup: boolean
      autoPaste: boolean
      permissions: boolean
    }> | null = null
    const runtime = new NativeRuntimeController({
      windows: {
        createWindows: vi.fn(async () => {
          order.push('windows')
          const hotkey = await ipcHarness.ipc.invoke(HOTKEY_GET)
          const startup = (await ipcHarness.ipc.invoke(STARTUP_GET)) as {
            readonly enabled: boolean
          }
          rendererObservation = {
            hotkey: hotkey as string | null,
            startup: startup.enabled,
            autoPaste: trayAutoPaste,
            permissions: permissionsInstalled,
          }
        }),
        showMain: vi.fn(async () => {
          order.push('show')
        }),
        showWidget: vi.fn(async () => undefined),
        beginQuit: vi.fn(),
        dispose: vi.fn(),
      },
      hotkeys: {
        replace: vi.fn((accelerator: string) => {
          order.push('hotkey')
          activeHotkey = accelerator
          return { ok: true as const }
        }),
        dispose: vi.fn(),
      },
      tray: {
        update: vi.fn((state) => {
          order.push('tray')
          trayAutoPaste = state.autoPaste
        }),
        dispose: vi.fn(),
      },
      startup: {
        set: vi.fn((enabled: boolean) => {
          order.push('startup')
          startupEnabled = enabled
        }),
      },
      settings: {
        get: vi.fn(async () => {
          order.push('settings')
          return {
            ...DEFAULT_SETTINGS,
            hotkey: 'Alt+Space',
            launchAtStartup: true,
            autoPaste: false,
          }
        }),
      },
      installPermissions: vi.fn(() => {
        order.push('permissions')
        permissionsInstalled = true
        return vi.fn()
      }),
      installProtocols: vi.fn(() => {
        order.push('protocols')
        return vi.fn()
      }),
      registerIpc: vi.fn(() => {
        order.push('ipc')
        return registerIpc(ipcHarness.ipc, {
          settings: ipcHarness.settings,
          history: ipcHarness.history,
          startup: {
            get: () => ({ enabled: startupEnabled }),
            set: (enabled) => ({ enabled }),
          },
          hotkeys: {
            current: () => activeHotkey,
            replace: () => ({ ok: false, reason: 'unavailable' }),
          },
          app: ipcHarness.app,
          trustedSenders: () => [
            {
              role: 'main',
              webContents: ipcHarness.trustedContents,
              url: ipcHarness.trustedUrl,
            },
          ],
        })
      }),
      log: vi.fn(),
    })

    await runtime.start()

    expect(rendererObservation).toStrictEqual({
      hotkey: 'Alt+Space',
      startup: true,
      autoPaste: false,
      permissions: true,
    })
    expect(order).toStrictEqual([
      'settings',
      'hotkey',
      'startup',
      'tray',
      'permissions',
      'protocols',
      'ipc',
      'windows',
      'show',
    ])
    runtime.dispose()
  })

  it('reveals the resting widget sliver at startup only after onboarding is complete', async () => {
    const createRuntime = (
      onboardingComplete: boolean,
      showWidget: () => Promise<void>,
    ): NativeRuntimeController =>
      new NativeRuntimeController({
        windows: {
          createWindows: vi.fn(async () => undefined),
          showMain: vi.fn(async () => undefined),
          showWidget,
          beginQuit: vi.fn(),
          dispose: vi.fn(),
        },
        hotkeys: { replace: vi.fn(() => ({ ok: true as const })), dispose: vi.fn() },
        tray: { update: vi.fn(), dispose: vi.fn() },
        startup: { set: vi.fn() },
        settings: { get: async () => ({ ...DEFAULT_SETTINGS, onboardingComplete }) },
        installPermissions: () => vi.fn(),
        registerIpc: () => vi.fn(),
        log: vi.fn(),
      })

    const revealed = vi.fn(async () => undefined)
    await createRuntime(true, revealed).start()
    expect(revealed).toHaveBeenCalledOnce()

    const concealed = vi.fn(async () => undefined)
    await createRuntime(false, concealed).start()
    expect(concealed).not.toHaveBeenCalled()
  })

  it('keeps the widget hidden at startup when the idle-visibility setting is off', async () => {
    const showWidget = vi.fn(async () => undefined)
    const runtime = new NativeRuntimeController({
      windows: {
        createWindows: vi.fn(async () => undefined),
        showMain: vi.fn(async () => undefined),
        showWidget,
        beginQuit: vi.fn(),
        dispose: vi.fn(),
      },
      hotkeys: { replace: vi.fn(() => ({ ok: true as const })), dispose: vi.fn() },
      tray: { update: vi.fn(), dispose: vi.fn() },
      startup: { set: vi.fn() },
      settings: {
        get: async () => ({
          ...DEFAULT_SETTINGS,
          onboardingComplete: true,
          showWidgetWhenIdle: false,
        }),
      },
      installPermissions: () => vi.fn(),
      registerIpc: () => vi.fn(),
      log: vi.fn(),
    })

    await runtime.start()

    expect(showWidget).not.toHaveBeenCalled()
    runtime.dispose()
  })

  it('publishes an initial idle widget snapshot at startup once onboarding is complete', async () => {
    const createRuntime = (
      settings: Partial<typeof DEFAULT_SETTINGS>,
      publishIdleWidgetState: (settings: typeof DEFAULT_SETTINGS) => Promise<void>,
    ): NativeRuntimeController =>
      new NativeRuntimeController({
        windows: {
          createWindows: vi.fn(async () => undefined),
          showMain: vi.fn(async () => undefined),
          showWidget: vi.fn(async () => undefined),
          beginQuit: vi.fn(),
          dispose: vi.fn(),
        },
        hotkeys: { replace: vi.fn(() => ({ ok: true as const })), dispose: vi.fn() },
        tray: { update: vi.fn(), dispose: vi.fn() },
        startup: { set: vi.fn() },
        settings: { get: async () => ({ ...DEFAULT_SETTINGS, ...settings }) },
        installPermissions: () => vi.fn(),
        registerIpc: () => vi.fn(),
        publishIdleWidgetState,
        log: vi.fn(),
      })

    const published = vi.fn(async () => undefined)
    await createRuntime({ onboardingComplete: true, hotkey: 'Alt+Space' }, published).start()
    expect(published).toHaveBeenCalledOnce()
    expect(published).toHaveBeenCalledWith(
      expect.objectContaining({ onboardingComplete: true, hotkey: 'Alt+Space' }),
    )

    const publishedWhileHidden = vi.fn(async () => undefined)
    await createRuntime(
      { onboardingComplete: true, showWidgetWhenIdle: false },
      publishedWhileHidden,
    ).start()
    expect(publishedWhileHidden).toHaveBeenCalledOnce()

    const notPublished = vi.fn(async () => undefined)
    await createRuntime({ onboardingComplete: false }, notPublished).start()
    expect(notPublished).not.toHaveBeenCalled()
  })

  it('starts native services from validated settings and releases only owned resources once', async () => {
    const order: string[] = []
    const windows = {
      createWindows: vi.fn(async () => {
        order.push('windows:start')
      }),
      showMain: vi.fn(async () => {
        order.push('windows:show')
      }),
      showWidget: vi.fn(async () => undefined),
      beginQuit: vi.fn(() => order.push('windows:quit')),
      dispose: vi.fn(() => order.push('windows:dispose')),
    }
    const hotkeys = {
      replace: vi.fn(() => ({ ok: true as const })),
      dispose: vi.fn(() => order.push('hotkeys:dispose')),
    }
    const tray = {
      update: vi.fn(),
      dispose: vi.fn(() => order.push('tray:dispose')),
    }
    const startup = { set: vi.fn() }
    const ipcCleanup = vi.fn(() => order.push('ipc:dispose'))
    const protocolCleanup = vi.fn(() => order.push('protocols:dispose'))
    const permissionCleanup = vi.fn(() => order.push('permissions:dispose'))
    const runtime = new NativeRuntimeController({
      windows,
      hotkeys,
      tray,
      startup,
      settings: {
        get: async () => ({
          ...DEFAULT_SETTINGS,
          hotkey: 'Primary',
          autoPaste: false,
          launchAtStartup: true,
          startMinimized: false,
        }),
      },
      installPermissions: () => permissionCleanup,
      installProtocols: () => protocolCleanup,
      registerIpc: () => ipcCleanup,
      log: vi.fn(),
    })

    await runtime.start()

    expect(hotkeys.replace).toHaveBeenCalledWith('Primary')
    expect(startup.set).toHaveBeenCalledWith(true)
    expect(tray.update).toHaveBeenCalledWith({ dictating: false, autoPaste: false })
    expect(windows.showMain).toHaveBeenCalledOnce()

    runtime.beginQuit()
    runtime.dispose()
    runtime.dispose()

    expect(ipcCleanup).toHaveBeenCalledOnce()
    expect(protocolCleanup).toHaveBeenCalledOnce()
    expect(permissionCleanup).toHaveBeenCalledOnce()
    expect(hotkeys.dispose).toHaveBeenCalledOnce()
    expect(tray.dispose).toHaveBeenCalledOnce()
    expect(windows.dispose).toHaveBeenCalledOnce()
    expect(order).toStrictEqual([
      'windows:start',
      'windows:show',
      'windows:quit',
      'ipc:dispose',
      'protocols:dispose',
      'permissions:dispose',
      'hotkeys:dispose',
      'tray:dispose',
      'windows:dispose',
    ])
  })

  it('halts startup when disposal wins while native windows are still loading', async () => {
    const windowLoad = createDeferred<void>()
    const windows = {
      createWindows: vi.fn(() => windowLoad.promise),
      showMain: vi.fn(async () => undefined),
      showWidget: vi.fn(async () => undefined),
      beginQuit: vi.fn(),
      dispose: vi.fn(),
    }
    const hotkeys = { replace: vi.fn(() => ({ ok: true as const })), dispose: vi.fn() }
    const tray = { update: vi.fn(), dispose: vi.fn() }
    const startup = { set: vi.fn() }
    const settingsGet = vi.fn(async () => ({ ...DEFAULT_SETTINGS }))
    const permissionCleanup = vi.fn()
    const ipcCleanup = vi.fn()
    const installPermissions = vi.fn(() => permissionCleanup)
    const registerIpc = vi.fn(() => ipcCleanup)
    const runtime = new NativeRuntimeController({
      windows,
      hotkeys,
      tray,
      startup,
      settings: { get: settingsGet },
      installPermissions,
      registerIpc,
      log: vi.fn(),
    })
    const startupAttempt = runtime.start()
    await vi.waitFor(() => expect(windows.createWindows).toHaveBeenCalledOnce())

    runtime.dispose()
    windowLoad.resolve()

    await expect(startupAttempt).rejects.toMatchObject({
      name: 'NativeRuntimeStoppedError',
      code: 'NATIVE_RUNTIME_STOPPED',
    })
    expect(settingsGet).toHaveBeenCalledOnce()
    expect(hotkeys.replace).toHaveBeenCalledOnce()
    expect(startup.set).toHaveBeenCalledOnce()
    expect(tray.update).toHaveBeenCalledOnce()
    expect(installPermissions).toHaveBeenCalledOnce()
    expect(registerIpc).toHaveBeenCalledOnce()
    expect(permissionCleanup).toHaveBeenCalledOnce()
    expect(ipcCleanup).toHaveBeenCalledOnce()
    expect(windows.showMain).not.toHaveBeenCalled()
  })

  it('halts before native initialization when disposal wins a pending settings read', async () => {
    const settingsRead = createDeferred<typeof DEFAULT_SETTINGS>()
    const permissionCleanup = vi.fn()
    const ipcCleanup = vi.fn()
    const windows = {
      createWindows: vi.fn(async () => undefined),
      showMain: vi.fn(async () => undefined),
      showWidget: vi.fn(async () => undefined),
      beginQuit: vi.fn(),
      dispose: vi.fn(),
    }
    const hotkeys = { replace: vi.fn(() => ({ ok: true as const })), dispose: vi.fn() }
    const tray = { update: vi.fn(), dispose: vi.fn() }
    const startup = { set: vi.fn() }
    const settingsGet = vi.fn(() => settingsRead.promise)
    const runtime = new NativeRuntimeController({
      windows,
      hotkeys,
      tray,
      startup,
      settings: { get: settingsGet },
      installPermissions: () => permissionCleanup,
      registerIpc: () => ipcCleanup,
      log: vi.fn(),
    })
    const startupAttempt = runtime.start()
    await vi.waitFor(() => expect(settingsGet).toHaveBeenCalledOnce())

    runtime.dispose()
    settingsRead.resolve({ ...DEFAULT_SETTINGS })

    await expect(startupAttempt).rejects.toMatchObject({
      name: 'NativeRuntimeStoppedError',
      code: 'NATIVE_RUNTIME_STOPPED',
    })
    expect(permissionCleanup).not.toHaveBeenCalled()
    expect(ipcCleanup).not.toHaveBeenCalled()
    expect(hotkeys.replace).not.toHaveBeenCalled()
    expect(startup.set).not.toHaveBeenCalled()
    expect(tray.update).not.toHaveBeenCalled()
    expect(windows.createWindows).not.toHaveBeenCalled()
    expect(windows.showMain).not.toHaveBeenCalled()
  })

  it('immediately cleans a permission resource returned after disposal wins its installer', async () => {
    const permissionCleanup = vi.fn()
    const registerIpc = vi.fn(() => vi.fn())
    const runtime = new NativeRuntimeController({
      windows: {
        createWindows: vi.fn(async () => undefined),
        showMain: vi.fn(async () => undefined),
        showWidget: vi.fn(async () => undefined),
        beginQuit: vi.fn(),
        dispose: vi.fn(),
      },
      hotkeys: { replace: vi.fn(() => ({ ok: true as const })), dispose: vi.fn() },
      tray: { update: vi.fn(), dispose: vi.fn() },
      startup: { set: vi.fn() },
      settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS })) },
      installPermissions: () => {
        runtime.dispose()
        return permissionCleanup
      },
      registerIpc,
      log: vi.fn(),
    })

    await expect(runtime.start()).rejects.toMatchObject({ code: 'NATIVE_RUNTIME_STOPPED' })
    expect(permissionCleanup).toHaveBeenCalledOnce()
    expect(registerIpc).not.toHaveBeenCalled()
  })

  it('immediately cleans an IPC resource returned after disposal wins its installer', async () => {
    const permissionCleanup = vi.fn()
    const ipcCleanup = vi.fn()
    const runtime = new NativeRuntimeController({
      windows: {
        createWindows: vi.fn(async () => undefined),
        showMain: vi.fn(async () => undefined),
        showWidget: vi.fn(async () => undefined),
        beginQuit: vi.fn(),
        dispose: vi.fn(),
      },
      hotkeys: { replace: vi.fn(() => ({ ok: true as const })), dispose: vi.fn() },
      tray: { update: vi.fn(), dispose: vi.fn() },
      startup: { set: vi.fn() },
      settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS })) },
      installPermissions: () => permissionCleanup,
      registerIpc: () => {
        runtime.dispose()
        return ipcCleanup
      },
      log: vi.fn(),
    })

    await expect(runtime.start()).rejects.toMatchObject({ code: 'NATIVE_RUNTIME_STOPPED' })
    expect(permissionCleanup).toHaveBeenCalledOnce()
    expect(ipcCleanup).toHaveBeenCalledOnce()
  })

  it('immediately cleans a protocol resource returned after disposal wins its installer', async () => {
    const permissionCleanup = vi.fn()
    const protocolCleanup = vi.fn()
    const registerIpc = vi.fn(() => vi.fn())
    const runtime = new NativeRuntimeController({
      windows: {
        createWindows: vi.fn(async () => undefined),
        showMain: vi.fn(async () => undefined),
        showWidget: vi.fn(async () => undefined),
        beginQuit: vi.fn(),
        dispose: vi.fn(),
      },
      hotkeys: { replace: vi.fn(() => ({ ok: true as const })), dispose: vi.fn() },
      tray: { update: vi.fn(), dispose: vi.fn() },
      startup: { set: vi.fn() },
      settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS })) },
      installPermissions: () => permissionCleanup,
      installProtocols: () => {
        runtime.dispose()
        return protocolCleanup
      },
      registerIpc,
      log: vi.fn(),
    })

    await expect(runtime.start()).rejects.toMatchObject({ code: 'NATIVE_RUNTIME_STOPPED' })
    expect(permissionCleanup).toHaveBeenCalledOnce()
    expect(protocolCleanup).toHaveBeenCalledOnce()
    expect(registerIpc).not.toHaveBeenCalled()
  })

  it('rolls back earlier native resources when protocol installation fails', async () => {
    const permissionCleanup = vi.fn()
    const registerIpc = vi.fn(() => vi.fn())
    const windows = {
      createWindows: vi.fn(async () => undefined),
      showMain: vi.fn(async () => undefined),
      showWidget: vi.fn(async () => undefined),
      beginQuit: vi.fn(),
      dispose: vi.fn(),
    }
    const runtime = new NativeRuntimeController({
      windows,
      hotkeys: { replace: vi.fn(() => ({ ok: true as const })), dispose: vi.fn() },
      tray: { update: vi.fn(), dispose: vi.fn() },
      startup: { set: vi.fn() },
      settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS })) },
      installPermissions: () => permissionCleanup,
      installProtocols: () => { throw new Error('private protocol failure') },
      registerIpc,
      log: vi.fn(),
    })

    await expect(runtime.start()).rejects.toThrow('private protocol failure')
    runtime.dispose()

    expect(permissionCleanup).toHaveBeenCalledOnce()
    expect(registerIpc).not.toHaveBeenCalled()
    expect(windows.createWindows).not.toHaveBeenCalled()
  })

  it('rejects a new start call after a completed runtime has been disposed', async () => {
    const runtime = new NativeRuntimeController({
      windows: {
        createWindows: vi.fn(async () => undefined),
        showMain: vi.fn(async () => undefined),
        showWidget: vi.fn(async () => undefined),
        beginQuit: vi.fn(),
        dispose: vi.fn(),
      },
      hotkeys: { replace: vi.fn(() => ({ ok: true as const })), dispose: vi.fn() },
      tray: { update: vi.fn(), dispose: vi.fn() },
      startup: { set: vi.fn() },
      settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS })) },
      installPermissions: () => vi.fn(),
      registerIpc: () => vi.fn(),
      log: vi.fn(),
    })
    await runtime.start()
    runtime.dispose()

    await expect(runtime.start()).rejects.toMatchObject({
      name: 'NativeRuntimeStoppedError',
      code: 'NATIVE_RUNTIME_STOPPED',
    })
  })

  it.each([
    ['beginQuit', 'native-window-begin-quit-failed'],
    ['ipc', 'native-ipc-cleanup-failed'],
    ['protocol', 'native-protocol-cleanup-failed'],
    ['permission', 'native-permission-cleanup-failed'],
    ['hotkey', 'native-hotkey-cleanup-failed'],
    ['tray', 'native-tray-cleanup-failed'],
    ['window', 'native-window-cleanup-failed'],
  ] as const)(
    'isolates a throwing %s teardown and still releases every later resource once',
    async (failingStep, expectedCode) => {
      const throwing = (step: typeof failingStep) =>
        vi.fn(() => {
          if (failingStep === step) {
            throw new Error('secret teardown detail')
          }
        })
      const ipcCleanup = throwing('ipc')
      const protocolCleanup = throwing('protocol')
      const permissionCleanup = throwing('permission')
      const windows = {
        createWindows: vi.fn(async () => undefined),
        showMain: vi.fn(async () => undefined),
        showWidget: vi.fn(async () => undefined),
        beginQuit: throwing('beginQuit'),
        dispose: throwing('window'),
      }
      const hotkeys = {
        replace: vi.fn(() => ({ ok: true as const })),
        dispose: throwing('hotkey'),
      }
      const tray = { update: vi.fn(), dispose: throwing('tray') }
      const log = vi.fn()
      const runtime = new NativeRuntimeController({
        windows,
        hotkeys,
        tray,
        startup: { set: vi.fn() },
        settings: { get: vi.fn(async () => ({ ...DEFAULT_SETTINGS })) },
        installPermissions: () => permissionCleanup,
        installProtocols: () => protocolCleanup,
        registerIpc: () => ipcCleanup,
        log,
      })
      await runtime.start()

      expect(() => runtime.dispose()).not.toThrow()
      expect(windows.beginQuit).toHaveBeenCalledOnce()
      expect(ipcCleanup).toHaveBeenCalledOnce()
      expect(protocolCleanup).toHaveBeenCalledOnce()
      expect(permissionCleanup).toHaveBeenCalledOnce()
      expect(hotkeys.dispose).toHaveBeenCalledOnce()
      expect(tray.dispose).toHaveBeenCalledOnce()
      expect(windows.dispose).toHaveBeenCalledOnce()
      expect(log).toHaveBeenCalledWith(expectedCode)
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret')

      expect(() => runtime.dispose()).not.toThrow()
      expect(windows.beginQuit).toHaveBeenCalledOnce()
      expect(ipcCleanup).toHaveBeenCalledOnce()
      expect(protocolCleanup).toHaveBeenCalledOnce()
      expect(permissionCleanup).toHaveBeenCalledOnce()
      expect(hotkeys.dispose).toHaveBeenCalledOnce()
      expect(tray.dispose).toHaveBeenCalledOnce()
      expect(windows.dispose).toHaveBeenCalledOnce()
    },
  )
})
