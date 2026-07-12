import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  bootstrapTalkType,
  installSessionPermissionPolicy,
  NativeRuntimeController,
  type BootstrapApplication,
  type PermissionCheckHandler,
  type PermissionRequestHandler,
  type RuntimeController,
  type SessionPermissionAdapter,
} from '../../src/main/app/bootstrap'
import {
  registerIpc,
  type IpcInvocationEvent,
  type IpcMainAdapter,
} from '../../src/main/ipc/registerIpc'
import { StartupService } from '../../src/main/startup/startupService'
import {
  TrayController,
  type TrayAdapter,
  type TrayMenuItem,
} from '../../src/main/tray/trayController'
import {
  APP_HIDE,
  APP_MINIMIZE,
  APP_QUIT,
  APP_SHOW,
  HISTORY_ADD,
  HISTORY_CLEAR,
  HISTORY_DELETE,
  HISTORY_LIST,
  HISTORY_SEARCH,
  HOTKEY_GET,
  HOTKEY_REPLACE,
  OUTPUT_DELIVER,
  SETTINGS_GET,
  SETTINGS_RESET,
  SETTINGS_UPDATE,
  STARTUP_GET,
  STARTUP_SET,
} from '../../src/shared/channels'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'

const electronMock = vi.hoisted(() => {
  const exposed = { name: '', value: undefined as unknown }
  const ipcRenderer = {
    invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(
      async () => undefined,
    ),
    on: vi.fn<(channel: string, listener: (...args: unknown[]) => void) => void>(),
    removeListener: vi.fn<(channel: string, listener: (...args: unknown[]) => void) => void>(),
  }
  const contextBridge = {
    exposeInMainWorld: vi.fn((name: string, value: unknown) => {
      exposed.name = name
      exposed.value = value
    }),
  }
  return { contextBridge, exposed, ipcRenderer }
})

vi.mock('electron', () => ({
  contextBridge: electronMock.contextBridge,
  ipcRenderer: electronMock.ipcRenderer,
}))

import { createTalkTypeBridge } from '../../src/preload'

class FakeIpcMain implements IpcMainAdapter {
  readonly handlers = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
  readonly removed: string[] = []

  handle(
    channel: string,
    handler: (event: IpcInvocationEvent, ...args: unknown[]) => unknown,
  ): void {
    if (this.handlers.has(channel)) {
      throw new Error(`handler already exists: ${channel}`)
    }
    this.handlers.set(channel, handler)
  }

  removeHandler(channel: string): void {
    this.removed.push(channel)
    this.handlers.delete(channel)
  }

  constructor(readonly defaultEvent: IpcInvocationEvent) {}

  invoke(channel: string, payload?: unknown, event = this.defaultEvent): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) {
      return Promise.reject(new Error(`missing handler: ${channel}`))
    }
    return Promise.resolve(arguments.length === 1 ? handler(event) : handler(event, payload))
  }

  invokeArgs(channel: string, args: readonly unknown[], event = this.defaultEvent): Promise<unknown> {
    const handler = this.handlers.get(channel)
    if (!handler) {
      return Promise.reject(new Error(`missing handler: ${channel}`))
    }
    return Promise.resolve(handler(event, ...args))
  }
}

function createIpcHarness() {
  const trustedUrl = 'file:///C:/TalkType/out/renderer/index.html'
  const trustedFrame = { parent: null, url: trustedUrl }
  const trustedContents = {
    getURL: (): string => trustedUrl,
    isDestroyed: (): boolean => false,
    mainFrame: trustedFrame,
  }
  const trustedEvent = { sender: trustedContents, senderFrame: trustedFrame }
  const ipc = new FakeIpcMain(trustedEvent)
  const settings = {
    get: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
    update: vi.fn(async (patch: Partial<typeof DEFAULT_SETTINGS>) => ({
      ...DEFAULT_SETTINGS,
      ...patch,
    })),
    reset: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
  }
  const history = {
    list: vi.fn(async () => []),
    add: vi.fn(async () => []),
    search: vi.fn(async () => []),
    delete: vi.fn(async () => false),
    clear: vi.fn(async () => undefined),
  }
  const startup = {
    get: vi.fn(() => ({ enabled: false })),
    set: vi.fn((enabled: boolean) => ({ enabled })),
  }
  const hotkeys = {
    current: vi.fn(() => 'Primary'),
    replace: vi.fn(() => ({ ok: true as const })),
  }
  const app = {
    show: vi.fn(),
    hide: vi.fn(),
    minimize: vi.fn(),
    quit: vi.fn(),
  }

  const cleanup = registerIpc(ipc, {
    settings,
    history,
    startup,
    hotkeys,
    app,
    trustedSenders: () => [{ webContents: trustedContents, url: trustedUrl }],
  })
  return {
    app,
    cleanup,
    history,
    hotkeys,
    ipc,
    settings,
    startup,
    trustedContents,
    trustedEvent,
    trustedFrame,
    trustedUrl,
  }
}

describe('typed preload bridge', () => {
  beforeEach(() => {
    electronMock.ipcRenderer.invoke.mockClear()
    electronMock.ipcRenderer.on.mockClear()
    electronMock.ipcRenderer.removeListener.mockClear()
  })

  it('is exposed under the exact isolated name and contains named operations without a generic sender', () => {
    const bridge = createTalkTypeBridge(electronMock.ipcRenderer)

    expect(electronMock.exposed.name).toBe('talktype')
    expect(Object.keys(bridge).sort()).toEqual(
      [
        'addHistory',
        'clearHistory',
        'deleteHistory',
        'deliverOutput',
        'getHotkey',
        'getModelStatus',
        'getSettings',
        'getStartup',
        'hideApp',
        'installModel',
        'listHistory',
        'minimizeApp',
        'onDictationCommand',
        'onModelStatus',
        'onWidgetState',
        'publishWidgetState',
        'quitApp',
        'removeModel',
        'replaceHotkey',
        'requestDictation',
        'resetSettings',
        'searchHistory',
        'setStartup',
        'showApp',
        'updateSettings',
      ].sort(),
    )
    expect(bridge).not.toHaveProperty('send')
    expect(bridge).not.toHaveProperty('invoke')
    expect(bridge).not.toHaveProperty('ipcRenderer')
  })

  it('uses fixed channels and event subscriptions return exact cleanup functions', async () => {
    const bridge = createTalkTypeBridge(electronMock.ipcRenderer)
    const listener = vi.fn()
    electronMock.ipcRenderer.invoke.mockResolvedValueOnce({
      ...DEFAULT_SETTINGS,
      theme: 'dark',
    })

    await bridge.updateSettings({ theme: 'dark' })
    const unsubscribe = bridge.onWidgetState(listener)

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(SETTINGS_UPDATE, {
      theme: 'dark',
    })
    expect(electronMock.ipcRenderer.on).toHaveBeenCalledWith(
      'talktype:widget:state',
      expect.any(Function),
    )

    const wrappedListener = electronMock.ipcRenderer.on.mock.calls[0]?.[1]
    wrappedListener?.({}, { status: 'idle' })
    expect(listener).toHaveBeenCalledWith({ status: 'idle' })

    wrappedListener?.({}, { status: 'hostile', injected: true })
    expect(listener).toHaveBeenCalledTimes(1)

    wrappedListener?.({}, { status: 'idle' }, { extra: true })
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    unsubscribe()
    expect(electronMock.ipcRenderer.removeListener).toHaveBeenCalledOnce()
  })
})

describe('IPC validation and lifecycle', () => {
  it('registers current settings, history, shortcut, startup, and app handlers', () => {
    const { ipc } = createIpcHarness()

    expect([...ipc.handlers.keys()].sort()).toEqual(
      expect.arrayContaining(
        [
          SETTINGS_GET,
          SETTINGS_UPDATE,
          SETTINGS_RESET,
          HISTORY_LIST,
          HISTORY_ADD,
          HISTORY_SEARCH,
          HISTORY_DELETE,
          HISTORY_CLEAR,
          HOTKEY_GET,
          HOTKEY_REPLACE,
          STARTUP_GET,
          STARTUP_SET,
          APP_SHOW,
          APP_HIDE,
          APP_MINIMIZE,
          APP_QUIT,
        ].sort(),
      ),
    )
  })

  it('validates a settings patch before persistence and strips no fields silently', async () => {
    const { ipc, settings } = createIpcHarness()

    await expect(ipc.invoke(SETTINGS_UPDATE, { theme: 'dark', autoPaste: false })).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      theme: 'dark',
      autoPaste: false,
    })
    expect(settings.update).toHaveBeenCalledWith({ theme: 'dark', autoPaste: false })

    await expect(ipc.invoke(SETTINGS_UPDATE, { theme: 'ultraviolet' })).rejects.toThrow(
      'Invalid IPC payload',
    )
    await expect(
      ipc.invoke(SETTINGS_UPDATE, { theme: 'dark', injectedChannel: 'app:quit' }),
    ).rejects.toThrow('Invalid IPC payload')
    expect(settings.update).toHaveBeenCalledTimes(1)
  })

  it('validates history and primitive payloads before calling repositories or services', async () => {
    const { history, hotkeys, ipc, startup } = createIpcHarness()

    await expect(ipc.invoke(HISTORY_SEARCH, 42)).rejects.toThrow('Invalid IPC payload')
    await expect(ipc.invoke(HISTORY_DELETE, '')).rejects.toThrow('Invalid IPC payload')
    await expect(ipc.invoke(STARTUP_SET, 'yes')).rejects.toThrow('Invalid IPC payload')
    await expect(ipc.invoke(HOTKEY_REPLACE, 'Escape')).rejects.toThrow('Invalid IPC payload')

    expect(history.search).not.toHaveBeenCalled()
    expect(history.delete).not.toHaveBeenCalled()
    expect(startup.set).not.toHaveBeenCalled()
    expect(hotkeys.replace).not.toHaveBeenCalled()
  })

  it('rejects missing or extra arguments instead of silently ignoring them', async () => {
    const { ipc, settings } = createIpcHarness()

    await expect(ipc.invokeArgs(SETTINGS_GET, [undefined])).rejects.toThrow(
      'Invalid IPC payload',
    )
    await expect(ipc.invokeArgs(SETTINGS_UPDATE, [])).rejects.toThrow('Invalid IPC payload')
    await expect(
      ipc.invokeArgs(SETTINGS_UPDATE, [{ theme: 'dark' }, { injected: true }]),
    ).rejects.toThrow('Invalid IPC payload')
    expect(settings.get).not.toHaveBeenCalled()
    expect(settings.update).not.toHaveBeenCalled()
  })

  it('derives output policy from main-process settings and accepts only bounded text', async () => {
    const harness = createIpcHarness()
    const deliver = vi.fn(async () => 'pasted' as const)
    harness.cleanup()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        { webContents: harness.trustedContents, url: harness.trustedUrl },
      ],
      output: { deliver },
    })
    harness.settings.get.mockResolvedValueOnce({
      ...DEFAULT_SETTINGS,
      autoPaste: false,
      pasteDelayMs: 320,
    })

    await expect(harness.ipc.invoke(OUTPUT_DELIVER, 'hello world')).resolves.toBe('pasted')
    expect(deliver).toHaveBeenCalledWith('hello world', {
      autoPaste: false,
      pasteDelayMs: 320,
    })

    await expect(
      harness.ipc.invoke(OUTPUT_DELIVER, {
        text: 'hostile',
        autoPaste: true,
        pasteDelayMs: 0,
      }),
    ).rejects.toThrow('Invalid IPC payload')
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('uses settings privacy and retention when adding validated history', async () => {
    const { history, ipc, settings } = createIpcHarness()
    settings.get.mockResolvedValueOnce({
      ...DEFAULT_SETTINGS,
      historyEnabled: false,
      historyRetention: 25,
    })
    const entry = {
      id: 'entry-1',
      text: 'local words',
      createdAt: 1,
      durationMs: 2,
      language: 'en',
      modelPreset: 'balanced' as const,
    }

    await ipc.invoke(HISTORY_ADD, entry)

    expect(history.add).toHaveBeenCalledWith(entry, { enabled: false, retention: 25 })
  })

  it.each([
    [
      'unknown WebContents',
      (harness: ReturnType<typeof createIpcHarness>) => {
        const frame = { parent: null, url: harness.trustedUrl }
        return {
          sender: {
            getURL: (): string => harness.trustedUrl,
            isDestroyed: (): boolean => false,
            mainFrame: frame,
          },
          senderFrame: frame,
        }
      },
    ],
    [
      'destroyed WebContents',
      (harness: ReturnType<typeof createIpcHarness>) => ({
        sender: { ...harness.trustedContents, isDestroyed: (): boolean => true },
        senderFrame: harness.trustedFrame,
      }),
    ],
    [
      'subframe',
      (harness: ReturnType<typeof createIpcHarness>) => ({
        sender: harness.trustedContents,
        senderFrame: { parent: {}, url: harness.trustedUrl },
      }),
    ],
    [
      'navigated top frame',
      (harness: ReturnType<typeof createIpcHarness>) => ({
        sender: harness.trustedContents,
        senderFrame: { parent: null, url: 'https://attacker.invalid/' },
      }),
    ],
    [
      'forged top-frame object',
      (harness: ReturnType<typeof createIpcHarness>) => ({
        sender: harness.trustedContents,
        senderFrame: { parent: null, url: harness.trustedUrl },
      }),
    ],
  ] as const)('rejects every handler call from an unauthorized %s', async (_name, eventFactory) => {
    const harness = createIpcHarness()

    await expect(
      harness.ipc.invokeArgs(
        SETTINGS_UPDATE,
        [{ theme: 'dark' }],
        eventFactory(harness),
      ),
    ).rejects.toThrow('Unauthorized IPC sender')
    expect(harness.settings.update).not.toHaveBeenCalled()
  })

  it('removes owned handlers during idempotent cleanup', () => {
    const { cleanup, ipc } = createIpcHarness()

    cleanup()
    cleanup()

    expect(ipc.handlers.size).toBe(0)
    expect(new Set(ipc.removed).size).toBe(ipc.removed.length)
  })

  it('rolls back partial registration without removing an externally owned handler', () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const externalHandler = vi.fn()
    harness.ipc.handlers.set(HISTORY_LIST, externalHandler)

    expect(() =>
      registerIpc(harness.ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => [
          { webContents: harness.trustedContents, url: harness.trustedUrl },
        ],
      }),
    ).toThrow(`handler already exists: ${HISTORY_LIST}`)

    expect([...harness.ipc.handlers.entries()]).toStrictEqual([
      [HISTORY_LIST, externalHandler],
    ])
  })
})

describe('permission policy', () => {
  function createSession(): {
    permissionCheck: PermissionCheckHandler
    permissionRequest: PermissionRequestHandler
    session: SessionPermissionAdapter
  } {
    let permissionRequest: PermissionRequestHandler = () => undefined
    let permissionCheck: PermissionCheckHandler = () => false
    const session: SessionPermissionAdapter = {
      setPermissionRequestHandler: vi.fn((handler) => {
        if (handler === null) {
          return
        }
        permissionRequest = handler
      }),
      setPermissionCheckHandler: vi.fn((handler) => {
        if (handler === null) {
          return
        }
        permissionCheck = handler
      }),
    }
    return {
      get permissionCheck() {
        return permissionCheck
      },
      get permissionRequest() {
        return permissionRequest
      },
      session,
    }
  }

  it('allows only trusted renderer microphone requests', () => {
    const harness = createSession()
    const packagedContents = { getURL: () => 'file:///C:/TalkType/out/renderer/index.html' }
    const developmentContents = { getURL: () => 'http://127.0.0.1:5173/' }
    installSessionPermissionPolicy(harness.session, [
      {
        webContents: packagedContents,
        url: 'file:///C:/TalkType/out/renderer/index.html',
      },
      { webContents: developmentContents, url: 'http://127.0.0.1:5173/' },
    ])

    const trustedAudio = vi.fn()
    harness.permissionRequest(
      packagedContents,
      'media',
      trustedAudio,
      {
        isMainFrame: true,
        requestingUrl: 'file:///C:/TalkType/out/renderer/index.html',
        mediaTypes: ['audio'],
      },
    )
    expect(trustedAudio).toHaveBeenCalledWith(true)
    expect(
      harness.permissionCheck(developmentContents, 'media', 'http://127.0.0.1:5173/', {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: 'http://127.0.0.1:5173/',
      }),
    ).toBe(true)
  })

  it('resets only its two permission handlers during idempotent cleanup', () => {
    const harness = createSession()
    const trustedContents = { getURL: () => 'file:///C:/TalkType/out/renderer/index.html' }
    const cleanup = installSessionPermissionPolicy(harness.session, [
      {
        webContents: trustedContents,
        url: 'file:///C:/TalkType/out/renderer/index.html',
      },
    ])

    cleanup()
    cleanup()

    expect(harness.session.setPermissionCheckHandler).toHaveBeenLastCalledWith(null)
    expect(harness.session.setPermissionRequestHandler).toHaveBeenLastCalledWith(null)
  })

  it.each([
    ['untrusted audio', 'media', 'https://attacker.invalid/', ['audio']],
    ['trusted video', 'media', 'file:///C:/TalkType/out/renderer/index.html', ['video']],
    ['trusted display capture', 'display-capture', 'file:///C:/TalkType/out/renderer/index.html', []],
    ['trusted notifications', 'notifications', 'file:///C:/TalkType/out/renderer/index.html', []],
    ['trusted clipboard read', 'clipboard-read', 'file:///C:/TalkType/out/renderer/index.html', []],
  ])('denies %s', (_name, permission, requestingUrl, mediaTypes) => {
    const harness = createSession()
    const trustedContents = { getURL: () => 'file:///C:/TalkType/out/renderer/index.html' }
    const untrustedContents = { getURL: () => 'https://attacker.invalid/' }
    installSessionPermissionPolicy(harness.session, [
      {
        webContents: trustedContents,
        url: 'file:///C:/TalkType/out/renderer/index.html',
      },
    ])
    const callback = vi.fn()

    harness.permissionRequest(
      requestingUrl.includes('attacker') ? untrustedContents : trustedContents,
      permission,
      callback,
      { isMainFrame: true, requestingUrl, mediaTypes },
    )

    expect(callback).toHaveBeenCalledWith(false)
  })

  it.each([
    ['a subframe', { isMainFrame: false, mediaTypes: ['audio'] }],
    ['missing frame details', { mediaTypes: ['audio'] }],
    ['missing media details', { isMainFrame: true }],
    ['mixed audio and video', { isMainFrame: true, mediaTypes: ['audio', 'video'] }],
  ])('denies trusted media from %s', (_name, detailOverrides) => {
    const harness = createSession()
    const trustedContents = { getURL: () => 'file:///C:/TalkType/out/renderer/index.html' }
    installSessionPermissionPolicy(harness.session, [
      {
        webContents: trustedContents,
        url: 'file:///C:/TalkType/out/renderer/index.html',
      },
    ])
    const callback = vi.fn()

    harness.permissionRequest(trustedContents, 'media', callback, {
      requestingUrl: 'file:///C:/TalkType/out/renderer/index.html',
      ...detailOverrides,
    })

    expect(callback).toHaveBeenCalledWith(false)
  })
})

describe('StartupService', () => {
  it('delegates idempotently to login-item settings', () => {
    let enabled = false
    const adapter = {
      getLoginItemSettings: vi.fn(() => ({ openAtLogin: enabled })),
      setLoginItemSettings: vi.fn((settings: { openAtLogin: boolean }) => {
        enabled = settings.openAtLogin
      }),
    }
    const service = new StartupService(adapter)

    expect(service.get()).toEqual({ enabled: false })
    expect(service.set(false)).toEqual({ enabled: false })
    expect(adapter.setLoginItemSettings).not.toHaveBeenCalled()

    expect(service.set(true)).toEqual({ enabled: true })
    expect(service.set(true)).toEqual({ enabled: true })
    expect(adapter.setLoginItemSettings).toHaveBeenCalledOnce()
  })
})

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
      'Show TalkType',
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
})

function createApp(ready: Promise<void>): BootstrapApplication & {
  emit(event: 'second-instance' | 'before-quit'): void
  quit: ReturnType<typeof vi.fn>
} {
  const listeners = new Map<string, Set<() => void>>()
  const quit = vi.fn()
  return {
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(() => ready),
    on: vi.fn((event, listener) => {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    }),
    removeListener: vi.fn((event, listener) => listeners.get(event)?.delete(listener)),
    quit,
    emit: (event) => {
      for (const listener of listeners.get(event) ?? []) {
        listener()
      }
    },
  }
}

function createRuntime(start: () => Promise<void> = async () => undefined) {
  return {
    start: vi.fn<() => Promise<void>>(start),
    showMain: vi.fn<() => void>(),
    beginQuit: vi.fn<() => void>(),
    dispose: vi.fn<() => void>(),
  } satisfies RuntimeController
}

function createDeferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

describe('bootstrap failure containment', () => {
  it('catches readiness rejection, emits only a safe diagnostic, and quits in a controlled way', async () => {
    const app = createApp(Promise.reject(new Error('secret token C:/Users/private')))
    const log = vi.fn()
    const initialize = vi.fn(async () => createRuntime())

    const result = await bootstrapTalkType({ app, initialize, log })

    expect(result.started).toBe(false)
    expect(initialize).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('bootstrap-readiness-failed')
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
    expect(app.quit).toHaveBeenCalledOnce()
  })

  it('contains renderer startup rejection, cleans resources, and quits without leaking the error', async () => {
    const app = createApp(Promise.resolve())
    const log = vi.fn()
    const runtime = createRuntime(async () => {
      throw new Error('renderer secret C:/Users/private')
    })

    const result = await bootstrapTalkType({
      app,
      initialize: async () => runtime,
      log,
    })

    expect(result.started).toBe(false)
    expect(runtime.dispose).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('bootstrap-startup-failed')
    expect(JSON.stringify(log.mock.calls)).not.toContain('private')
    expect(app.quit).toHaveBeenCalledOnce()
  })

  it('raises the existing main window for a second instance and cleans up once on quit', async () => {
    const app = createApp(Promise.resolve())
    const runtime = createRuntime()
    const result = await bootstrapTalkType({
      app,
      initialize: async () => runtime,
      log: vi.fn(),
    })

    expect(result.started).toBe(true)
    app.emit('second-instance')
    expect(runtime.showMain).toHaveBeenCalledOnce()

    app.emit('before-quit')
    app.emit('before-quit')
    result.dispose()
    expect(runtime.beginQuit).toHaveBeenCalledOnce()
    expect(runtime.dispose).toHaveBeenCalledOnce()
  })

  it('quits immediately when another instance owns the lock', async () => {
    const app = createApp(Promise.resolve())
    vi.mocked(app.requestSingleInstanceLock).mockReturnValue(false)
    const initialize = vi.fn(async () => createRuntime())

    const result = await bootstrapTalkType({ app, initialize, log: vi.fn() })

    expect(result.started).toBe(false)
    expect(app.quit).toHaveBeenCalledOnce()
    expect(initialize).not.toHaveBeenCalled()
  })
})

describe('NativeRuntimeController', () => {
  it('starts native services from validated settings and releases only owned resources once', async () => {
    const order: string[] = []
    const windows = {
      createWindows: vi.fn(async () => {
        order.push('windows:start')
      }),
      showMain: vi.fn(async () => {
        order.push('windows:show')
      }),
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
    expect(permissionCleanup).toHaveBeenCalledOnce()
    expect(hotkeys.dispose).toHaveBeenCalledOnce()
    expect(tray.dispose).toHaveBeenCalledOnce()
    expect(windows.dispose).toHaveBeenCalledOnce()
    expect(order).toStrictEqual([
      'windows:start',
      'windows:show',
      'windows:quit',
      'ipc:dispose',
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
      beginQuit: vi.fn(),
      dispose: vi.fn(),
    }
    const hotkeys = { replace: vi.fn(() => ({ ok: true as const })), dispose: vi.fn() }
    const tray = { update: vi.fn(), dispose: vi.fn() }
    const startup = { set: vi.fn() }
    const settingsGet = vi.fn(async () => ({ ...DEFAULT_SETTINGS }))
    const installPermissions = vi.fn(() => vi.fn())
    const registerIpc = vi.fn(() => vi.fn())
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

    runtime.dispose()
    windowLoad.resolve()

    await expect(startupAttempt).rejects.toMatchObject({
      name: 'NativeRuntimeStoppedError',
      code: 'NATIVE_RUNTIME_STOPPED',
    })
    expect(installPermissions).not.toHaveBeenCalled()
    expect(registerIpc).not.toHaveBeenCalled()
    expect(settingsGet).not.toHaveBeenCalled()
    expect(hotkeys.replace).not.toHaveBeenCalled()
    expect(startup.set).not.toHaveBeenCalled()
    expect(tray.update).not.toHaveBeenCalled()
    expect(windows.showMain).not.toHaveBeenCalled()
  })

  it('halts startup after a pending settings read and cleans installed resources exactly once', async () => {
    const settingsRead = createDeferred<typeof DEFAULT_SETTINGS>()
    const permissionCleanup = vi.fn()
    const ipcCleanup = vi.fn()
    const windows = {
      createWindows: vi.fn(async () => undefined),
      showMain: vi.fn(async () => undefined),
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
    expect(permissionCleanup).toHaveBeenCalledOnce()
    expect(ipcCleanup).toHaveBeenCalledOnce()
    expect(hotkeys.replace).not.toHaveBeenCalled()
    expect(startup.set).not.toHaveBeenCalled()
    expect(tray.update).not.toHaveBeenCalled()
    expect(windows.showMain).not.toHaveBeenCalled()
  })

  it('immediately cleans a permission resource returned after disposal wins its installer', async () => {
    const permissionCleanup = vi.fn()
    const registerIpc = vi.fn(() => vi.fn())
    const runtime = new NativeRuntimeController({
      windows: {
        createWindows: vi.fn(async () => undefined),
        showMain: vi.fn(async () => undefined),
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

  it('rejects a new start call after a completed runtime has been disposed', async () => {
    const runtime = new NativeRuntimeController({
      windows: {
        createWindows: vi.fn(async () => undefined),
        showMain: vi.fn(async () => undefined),
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
})
