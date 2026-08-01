import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import {
  bootstrapSotto,
  installSessionPermissionPolicy,
  NativeRuntimeController,
  NativeRuntimeStoppedError,
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
import { NativeSettingsCoordinator } from '../../src/main/settings/nativeSettingsCoordinator'
import { OutputService } from '../../src/main/output/outputService'
import { StartupService } from '../../src/main/startup/startupService'
import {
  WindowManager,
  type BrowserWindowLike,
  type NavigationEventName,
  type Rectangle,
  type WindowConstructorOptions,
} from '../../src/main/windows/windowManager'
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
  DICTATION_COMMAND,
  DICTATION_REQUEST,
  HISTORY_ADD,
  HISTORY_CLEAR,
  HISTORY_DELETE,
  HISTORY_LIST,
  HISTORY_SEARCH,
  HOTKEY_GET,
  HOTKEY_REPLACE,
  MODEL_INSTALL,
  MODEL_LIST_DISCLOSURES,
  OUTPUT_DELIVER,
  RECOVERY_NOTICE,
  RECOVERY_NOTICE_LIST,
  SETTINGS_CHANGED,
  SETTINGS_GET,
  SETTINGS_RESET,
  SETTINGS_UPDATE,
  STARTUP_GET,
  STARTUP_SET,
  WIDGET_DRAG,
  WIDGET_PRESENTATION,
  WIDGET_PUBLISH,
  WIDGET_STATE,
  WIDGET_VISIBILITY,
} from '../../src/shared/channels'
import {
  MODEL_DOWNLOAD_PRIVACY_NOTICE,
  type ModelDisclosureCatalog,
  type OutputDeliveryRequest,
  type SottoBridge,
} from '../../src/shared/contracts'
import type { WidgetSnapshot } from '../../src/shared/dictation'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type SettingsPatch,
} from '../../src/shared/settings'

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

import {
  createSottoBridge,
  createSottoWidgetBridge,
  exposeRendererBridge,
  exposeE2EBridge,
  parseRendererRoleArgument,
} from '../../src/preload'

class FakeIpcMain implements IpcMainAdapter {
  readonly handlers = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
  readonly removed: string[] = []
  readonly removeFailures = new Set<string>()

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
    if (this.removeFailures.has(channel)) {
      throw new Error(`secret remove failure: ${channel}`)
    }
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

class IpcLifecycleWindow implements BrowserWindowLike {
  readonly webContents: BrowserWindowLike['webContents']
  readonly hide = vi.fn()
  readonly show = vi.fn()
  readonly focus = vi.fn()
  readonly minimize = vi.fn()
  readonly isMinimized = vi.fn(() => false)
  readonly restore = vi.fn()
  readonly showInactive = vi.fn()
  readonly setAlwaysOnTop = vi.fn()
  bounds: Rectangle
  readonly getBounds = vi.fn((): Rectangle => ({ ...this.bounds }))
  readonly setBounds = vi.fn((bounds: Rectangle): void => {
    this.bounds = { ...bounds }
  })
  readonly setPosition = vi.fn((x: number, y: number): void => {
    this.bounds = { ...this.bounds, x, y }
  })
  readonly getPosition = vi.fn(() => [this.bounds.x, this.bounds.y] as const)
  readonly setSize = vi.fn((width: number, height: number): void => {
    this.bounds = { ...this.bounds, width, height }
  })
  readonly setIgnoreMouseEvents = vi.fn()
  readonly destroy = vi.fn()
  readonly isDestroyed = vi.fn(() => false)
  readonly loadURL = vi.fn(async () => undefined)
  readonly loadFile = vi.fn(async () => undefined)

  constructor(readonly role: 'main' | 'widget', options: WindowConstructorOptions) {
    const url = `file:///C:/Sotto/out/renderer/${role === 'main' ? 'index' : 'widget'}.html`
    const mainFrame = { parent: null, url }
    this.webContents = {
      mainFrame,
      send: vi.fn(),
      getURL: vi.fn(() => url),
      isDestroyed: vi.fn(() => false),
      setWindowOpenHandler: vi.fn(),
    }
    this.bounds = { x: 0, y: 0, width: options.width, height: options.height }
  }

  on(
    event: 'close' | 'closed' | 'moved',
    listener: (event: { preventDefault(): void }) => void,
  ): void {
    void event
    void listener
  }
  removeListener(
    event: 'close' | 'closed' | 'moved',
    listener: (event: { preventDefault(): void }) => void,
  ): void {
    void event
    void listener
  }
  onNavigation(
    event: NavigationEventName,
    listener: (event: { preventDefault(): void }, details: { readonly url: string }) => void,
  ): void {
    void event
    void listener
  }
  removeNavigationListener(
    event: NavigationEventName,
    listener: (event: { preventDefault(): void }, details: { readonly url: string }) => void,
  ): void {
    void event
    void listener
  }
  onRenderProcessGone(listener: () => void): void {
    void listener
  }
  removeRenderProcessGoneListener(listener: () => void): void {
    void listener
  }
}

function createIpcHarness() {
  const trustedUrl = 'file:///C:/Sotto/out/renderer/index.html'
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
    trustedSenders: () => [
      { role: 'main', webContents: trustedContents, url: trustedUrl },
    ],
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

const disclosureRevisions = {
  fast: '5332fcc35e32a33b86612b9a57a89be7906102b1',
  instant: 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad',
} as const

const disclosureCatalog: ModelDisclosureCatalog = Object.freeze({
  models: Object.freeze(([
    ['instant', 'onnx-community/moonshine-base-ONNX', true, 63, 'MIT'],
    ['fast', 'Xenova/whisper-tiny', false, 42, 'Apache-2.0'],
  ] as const).map(([preset, repository, bundled, totalBytes, license]) => Object.freeze({
    preset,
    repository,
    sourceProvider: 'Hugging Face' as const,
    sourceHost: 'huggingface.co' as const,
    revision: disclosureRevisions[preset],
    totalBytes,
    license,
    bundled,
  }))),
  optionalDownloadNotice: MODEL_DOWNLOAD_PRIVACY_NOTICE,
})

const idleWidgetSnapshot = {
  status: 'idle',
  theme: 'system',
  reducedMotion: 'system',
  widgetStyle: 'orb',
  shortcut: 'Control+Shift+Space',
  cancellable: false,
} as const satisfies WidgetSnapshot

describe('typed preload bridge', () => {
  beforeEach(() => {
    electronMock.ipcRenderer.invoke.mockClear()
    electronMock.ipcRenderer.on.mockClear()
    electronMock.ipcRenderer.removeListener.mockClear()
  })

  it('creates a frozen main-only surface without widget subscriptions or generic IPC', () => {
    const bridge = createSottoBridge(electronMock.ipcRenderer)

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
        'listModelDisclosures',
        'listHistory',
        'listRecoveryNotices',
        'minimizeApp',
        'onDictationCommand',
        'onModelStatus',
        'onRecoveryNotice',
        'onSettingsChanged',
        'polishTranscript',
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
    expect(bridge).not.toHaveProperty('onWidgetState')
    expect(Object.isFrozen(bridge)).toBe(true)
  })

  it('creates a frozen least-privilege widget surface that cannot start dictation or access private data', async () => {
    const bridge = createSottoWidgetBridge(electronMock.ipcRenderer)
    expect(Object.keys(bridge).sort()).toEqual(
      [
        'onWidgetState',
        'onWidgetVisibilityChange',
        'reportDrag',
        'requestCancel',
        'requestStop',
        'requestToggle',
        'setPresentation',
      ].sort(),
    )
    expect(bridge).not.toHaveProperty('getSettings')
    expect(bridge).not.toHaveProperty('listHistory')
    expect(bridge).not.toHaveProperty('requestDictation')
    expect(bridge).not.toHaveProperty('deliverOutput')
    expect(Object.isFrozen(bridge)).toBe(true)

    electronMock.ipcRenderer.invoke
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
    await bridge.requestStop()
    await bridge.requestCancel()
    await bridge.requestToggle()
    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      1,
      DICTATION_REQUEST,
      { type: 'stop' },
    )
    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      2,
      DICTATION_REQUEST,
      { type: 'cancel' },
    )
    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      3,
      DICTATION_REQUEST,
      { type: 'toggle' },
    )

    electronMock.ipcRenderer.invoke
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
    await bridge.setPresentation({ presentation: 'idle-hovered', generation: 7 })
    await bridge.reportDrag({ phase: 'move', generation: 7, gestureId: 9 })
    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      4,
      WIDGET_PRESENTATION,
      { presentation: 'idle-hovered', generation: 7 },
    )
    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      5,
      WIDGET_DRAG,
      { phase: 'move', generation: 7, gestureId: 9 },
    )
  })

  it('strictly validates generation-bound widget visibility presentation and drag payloads', async () => {
    const bridge = createSottoWidgetBridge(electronMock.ipcRenderer) as unknown as {
      onWidgetVisibilityChange(
        listener: (visibility: { visible: boolean; generation: number }) => void,
      ): () => void
      setPresentation(payload: unknown): Promise<unknown>
      reportDrag(payload: unknown): Promise<unknown>
    }
    const visibilityListener = vi.fn()
    bridge.onWidgetVisibilityChange(visibilityListener)
    const visibilityEvent = electronMock.ipcRenderer.on.mock.calls.find(
      ([channel]) => channel === WIDGET_VISIBILITY,
    )?.[1]

    visibilityEvent?.({}, { visible: true, generation: 4 })
    for (const payload of [
      { visible: true },
      { visible: true, generation: -1 },
      { visible: true, generation: 1.5 },
      { visible: true, generation: 4, extra: true },
    ]) {
      visibilityEvent?.({}, payload)
    }
    expect(visibilityListener).toHaveBeenCalledOnce()
    expect(visibilityListener).toHaveBeenCalledWith({ visible: true, generation: 4 })

    electronMock.ipcRenderer.invoke.mockResolvedValue({ ok: true })
    await expect(bridge.setPresentation({
      presentation: 'active',
      generation: 4,
    })).resolves.toEqual({ ok: true })
    await expect(bridge.reportDrag({
      phase: 'move',
      generation: 4,
      gestureId: 2,
    })).resolves.toEqual({ ok: true })

    for (const payload of [
      { presentation: 'active' },
      { presentation: 'active', generation: -1 },
      { presentation: 'active', generation: 1.5 },
      { presentation: 'active', generation: 4, extra: true },
    ]) {
      await expect(bridge.setPresentation(payload)).rejects.toThrow()
    }
    for (const payload of [
      { phase: 'move' },
      { phase: 'move', generation: 4 },
      { phase: 'move', generation: -1, gestureId: 2 },
      { phase: 'move', generation: 1.5, gestureId: 2 },
      { phase: 'move', generation: 4, gestureId: -1 },
      { phase: 'move', generation: 4, gestureId: 1.5 },
      { phase: 'move', generation: 4, gestureId: 2, extra: true },
    ]) {
      await expect(bridge.reportDrag(payload)).rejects.toThrow()
    }
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledTimes(2)
  })

  it('accepts only one immutable main-created renderer role argument', () => {
    expect(parseRendererRoleArgument(['electron', '--sotto-renderer-role=main'])).toBe('main')
    expect(parseRendererRoleArgument(['electron', '--sotto-renderer-role=widget'])).toBe('widget')
    expect(parseRendererRoleArgument(['electron'])).toBeNull()
    expect(parseRendererRoleArgument(['electron', '--sotto-renderer-role=admin'])).toBeNull()
    expect(parseRendererRoleArgument([
      'electron',
      '--sotto-renderer-role=main',
      '--sotto-renderer-role=widget',
    ])).toBeNull()
  })

  it('exposes exactly the role-appropriate bridge name and attaches only its relevant early buffer', () => {
    const context = { exposeInMainWorld: vi.fn() }
    expect(exposeRendererBridge(
      context,
      electronMock.ipcRenderer,
      ['electron', '--sotto-renderer-role=main'],
    )).toBe(true)
    expect(context.exposeInMainWorld).toHaveBeenCalledWith('sotto', expect.any(Object))
    expect(electronMock.ipcRenderer.on).toHaveBeenCalledTimes(3)
    expect(electronMock.ipcRenderer.on.mock.calls.map(([channel]) => channel).sort()).toEqual(
      [DICTATION_COMMAND, RECOVERY_NOTICE, SETTINGS_CHANGED].sort(),
    )

    context.exposeInMainWorld.mockClear()
    electronMock.ipcRenderer.on.mockClear()
    expect(exposeRendererBridge(
      context,
      electronMock.ipcRenderer,
      ['electron', '--sotto-renderer-role=widget'],
    )).toBe(true)
    expect(context.exposeInMainWorld).toHaveBeenCalledWith('sottoWidget', expect.any(Object))
    expect(electronMock.ipcRenderer.on).toHaveBeenCalledTimes(2)
    expect(electronMock.ipcRenderer.on.mock.calls.map(([channel]) => channel).sort()).toEqual(
      [WIDGET_STATE, WIDGET_VISIBILITY].sort(),
    )

    context.exposeInMainWorld.mockClear()
    electronMock.ipcRenderer.on.mockClear()
    expect(exposeRendererBridge(context, electronMock.ipcRenderer, ['electron'])).toBe(false)
    expect(context.exposeInMainWorld).not.toHaveBeenCalled()
    expect(electronMock.ipcRenderer.on).not.toHaveBeenCalled()
  })

  it('exposes the E2E bridge only for an admitted main renderer environment and role', () => {
    const context = { exposeInMainWorld: vi.fn() }
    const admitted = {
      SOTTO_E2E: '1',
      SOTTO_E2E_SCENARIO: 'success',
    }

    exposeE2EBridge(context, electronMock.ipcRenderer, admitted, [
      'electron',
      '--sotto-renderer-role=widget',
    ])
    exposeE2EBridge(context, electronMock.ipcRenderer, admitted, ['electron'])
    exposeE2EBridge(context, electronMock.ipcRenderer, {}, [
      'electron',
      '--sotto-renderer-role=main',
    ])
    exposeE2EBridge(context, electronMock.ipcRenderer, {
      ...admitted,
      SOTTO_E2E_SCENARIO: 'unknown',
    }, ['electron', '--sotto-renderer-role=main'])
    expect(context.exposeInMainWorld).not.toHaveBeenCalled()

    exposeE2EBridge(context, electronMock.ipcRenderer, admitted, [
      'electron',
      '--sotto-renderer-role=main',
    ])
    expect(context.exposeInMainWorld).toHaveBeenCalledTimes(1)
    expect(context.exposeInMainWorld).toHaveBeenCalledWith(
      'sottoE2E',
      expect.objectContaining({ scenario: 'success' }),
    )
  })

  it('types generic settings updates without native-managed fields', () => {
    expectTypeOf<Parameters<SottoBridge['updateSettings']>[0]>().toEqualTypeOf<SettingsPatch>()
    expectTypeOf<Parameters<SottoBridge['deliverOutput']>[0]>().toEqualTypeOf<OutputDeliveryRequest>()
    expectTypeOf<Parameters<SottoBridge['publishWidgetState']>[0]>().toEqualTypeOf<WidgetSnapshot>()
  })

  it('uses fixed channels and event subscriptions return exact cleanup functions', async () => {
    const bridge = createSottoBridge(electronMock.ipcRenderer)
    const listener = vi.fn()
    const visibilityListener = vi.fn()
    electronMock.ipcRenderer.invoke.mockResolvedValueOnce({
      ...DEFAULT_SETTINGS,
      theme: 'dark',
    })

    await bridge.updateSettings({ theme: 'dark' })
    const widgetBridge = createSottoWidgetBridge(electronMock.ipcRenderer)
    const unsubscribe = widgetBridge.onWidgetState(listener)
    const unsubscribeVisibility = widgetBridge.onWidgetVisibilityChange(visibilityListener)

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(SETTINGS_UPDATE, {
      theme: 'dark',
    })
    expect(electronMock.ipcRenderer.on).toHaveBeenCalledWith(
      'sotto:widget:state',
      expect.any(Function),
    )
    expect(electronMock.ipcRenderer.on).toHaveBeenCalledWith(
      WIDGET_VISIBILITY,
      expect.any(Function),
    )

    const wrappedListener = electronMock.ipcRenderer.on.mock.calls.find(
      ([channel]) => channel === WIDGET_STATE,
    )?.[1]
    wrappedListener?.({}, idleWidgetSnapshot)
    expect(listener).toHaveBeenCalledWith(idleWidgetSnapshot)

    wrappedListener?.({}, {
      status: 'success',
      sessionId: 'session',
      text: 'private transcript',
      output: 'copied',
    })
    expect(listener).toHaveBeenCalledTimes(1)

    wrappedListener?.({}, { status: 'hostile', injected: true })
    expect(listener).toHaveBeenCalledTimes(1)

    wrappedListener?.({}, idleWidgetSnapshot, { extra: true })
    expect(listener).toHaveBeenCalledTimes(1)

    const visibilityEvent = electronMock.ipcRenderer.on.mock.calls.find(
      ([channel]) => channel === WIDGET_VISIBILITY,
    )?.[1]
    visibilityEvent?.({}, { visible: false, generation: 1 })
    visibilityEvent?.({}, false)
    visibilityEvent?.({}, { visible: false, generation: 1, extra: true })
    visibilityEvent?.({}, { visible: true, generation: 2 }, { extra: true })
    expect(visibilityListener).toHaveBeenCalledOnce()
    expect(visibilityListener).toHaveBeenCalledWith({ visible: false, generation: 1 })

    unsubscribe()
    unsubscribe()
    unsubscribeVisibility()
    unsubscribeVisibility()
    expect(electronMock.ipcRenderer.removeListener).not.toHaveBeenCalled()
  })

  it('preload retains post-ready command edges until AppContext subscribes', () => {
    const mainBridge = createSottoBridge(electronMock.ipcRenderer)
    const widgetBridge = createSottoWidgetBridge(electronMock.ipcRenderer)
    const widgetEvent = electronMock.ipcRenderer.on.mock.calls.find(
      ([channel]) => channel === WIDGET_STATE,
    )?.[1]
    const visibilityEvent = electronMock.ipcRenderer.on.mock.calls.find(
      ([channel]) => channel === WIDGET_VISIBILITY,
    )?.[1]
    const commandEvent = electronMock.ipcRenderer.on.mock.calls.find(
      ([channel]) => channel === DICTATION_COMMAND,
    )?.[1]
    const listening = {
      status: 'listening', sessionId: 's', startedAt: 1, level: 0.2,
      theme: 'system', reducedMotion: 'system', shortcut: 'Primary', cancellable: true,
    } as const
    widgetEvent?.({}, listening)
    widgetEvent?.({}, idleWidgetSnapshot)
    visibilityEvent?.({}, { visible: false, generation: 2 })
    visibilityEvent?.({}, { visible: true, generation: 3 })
    commandEvent?.({}, { type: 'start' })
    commandEvent?.({}, { type: 'stop' })
    const widgetListener = vi.fn()
    const visibilityListener = vi.fn()
    const commandListener = vi.fn()
    const unsubscribeWidget = widgetBridge.onWidgetState(widgetListener)
    const unsubscribeVisibility = widgetBridge.onWidgetVisibilityChange(visibilityListener)
    const unsubscribeCommand = mainBridge.onDictationCommand(commandListener)
    expect(widgetListener).toHaveBeenCalledOnce()
    expect(widgetListener).toHaveBeenCalledWith(idleWidgetSnapshot)
    expect(visibilityListener).toHaveBeenCalledOnce()
    expect(visibilityListener).toHaveBeenCalledWith({ visible: true, generation: 3 })
    expect(commandListener.mock.calls.map(([command]) => command.type)).toEqual(['start', 'stop'])
    unsubscribeWidget()
    unsubscribeWidget()
    unsubscribeVisibility()
    unsubscribeCommand()
    commandEvent?.({}, { type: 'cancel' })
    mainBridge.onDictationCommand(commandListener)
    expect(commandListener).toHaveBeenCalledTimes(3)
    expect(commandListener).toHaveBeenLastCalledWith({ type: 'cancel' })
  })

  it('retains only the latest strict authoritative settings event for the main renderer', () => {
    const bridge = createSottoBridge(electronMock.ipcRenderer)
    const settingsEvent = electronMock.ipcRenderer.on.mock.calls.find(
      ([channel]) => channel === SETTINGS_CHANGED,
    )?.[1]
    settingsEvent?.({}, { ...DEFAULT_SETTINGS, theme: 'dark' })
    settingsEvent?.({}, { ...DEFAULT_SETTINGS, theme: 'light' })
    settingsEvent?.({}, { ...DEFAULT_SETTINGS, injected: true })
    settingsEvent?.({}, { ...DEFAULT_SETTINGS, autoPaste: 'yes' })

    const listener = vi.fn()
    const unsubscribe = bridge.onSettingsChanged(listener)
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, theme: 'light' })
    unsubscribe()
    unsubscribe()
  })

  it('strictly buffers safe recovery codes and lists sanitized retained notices', async () => {
    const bridge = createSottoBridge(electronMock.ipcRenderer)
    const recoveryEvent = electronMock.ipcRenderer.on.mock.calls.find(
      ([channel]) => channel === RECOVERY_NOTICE,
    )?.[1]
    recoveryEvent?.({}, { code: 'SETTINGS_RECOVERED' })
    recoveryEvent?.({}, { code: 'SETTINGS_RECOVERED', path: 'C:\\private\\settings.json' })
    recoveryEvent?.({}, { code: 'HISTORY_RECOVERED', transcript: 'private words' })
    const listener = vi.fn()
    const unsubscribe = bridge.onRecoveryNotice(listener)
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ code: 'SETTINGS_RECOVERED' })
    unsubscribe()

    electronMock.ipcRenderer.invoke.mockResolvedValueOnce([
      { code: 'SETTINGS_RECOVERED' },
      { code: 'HISTORY_RECOVERED' },
    ])
    await expect(bridge.listRecoveryNotices()).resolves.toEqual([
      { code: 'SETTINGS_RECOVERED' },
      { code: 'HISTORY_RECOVERED' },
    ])
    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(RECOVERY_NOTICE_LIST)
  })

  it('forwards immutable output policy and transcript-free widget snapshots on fixed channels', async () => {
    const bridge = createSottoBridge(electronMock.ipcRenderer)
    const request = {
      text: 'session words',
      autoPaste: false,
      pasteDelayMs: 325,
    } as const
    electronMock.ipcRenderer.invoke
      .mockResolvedValueOnce('copied')
      .mockResolvedValueOnce({ ok: true })

    await expect(bridge.deliverOutput(request)).resolves.toBe('copied')
    await expect(bridge.publishWidgetState(idleWidgetSnapshot)).resolves.toEqual({ ok: true })

    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      1,
      OUTPUT_DELIVER,
      request,
    )
    expect(electronMock.ipcRenderer.invoke).toHaveBeenNthCalledWith(
      2,
      WIDGET_PUBLISH,
      idleWidgetSnapshot,
    )
  })

  it('strictly parses and freezes the no-payload model disclosure response', async () => {
    const bridge = createSottoBridge(electronMock.ipcRenderer)
    electronMock.ipcRenderer.invoke.mockResolvedValueOnce(disclosureCatalog)

    const result = await bridge.listModelDisclosures()

    expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(MODEL_LIST_DISCLOSURES)
    expect(result).toEqual(disclosureCatalog)
    expect(Object.isFrozen(result)).toBe(true)
    if ('models' in result) {
      expect(Object.isFrozen(result.models)).toBe(true)
      expect(result.models.every(Object.isFrozen)).toBe(true)
    }

    electronMock.ipcRenderer.invoke.mockResolvedValueOnce({ ...disclosureCatalog, injected: true })
    await expect(bridge.listModelDisclosures()).rejects.toThrow()
  })
})

describe('IPC validation and lifecycle', () => {
  it.each([
    SETTINGS_GET,
    SETTINGS_UPDATE,
    HISTORY_CLEAR,
    APP_QUIT,
    WIDGET_PUBLISH,
    OUTPUT_DELIVER,
    MODEL_LIST_DISCLOSURES,
  ])(
    'denies widget renderer invocation of main-only channel %s',
    async (channel) => {
      const harness = createIpcHarness()
      harness.cleanup()
      const widgetUrl = 'file:///C:/Sotto/out/renderer/widget.html'
      const widgetFrame = { parent: null, url: widgetUrl }
      const widgetContents = {
        getURL: (): string => widgetUrl,
        isDestroyed: (): boolean => false,
        mainFrame: widgetFrame,
      }
      registerIpc(harness.ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => [
          {
            role: 'main' as const,
            webContents: harness.trustedContents,
            url: harness.trustedUrl,
          },
          { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
        ],
      })

      await expect(
        harness.ipc.invokeArgs(channel, [], {
          sender: widgetContents,
          senderFrame: widgetFrame,
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED_IPC_SENDER' })
    },
  )

  it('returns disclosure without installation and keeps consented install separate', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const listDisclosures = vi.fn(() => disclosureCatalog)
    const install = vi.fn(async () => undefined)
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [{ role: 'main', webContents: harness.trustedContents, url: harness.trustedUrl }],
      models: {
        listDisclosures,
        getStatus: vi.fn(async () => ({ preset: 'fast' as const, state: 'missing' as const })),
        install,
        remove: vi.fn(),
      },
    })

    await expect(harness.ipc.invokeArgs(MODEL_LIST_DISCLOSURES, [])).resolves.toBe(disclosureCatalog)
    expect(listDisclosures).toHaveBeenCalledOnce()
    expect(install).not.toHaveBeenCalled()
    await expect(harness.ipc.invokeArgs(MODEL_LIST_DISCLOSURES, [{ injected: true }])).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
    await expect(harness.ipc.invoke(MODEL_INSTALL, { preset: 'fast', consent: false })).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
    await expect(harness.ipc.invoke(MODEL_INSTALL, { preset: 'fast', consent: true })).resolves.toEqual({ ok: true })
    expect(install).toHaveBeenCalledOnce()
  })

  it.each(['cancel', 'stop', 'toggle'] as const)(
    'allows a widget renderer to request the least-privilege %s command',
    async (type) => {
      const harness = createIpcHarness()
      harness.cleanup()
      const widgetUrl = 'file:///C:/Sotto/out/renderer/widget.html'
      const widgetFrame = { parent: null, url: widgetUrl }
      const widgetContents = {
        getURL: (): string => widgetUrl,
        isDestroyed: (): boolean => false,
        mainFrame: widgetFrame,
      }
      const request = vi.fn()
      registerIpc(harness.ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => [
          { role: 'widget', webContents: widgetContents, url: widgetUrl },
        ],
        dictation: { request, publishWidgetState: vi.fn() },
      })

      await expect(
        harness.ipc.invoke(
          DICTATION_REQUEST,
          { type },
          { sender: widgetContents, senderFrame: widgetFrame },
        ),
      ).resolves.toEqual({ ok: true })
      expect(request).toHaveBeenCalledWith({ type })
    },
  )

  it.each(['start'] as const)(
    'denies a widget renderer the privileged %s command',
    async (type) => {
      const harness = createIpcHarness()
      harness.cleanup()
      const widgetUrl = 'file:///C:/Sotto/out/renderer/widget.html'
      const widgetFrame = { parent: null, url: widgetUrl }
      const widgetContents = {
        getURL: (): string => widgetUrl,
        isDestroyed: (): boolean => false,
        mainFrame: widgetFrame,
      }
      const request = vi.fn()
      registerIpc(harness.ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => [
          { role: 'widget', webContents: widgetContents, url: widgetUrl },
        ],
        dictation: { request, publishWidgetState: vi.fn() },
      })

      await expect(
        harness.ipc.invoke(
          DICTATION_REQUEST,
          { type },
          { sender: widgetContents, senderFrame: widgetFrame },
        ),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED_IPC_SENDER' })
      expect(request).not.toHaveBeenCalled()
    },
  )

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
          RECOVERY_NOTICE_LIST,
        ].sort(),
      ),
    )
  })

  it('returns typed retained recovery notices to the trusted main renderer', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const list = vi.fn(() => [
      { code: 'SETTINGS_RECOVERED' as const },
      { code: 'HISTORY_RECOVERED' as const },
    ])
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        { role: 'main', webContents: harness.trustedContents, url: harness.trustedUrl },
      ],
      recoveryNotices: { list },
    })

    await expect(harness.ipc.invokeArgs(RECOVERY_NOTICE_LIST, [])).resolves.toEqual([
      { code: 'SETTINGS_RECOVERED' },
      { code: 'HISTORY_RECOVERED' },
    ])
    expect(list).toHaveBeenCalledOnce()
  })

  it('does not ask storage to read history when the authoritative setting disables it', async () => {
    const harness = createIpcHarness()
    harness.settings.get.mockResolvedValue({ ...DEFAULT_SETTINGS, historyEnabled: false })

    await expect(harness.ipc.invokeArgs(HISTORY_LIST, [])).resolves.toEqual([])

    expect(harness.history.list).toHaveBeenCalledWith({ enabled: false })
  })

  it('validates a settings patch before persistence and strips no fields silently', async () => {
    const { ipc, settings } = createIpcHarness()

    await expect(ipc.invoke(SETTINGS_UPDATE, { theme: 'dark', autoPaste: false })).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      theme: 'dark',
      autoPaste: false,
    })
    expect(settings.update).toHaveBeenCalledWith({ theme: 'dark', autoPaste: false })

    // Every patchable settings field must survive the allow-list transform:
    // a field missing from the IPC key list would be dropped silently and its
    // Settings control would snap back on save.
    const fullPatch: Record<string, unknown> = { ...DEFAULT_SETTINGS }
    delete fullPatch['hotkey']
    delete fullPatch['launchAtStartup']
    await ipc.invoke(SETTINGS_UPDATE, fullPatch)
    expect(settings.update).toHaveBeenLastCalledWith(fullPatch)

    await expect(ipc.invoke(SETTINGS_UPDATE, { theme: 'ultraviolet' })).rejects.toThrow(
      'Invalid IPC payload',
    )
    await expect(
      ipc.invoke(SETTINGS_UPDATE, { theme: 'dark', injectedChannel: 'app:quit' }),
    ).rejects.toThrow('Invalid IPC payload')
    expect(settings.update).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['hotkey', { hotkey: 'Alt+Space' }],
    ['startup', { launchAtStartup: true }],
  ] as const)('rejects native-managed %s in a generic settings payload', async (_name, patch) => {
    const { ipc, settings } = createIpcHarness()

    await expect(ipc.invoke(SETTINGS_UPDATE, patch)).rejects.toMatchObject({
      code: 'INVALID_IPC_PAYLOAD',
    })
    expect(settings.update).not.toHaveBeenCalled()
  })

  it('routes named hotkey and startup IPC through atomic native persistence', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    let persisted: AppSettings = { ...DEFAULT_SETTINGS }
    let activeHotkey: string | null = persisted.hotkey
    let startupEnabled = persisted.launchAtStartup
    const repository = {
      get: vi.fn(async () => ({ ...persisted })),
      update: vi.fn(async (patch: Partial<AppSettings>) => {
        persisted = { ...persisted, ...patch }
        return { ...persisted }
      }),
      save: vi.fn(async (settings: AppSettings) => {
        persisted = { ...settings }
        return { ...persisted }
      }),
      reset: vi.fn(async () => {
        persisted = { ...DEFAULT_SETTINGS }
        return { ...persisted }
      }),
    }
    const nativeHotkeys = {
      current: vi.fn(() => activeHotkey),
      replace: vi.fn((accelerator: string) => {
        activeHotkey = accelerator
        return { ok: true as const }
      }),
    }
    const nativeStartup = {
      get: vi.fn(() => ({ enabled: startupEnabled })),
      set: vi.fn((enabled: boolean) => {
        startupEnabled = enabled
        return { enabled }
      }),
    }
    const coordinator = new NativeSettingsCoordinator({
      repository,
      hotkeys: nativeHotkeys,
      startup: nativeStartup,
      onAutoPasteChanged: vi.fn(),
      onSettingsChanged: vi.fn(),
    })
    registerIpc(harness.ipc, {
      settings: {
        get: () => coordinator.getSettings(),
        update: (patch) => coordinator.updateSettings(patch),
        reset: () => coordinator.resetSettings(),
      },
      history: harness.history,
      startup: {
        get: () => coordinator.getStartup(),
        set: (enabled) => coordinator.setStartup(enabled),
      },
      hotkeys: {
        current: () => coordinator.getHotkey(),
        replace: (accelerator) => coordinator.replaceHotkey(accelerator),
      },
      app: harness.app,
      trustedSenders: () => [
        {
          role: 'main',
          webContents: harness.trustedContents,
          url: harness.trustedUrl,
        },
      ],
    })

    await expect(harness.ipc.invoke(HOTKEY_REPLACE, 'Alt+Space')).resolves.toEqual({
      ok: true,
    })
    await expect(harness.ipc.invoke(STARTUP_SET, true)).resolves.toEqual({ enabled: true })
    expect(activeHotkey).toBe('Alt+Space')
    expect(startupEnabled).toBe(true)
    expect(persisted).toMatchObject({ hotkey: 'Alt+Space', launchAtStartup: true })
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

  it('clamps stale renderer output policy against current authoritative settings', async () => {
    const harness = createIpcHarness()
    const pasteProcess = { run: vi.fn(async () => true) }
    const clipboard = { writeText: vi.fn() }
    const output = new OutputService({
      clipboard,
      widget: { hideWidget: vi.fn() },
      delay: vi.fn(),
      process: pasteProcess,
    })
    const deliver = vi.spyOn(output, 'deliver')
    harness.cleanup()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        {
          role: 'main',
          webContents: harness.trustedContents,
          url: harness.trustedUrl,
        },
      ],
      output,
    })
    harness.settings.get.mockResolvedValueOnce({
      ...DEFAULT_SETTINGS,
      autoPaste: false,
      pasteDelayMs: 480,
    })
    const request = { text: 'hello world', autoPaste: true, pasteDelayMs: 120 }
    await expect(harness.ipc.invoke(OUTPUT_DELIVER, request)).resolves.toBe('copied')
    expect(deliver).toHaveBeenCalledWith('hello world', {
      autoPaste: false,
      pasteDelayMs: 480,
    })
    expect(pasteProcess.run).not.toHaveBeenCalled()
    expect(clipboard.writeText).toHaveBeenCalledWith('hello world')
    expect(harness.settings.get).toHaveBeenCalledOnce()

    harness.settings.get.mockResolvedValueOnce({
      ...DEFAULT_SETTINGS,
      autoPaste: true,
      pasteDelayMs: 80,
    })
    await harness.ipc.invoke(OUTPUT_DELIVER, {
      text: 'session disabled',
      autoPaste: false,
      pasteDelayMs: 700,
    })
    expect(deliver).toHaveBeenLastCalledWith('session disabled', {
      autoPaste: false,
      pasteDelayMs: 700,
    })
    expect(pasteProcess.run).not.toHaveBeenCalled()

    await expect(
      harness.ipc.invoke(OUTPUT_DELIVER, {
        text: 'hostile',
        autoPaste: true,
        pasteDelayMs: 49,
      }),
    ).rejects.toThrow('Invalid IPC payload')
    await expect(harness.ipc.invoke(OUTPUT_DELIVER, 42)).rejects.toThrow(
      'Invalid IPC payload',
    )
    await expect(
      harness.ipc.invoke(OUTPUT_DELIVER, {
        text: 'x'.repeat(200_001),
        autoPaste: true,
        pasteDelayMs: 150,
      }),
    ).rejects.toThrow('Invalid IPC payload')
    await expect(
      harness.ipc.invoke(OUTPUT_DELIVER, { ...request, injected: 'app:quit' }),
    ).rejects.toThrow('Invalid IPC payload')
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('delivers empty output with the captured session policy', async () => {
    const harness = createIpcHarness()
    const deliver = vi.fn(async () => 'empty' as const)
    harness.cleanup()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        {
          role: 'main',
          webContents: harness.trustedContents,
          url: harness.trustedUrl,
        },
      ],
      output: { deliver },
    })
    await expect(harness.ipc.invoke(OUTPUT_DELIVER, {
      text: '',
      autoPaste: true,
      pasteDelayMs: 410,
    })).resolves.toBe('empty')
    expect(deliver).toHaveBeenCalledWith('', {
      autoPaste: true,
      pasteDelayMs: 410,
    })
  })

  it('accepts only strict transcript-free widget snapshots', async () => {
    const harness = createIpcHarness()
    const publishWidgetState = vi.fn()
    harness.cleanup()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [{
        role: 'main',
        webContents: harness.trustedContents,
        url: harness.trustedUrl,
      }],
      dictation: { request: vi.fn(), publishWidgetState },
    })

    await expect(harness.ipc.invoke(WIDGET_PUBLISH, idleWidgetSnapshot)).resolves.toEqual({ ok: true })
    expect(publishWidgetState).toHaveBeenCalledWith(idleWidgetSnapshot)
    await expect(harness.ipc.invoke(WIDGET_PUBLISH, { status: 'idle' })).rejects.toMatchObject({
      code: 'INVALID_IPC_PAYLOAD',
    })
    await expect(harness.ipc.invoke(WIDGET_PUBLISH, {
      status: 'success',
      sessionId: 'session',
      text: 'private transcript',
      output: 'copied',
    })).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
    await expect(harness.ipc.invoke(WIDGET_PUBLISH, {
      status: 'error', sessionId: 'session', code: 'NO_SPEECH',
      message: 'arbitrary transcript-like detail',
      theme: 'system', reducedMotion: 'system', shortcut: 'Primary', cancellable: false,
    })).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
    await expect(harness.ipc.invoke(WIDGET_PUBLISH, {
      status: 'error', sessionId: 'session', code: 'ARBITRARY_DETAIL',
      theme: 'system', reducedMotion: 'system', shortcut: 'Primary', cancellable: false,
    })).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
    expect(publishWidgetState).toHaveBeenCalledTimes(1)
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
      'throwing WebContents state check',
      (harness: ReturnType<typeof createIpcHarness>) => ({
        sender: {
          ...harness.trustedContents,
          isDestroyed: (): boolean => {
            throw new Error('secret renderer teardown detail')
          },
        },
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

  it('isolates per-channel cleanup failures and retains failed ownership safely', () => {
    const harness = createIpcHarness()
    const ownedChannels = [...harness.ipc.handlers.keys()]
    const failedChannels = new Set<string>([SETTINGS_GET, HISTORY_LIST])
    for (const channel of failedChannels) {
      harness.ipc.removeFailures.add(channel)
    }
    let cleanupError: unknown

    try {
      harness.cleanup()
    } catch (error) {
      cleanupError = error
    }

    expect(cleanupError).toMatchObject({ code: 'IPC_CLEANUP_FAILED' })
    expect(JSON.stringify(cleanupError)).not.toContain('secret')
    expect(harness.ipc.removed).toStrictEqual(ownedChannels)
    for (const channel of ownedChannels) {
      expect(harness.ipc.handlers.has(channel)).toBe(failedChannels.has(channel))
    }

    const attemptsAfterCleanup = [...harness.ipc.removed]
    expect(() =>
      registerIpc(harness.ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => [
          {
            role: 'main',
            webContents: harness.trustedContents,
            url: harness.trustedUrl,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'IPC_REGISTRATION_ACTIVE' }))
    expect(harness.ipc.removed).toStrictEqual(attemptsAfterCleanup)

    expect(() => harness.cleanup()).not.toThrow()
    expect(harness.ipc.removed).toStrictEqual(attemptsAfterCleanup)
  })

  it('rejects overlapping registration without touching the active handlers', async () => {
    const harness = createIpcHarness()
    const activeSettingsHandler = harness.ipc.handlers.get(SETTINGS_GET)
    const removedBefore = [...harness.ipc.removed]
    let registrationError: unknown

    try {
      registerIpc(harness.ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => [
          {
            role: 'main',
            webContents: harness.trustedContents,
            url: harness.trustedUrl,
          },
        ],
      })
    } catch (error) {
      registrationError = error
    }

    expect(registrationError).toMatchObject({ code: 'IPC_REGISTRATION_ACTIVE' })
    expect(harness.ipc.handlers.get(SETTINGS_GET)).toBe(activeSettingsHandler)
    expect(harness.ipc.removed).toStrictEqual(removedBefore)
    await expect(harness.ipc.invoke(SETTINGS_GET)).resolves.toStrictEqual(DEFAULT_SETTINGS)
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
          {
            role: 'main',
            webContents: harness.trustedContents,
            url: harness.trustedUrl,
          },
        ],
      }),
    ).toThrow(`handler already exists: ${HISTORY_LIST}`)

    expect([...harness.ipc.handlers.entries()]).toStrictEqual([
      [HISTORY_LIST, externalHandler],
    ])
  })

  it('preserves registration failure when rollback cleanup also fails', () => {
    const harness = createIpcHarness()
    harness.cleanup()
    harness.ipc.removed.splice(0)
    const externalHandler = vi.fn()
    harness.ipc.handlers.set(HISTORY_LIST, externalHandler)
    harness.ipc.removeFailures.add(SETTINGS_GET)
    let registrationError: unknown

    try {
      registerIpc(harness.ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => [
          {
            role: 'main',
            webContents: harness.trustedContents,
            url: harness.trustedUrl,
          },
        ],
      })
    } catch (error) {
      registrationError = error
    }

    expect(registrationError).toMatchObject({
      message: `handler already exists: ${HISTORY_LIST}`,
    })
    expect(JSON.stringify(registrationError)).not.toContain('secret remove failure')
    expect(harness.ipc.handlers.get(HISTORY_LIST)).toBe(externalHandler)
    expect(harness.ipc.removed).toEqual(
      expect.arrayContaining([SETTINGS_GET, SETTINGS_UPDATE, SETTINGS_RESET]),
    )

    const attemptsAfterRollback = [...harness.ipc.removed]
    expect(() =>
      registerIpc(harness.ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => [],
      }),
    ).toThrowError(expect.objectContaining({ code: 'IPC_REGISTRATION_ACTIVE' }))
    expect(harness.ipc.removed).toStrictEqual(attemptsAfterRollback)
  })
})

describe('permission policy', () => {
  function createAtomicSession() {
    let permissionRequest: PermissionRequestHandler | null = null
    let permissionCheck: PermissionCheckHandler | null = null
    const session: SessionPermissionAdapter = {
      setPermissionRequestHandler: vi.fn((handler) => {
        permissionRequest = handler
      }),
      setPermissionCheckHandler: vi.fn((handler) => {
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
    const packagedContents = { getURL: () => 'file:///C:/Sotto/out/renderer/index.html' }
    const developmentContents = { getURL: () => 'http://127.0.0.1:5173/' }
    installSessionPermissionPolicy(harness.session, () => [
      {
        role: 'main',
        webContents: packagedContents,
        url: 'file:///C:/Sotto/out/renderer/index.html',
      },
      {
        role: 'main',
        webContents: developmentContents,
        url: 'http://127.0.0.1:5173/',
      },
    ])

    const trustedAudio = vi.fn()
    harness.permissionRequest(
      packagedContents,
      'media',
      trustedAudio,
      {
        isMainFrame: true,
        requestingUrl: 'file:///C:/Sotto/out/renderer/index.html',
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

  it('resolves trusted renderer identity at request time after renderer replacement', () => {
    const harness = createSession()
    const trustedUrl = 'file:///C:/Sotto/out/renderer/index.html'
    const originalContents = { getURL: () => trustedUrl }
    const replacementContents = { getURL: () => trustedUrl }
    let trustedRenderers = [
      { role: 'main' as const, webContents: originalContents, url: trustedUrl },
    ]
    installSessionPermissionPolicy(harness.session, () => trustedRenderers)

    expect(
      harness.permissionCheck(originalContents, 'media', trustedUrl, {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: trustedUrl,
      }),
    ).toBe(true)

    trustedRenderers = [
      { role: 'main' as const, webContents: replacementContents, url: trustedUrl },
    ]

    expect(
      harness.permissionCheck(originalContents, 'media', trustedUrl, {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: trustedUrl,
      }),
    ).toBe(false)
    expect(
      harness.permissionCheck(replacementContents, 'media', trustedUrl, {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: trustedUrl,
      }),
    ).toBe(true)
  })

  it('denies microphone permission to a trusted widget identity', () => {
    const harness = createSession()
    const widgetUrl = 'file:///C:/Sotto/out/renderer/widget.html'
    const widgetContents = { getURL: () => widgetUrl }
    installSessionPermissionPolicy(harness.session, () => [
      { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
    ])

    expect(
      harness.permissionCheck(widgetContents, 'media', widgetUrl, {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: widgetUrl,
      }),
    ).toBe(false)
  })

  it('fails closed when renderer liveness inspection throws', () => {
    const harness = createSession()
    const trustedUrl = 'file:///C:/Sotto/out/renderer/index.html'
    const trustedContents = {
      getURL: () => trustedUrl,
      isDestroyed: (): boolean => {
        throw new Error('secret renderer teardown detail')
      },
    }
    installSessionPermissionPolicy(harness.session, () => [
      { role: 'main', webContents: trustedContents, url: trustedUrl },
    ])

    expect(() =>
      harness.permissionCheck(trustedContents, 'media', trustedUrl, {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: trustedUrl,
      }),
    ).not.toThrow()
    expect(
      harness.permissionCheck(trustedContents, 'media', trustedUrl, {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: trustedUrl,
      }),
    ).toBe(false)
  })

  it('rolls back a partial first installation and permits a clean retry', () => {
    const harness = createAtomicSession()
    const trustedUrl = 'file:///C:/Sotto/out/renderer/index.html'
    const trustedContents = { getURL: () => trustedUrl }
    vi.mocked(harness.session.setPermissionRequestHandler).mockImplementationOnce(() => {
      throw new Error('secret native setter detail')
    })
    let installError: unknown

    try {
      installSessionPermissionPolicy(harness.session, () => [
        { role: 'main', webContents: trustedContents, url: trustedUrl },
      ])
    } catch (error) {
      installError = error
    }

    expect(installError).toMatchObject({ code: 'PERMISSION_POLICY_INSTALL_FAILED' })
    expect(harness.permissionCheck).toBeNull()
    expect(harness.permissionRequest).toBeNull()

    expect(() =>
      installSessionPermissionPolicy(harness.session, () => [
        { role: 'main', webContents: trustedContents, url: trustedUrl },
      ]),
    ).not.toThrow()
    expect(harness.permissionCheck).not.toBeNull()
    expect(harness.permissionRequest).not.toBeNull()
  })

  it('restores the prior policy when replacement installation fails', () => {
    const harness = createAtomicSession()
    const originalUrl = 'file:///C:/Sotto/out/renderer/index.html'
    const originalContents = { getURL: () => originalUrl }
    const replacementUrl = 'file:///C:/Sotto/out/renderer/replacement.html'
    const replacementContents = { getURL: () => replacementUrl }
    const originalCleanup = installSessionPermissionPolicy(harness.session, () => [
      { role: 'main', webContents: originalContents, url: originalUrl },
    ])
    const originalCheck = harness.permissionCheck
    const originalRequest = harness.permissionRequest
    vi.mocked(harness.session.setPermissionRequestHandler).mockImplementationOnce(() => {
      throw new Error('secret native setter detail')
    })

    expect(() =>
      installSessionPermissionPolicy(harness.session, () => [
        { role: 'main', webContents: replacementContents, url: replacementUrl },
      ]),
    ).toThrow()

    expect(harness.permissionCheck).toBe(originalCheck)
    expect(harness.permissionRequest).toBe(originalRequest)
    expect(
      harness.permissionCheck?.(originalContents, 'media', originalUrl, {
        isMainFrame: true,
        mediaType: 'audio',
        requestingUrl: originalUrl,
      }),
    ).toBe(true)
    originalCleanup()
  })

  it('restores nested ownership in order and stale cleanup never clears a newer policy', () => {
    const harness = createAtomicSession()
    const originalUrl = 'file:///C:/Sotto/out/renderer/index.html'
    const originalContents = { getURL: () => originalUrl }
    const replacementUrl = 'file:///C:/Sotto/out/renderer/replacement.html'
    const replacementContents = { getURL: () => replacementUrl }
    const originalCleanup = installSessionPermissionPolicy(harness.session, () => [
      { role: 'main', webContents: originalContents, url: originalUrl },
    ])
    const originalCheck = harness.permissionCheck
    const replacementCleanup = installSessionPermissionPolicy(harness.session, () => [
      { role: 'main', webContents: replacementContents, url: replacementUrl },
    ])
    const replacementCheck = harness.permissionCheck

    originalCleanup()
    expect(harness.permissionCheck).toBe(replacementCheck)

    replacementCleanup()
    expect(harness.permissionCheck).toBeNull()
    expect(harness.permissionRequest).toBeNull()

    const restoredOriginalCleanup = installSessionPermissionPolicy(harness.session, () => [
      { role: 'main', webContents: originalContents, url: originalUrl },
    ])
    const nestedCleanup = installSessionPermissionPolicy(harness.session, () => [
      { role: 'main', webContents: replacementContents, url: replacementUrl },
    ])
    nestedCleanup()
    expect(harness.permissionCheck).not.toBe(replacementCheck)
    expect(harness.permissionCheck).not.toBeNull()
    restoredOriginalCleanup()
    expect(harness.permissionCheck).toBeNull()
    expect(originalCheck).not.toBeNull()
  })

  it('resets only its two permission handlers during idempotent cleanup', () => {
    const harness = createSession()
    const trustedContents = { getURL: () => 'file:///C:/Sotto/out/renderer/index.html' }
    const cleanup = installSessionPermissionPolicy(harness.session, () => [
      {
        role: 'main',
        webContents: trustedContents,
        url: 'file:///C:/Sotto/out/renderer/index.html',
      },
    ])

    cleanup()
    cleanup()

    expect(harness.session.setPermissionCheckHandler).toHaveBeenLastCalledWith(null)
    expect(harness.session.setPermissionRequestHandler).toHaveBeenLastCalledWith(null)
  })

  it.each([
    ['untrusted audio', 'media', 'https://attacker.invalid/', ['audio']],
    ['trusted video', 'media', 'file:///C:/Sotto/out/renderer/index.html', ['video']],
    ['trusted display capture', 'display-capture', 'file:///C:/Sotto/out/renderer/index.html', []],
    ['trusted notifications', 'notifications', 'file:///C:/Sotto/out/renderer/index.html', []],
    ['trusted clipboard read', 'clipboard-read', 'file:///C:/Sotto/out/renderer/index.html', []],
  ])('denies %s', (_name, permission, requestingUrl, mediaTypes) => {
    const harness = createSession()
    const trustedContents = { getURL: () => 'file:///C:/Sotto/out/renderer/index.html' }
    const untrustedContents = { getURL: () => 'https://attacker.invalid/' }
    installSessionPermissionPolicy(harness.session, () => [
      {
        role: 'main',
        webContents: trustedContents,
        url: 'file:///C:/Sotto/out/renderer/index.html',
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
    const trustedContents = { getURL: () => 'file:///C:/Sotto/out/renderer/index.html' }
    installSessionPermissionPolicy(harness.session, () => [
      {
        role: 'main',
        webContents: trustedContents,
        url: 'file:///C:/Sotto/out/renderer/index.html',
      },
    ])
    const callback = vi.fn()

    harness.permissionRequest(trustedContents, 'media', callback, {
      requestingUrl: 'file:///C:/Sotto/out/renderer/index.html',
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
  it('fails closed before runtime startup when bundled manifest initialization rejects', async () => {
    const app = createApp(Promise.resolve())
    const log = vi.fn()
    const initialize = vi.fn(async (): Promise<RuntimeController> => {
      throw new Error('Invalid bundled model manifest: private path')
    })

    const result = await bootstrapSotto({ app, initialize, log })

    expect(result.started).toBe(false)
    expect(initialize).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith('bootstrap-startup-failed')
    expect(JSON.stringify(log.mock.calls)).not.toContain('private')
    expect(app.quit).toHaveBeenCalledOnce()
  })

  it('catches readiness rejection, emits only a safe diagnostic, and quits in a controlled way', async () => {
    const app = createApp(Promise.reject(new Error('secret token C:/Users/private')))
    const log = vi.fn()
    const initialize = vi.fn(async () => createRuntime())

    const result = await bootstrapSotto({ app, initialize, log })

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

    const result = await bootstrapSotto({
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
    const result = await bootstrapSotto({
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

    const result = await bootstrapSotto({ app, initialize, log: vi.fn() })

    expect(result.started).toBe(false)
    expect(app.quit).toHaveBeenCalledOnce()
    expect(initialize).not.toHaveBeenCalled()
  })

  it('stops before initialization when before-quit wins during readiness', async () => {
    const readiness = createDeferred<void>()
    const app = createApp(readiness.promise)
    const initialize = vi.fn(async () => createRuntime())
    const log = vi.fn()
    const bootstrap = bootstrapSotto({ app, initialize, log })

    app.emit('before-quit')
    readiness.resolve()

    await expect(bootstrap).resolves.toMatchObject({ started: false })
    expect(initialize).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('disposes a late initialization candidate when before-quit has already won', async () => {
    const initialization = createDeferred<RuntimeController>()
    const app = createApp(Promise.resolve())
    const initialize = vi.fn(() => initialization.promise)
    const log = vi.fn()
    const bootstrap = bootstrapSotto({ app, initialize, log })
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce())

    app.emit('before-quit')
    const candidate = createRuntime()
    initialization.resolve(candidate)

    await expect(bootstrap).resolves.toMatchObject({ started: false })
    expect(candidate.start).not.toHaveBeenCalled()
    expect(candidate.beginQuit).toHaveBeenCalledOnce()
    expect(candidate.dispose).toHaveBeenCalledOnce()
    expect(log).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('contains an expected stopped rejection after before-quit during runtime startup', async () => {
    const startup = createDeferred<void>()
    const app = createApp(Promise.resolve())
    const runtime = createRuntime(() => startup.promise)
    const log = vi.fn()
    const bootstrap = bootstrapSotto({
      app,
      initialize: async () => runtime,
      log,
    })
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledOnce())

    app.emit('second-instance')
    app.emit('before-quit')
    startup.reject(new NativeRuntimeStoppedError())

    await expect(bootstrap).resolves.toMatchObject({ started: false })
    expect(runtime.showMain).not.toHaveBeenCalled()
    expect(runtime.beginQuit).toHaveBeenCalledOnce()
    expect(runtime.dispose).toHaveBeenCalledOnce()
    expect(log).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('coalesces second-instance intent across readiness and startup, then shows immediately', async () => {
    const readiness = createDeferred<void>()
    const startup = createDeferred<void>()
    const app = createApp(readiness.promise)
    const runtime = createRuntime(() => startup.promise)
    const bootstrap = bootstrapSotto({
      app,
      initialize: async () => runtime,
      log: vi.fn(),
    })

    app.emit('second-instance')
    app.emit('second-instance')
    readiness.resolve()
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledOnce())
    app.emit('second-instance')
    app.emit('second-instance')
    const callsBeforeStartupCompleted = runtime.showMain.mock.calls.length
    startup.resolve()

    await expect(bootstrap).resolves.toMatchObject({ started: true })
    expect(callsBeforeStartupCompleted).toBe(0)
    expect(runtime.showMain).toHaveBeenCalledOnce()

    app.emit('second-instance')
    expect(runtime.showMain).toHaveBeenCalledTimes(2)
  })

  it('retains second-instance intent while initialization is pending for a minimized runtime', async () => {
    const initialization = createDeferred<RuntimeController>()
    const app = createApp(Promise.resolve())
    const initialize = vi.fn(() => initialization.promise)
    const bootstrap = bootstrapSotto({ app, initialize, log: vi.fn() })
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce())

    app.emit('second-instance')
    app.emit('second-instance')
    const minimizedRuntime = createRuntime()
    initialization.resolve(minimizedRuntime)

    await expect(bootstrap).resolves.toMatchObject({ started: true })
    expect(minimizedRuntime.start).toHaveBeenCalledOnce()
    expect(minimizedRuntime.showMain).toHaveBeenCalledOnce()
  })

  it('drops pending second-instance intent when startup fails', async () => {
    const startup = createDeferred<void>()
    const app = createApp(Promise.resolve())
    const runtime = createRuntime(() => startup.promise)
    const log = vi.fn()
    const bootstrap = bootstrapSotto({
      app,
      initialize: async () => runtime,
      log,
    })
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledOnce())

    app.emit('second-instance')
    app.emit('second-instance')
    startup.reject(new Error('real startup failure'))

    await expect(bootstrap).resolves.toMatchObject({ started: false })
    expect(runtime.showMain).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('bootstrap-startup-failed')
    expect(app.quit).toHaveBeenCalledOnce()
  })

  it.each([
    ['beginQuit', 'bootstrap-runtime-begin-quit-failed'],
    ['dispose', 'bootstrap-runtime-dispose-failed'],
  ] as const)(
    'isolates a throwing candidate %s during before-quit',
    async (failingMethod, expectedCode) => {
      const app = createApp(Promise.resolve())
      const log = vi.fn()
      const candidate = createRuntime()
      candidate[failingMethod].mockImplementation(() => {
        throw new Error('secret native teardown detail')
      })
      const result = await bootstrapSotto({
        app,
        initialize: async () => candidate,
        log,
      })

      expect(() => app.emit('before-quit')).not.toThrow()
      expect(candidate.beginQuit).toHaveBeenCalledOnce()
      expect(candidate.dispose).toHaveBeenCalledOnce()
      expect(log).toHaveBeenCalledWith(expectedCode)
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret')

      expect(() => result.dispose()).not.toThrow()
      expect(candidate.beginQuit).toHaveBeenCalledOnce()
      expect(candidate.dispose).toHaveBeenCalledOnce()
    },
  )
})

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

describe('widget presentation and drag channels', () => {
  function widgetSender() {
    const widgetUrl = 'file:///C:/Sotto/out/renderer/widget.html'
    const widgetFrame = { parent: null, url: widgetUrl }
    const widgetContents = {
      getURL: (): string => widgetUrl,
      isDestroyed: (): boolean => false,
      mainFrame: widgetFrame,
    }
    return { widgetContents, widgetFrame, widgetUrl }
  }

  it('forwards only strict generation-bound presentation and drag reports', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const { widgetContents, widgetFrame, widgetUrl } = widgetSender()
    const setPresentation = vi.fn()
    const reportDrag = vi.fn()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
      ],
      widget: { setPresentation, reportDrag },
    })
    const widgetEvent = { sender: widgetContents, senderFrame: widgetFrame }
    const presentation = { presentation: 'active', generation: 9 } as const
    const drag = { phase: 'move', generation: 9, gestureId: 4 } as const

    await expect(
      harness.ipc.invoke(WIDGET_PRESENTATION, presentation, widgetEvent),
    ).resolves.toEqual({ ok: true })
    await expect(
      harness.ipc.invoke(WIDGET_DRAG, drag, widgetEvent),
    ).resolves.toEqual({ ok: true })
    expect(setPresentation).toHaveBeenCalledWith(presentation)
    expect(reportDrag).toHaveBeenCalledWith(drag)

    for (const payload of [
      { presentation: 'active' },
      { presentation: 'active', generation: -1 },
      { presentation: 'active', generation: 1.5 },
      { presentation: 'active', generation: 9, extra: true },
    ]) {
      await expect(
        harness.ipc.invoke(WIDGET_PRESENTATION, payload, widgetEvent),
      ).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
    }
    for (const payload of [
      { phase: 'move' },
      { phase: 'move', generation: 9 },
      { phase: 'move', generation: -1, gestureId: 4 },
      { phase: 'move', generation: 1.5, gestureId: 4 },
      { phase: 'move', generation: 9, gestureId: -1 },
      { phase: 'move', generation: 9, gestureId: 1.5 },
      { phase: 'move', generation: 9, gestureId: 4, extra: true },
    ]) {
      await expect(
        harness.ipc.invoke(WIDGET_DRAG, payload, widgetEvent),
      ).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
    }
    expect(setPresentation).toHaveBeenCalledOnce()
    expect(reportDrag).toHaveBeenCalledOnce()
  })

  it('lets only the trusted widget renderer set presentation', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const { widgetContents, widgetFrame, widgetUrl } = widgetSender()
    const setPresentation = vi.fn()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        { role: 'main' as const, webContents: harness.trustedContents, url: harness.trustedUrl },
        { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
      ],
      widget: { setPresentation, reportDrag: vi.fn() },
    })

    const report = { presentation: 'idle-resting', generation: 3 } as const
    await expect(
      harness.ipc.invoke(WIDGET_PRESENTATION, report, {
        sender: widgetContents,
        senderFrame: widgetFrame,
      }),
    ).resolves.toEqual({ ok: true })
    expect(setPresentation).toHaveBeenCalledWith(report)

    await expect(
      harness.ipc.invoke(WIDGET_PRESENTATION, { presentation: 'active', generation: 3 }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED_IPC_SENDER' })
    expect(setPresentation).toHaveBeenCalledOnce()
  })

  it('accepts idle-resting idle-hovered and active', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const { widgetContents, widgetFrame, widgetUrl } = widgetSender()
    const setPresentation = vi.fn()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
      ],
      widget: { setPresentation, reportDrag: vi.fn() },
    })
    const widgetEvent = { sender: widgetContents, senderFrame: widgetFrame }

    for (const presentation of ['idle-resting', 'idle-hovered', 'active'] as const) {
      const report = { presentation, generation: 5 } as const
      await expect(
        harness.ipc.invoke(WIDGET_PRESENTATION, report, widgetEvent),
      ).resolves.toEqual({ ok: true })
      expect(setPresentation).toHaveBeenLastCalledWith(report)
    }
    expect(setPresentation).toHaveBeenCalledTimes(3)
  })

  it('active presentation resizes without recreating the widget', async () => {
    const nativeWindows: IpcLifecycleWindow[] = []
    const createWindow = vi.fn((options: WindowConstructorOptions) => {
      const role = options.webPreferences.additionalArguments[0].endsWith('widget')
        ? 'widget'
        : 'main'
      const window = new IpcLifecycleWindow(role, options)
      nativeWindows.push(window)
      return window
    })
    const windows = new WindowManager({
      createWindow,
      display: {
        getCursorScreenPoint: () => ({ x: 1_700, y: 970 }),
        getDisplayNearestPoint: () => ({
          workArea: { x: 1_000, y: 100, width: 1_200, height: 900 },
        }),
      },
      preloadPath: 'C:/Sotto/out/preload/index.js',
      mainHtmlPath: 'C:/Sotto/out/renderer/index.html',
      widgetHtmlPath: 'C:/Sotto/out/renderer/widget.html',
      developmentSources: undefined,
      isPackaged: true,
      log: vi.fn(),
      getWidgetPlacement: () => null,
      onWidgetMoved: vi.fn(),
    })
    const harness = createIpcHarness()
    harness.cleanup()
    let cleanup = (): void => undefined

    try {
      await windows.createWindows()
      await windows.showWidget()
      const widget = nativeWindows[1]!
      cleanup = registerIpc(harness.ipc, {
        settings: harness.settings,
        history: harness.history,
        startup: harness.startup,
        hotkeys: harness.hotkeys,
        app: harness.app,
        trustedSenders: () => windows.getTrustedRenderers(),
        widget: {
          setPresentation: (presentation) => windows.setWidgetPresentation(presentation),
          reportDrag: (payload) => windows.reportWidgetDrag(payload),
        },
      })
      const widgetEvent = {
        sender: widget.webContents,
        senderFrame: widget.webContents.mainFrame,
      }

      await expect(
        harness.ipc.invoke(
          WIDGET_PRESENTATION,
          { presentation: 'active', generation: 1 },
          widgetEvent,
        ),
      ).resolves.toEqual({ ok: true })

      expect(widget.getBounds()).toMatchObject({ width: 248, height: 88 })
      expect(widget.setBounds).toHaveBeenLastCalledWith(
        { x: 1_476, y: 896, width: 248, height: 88 },
        false,
      )
      expect(createWindow).toHaveBeenCalledTimes(2)
      expect(nativeWindows[1]).toBe(widget)
    } finally {
      cleanup()
      windows.dispose()
    }
  })

  it('rejects unknown non-string and object presentation payloads', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const { widgetContents, widgetFrame, widgetUrl } = widgetSender()
    const setPresentation = vi.fn()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
      ],
      widget: { setPresentation, reportDrag: vi.fn() },
    })
    const widgetEvent = { sender: widgetContents, senderFrame: widgetFrame }

    for (const payload of ['idle-expanded', 42, { presentation: 'active' }]) {
      await expect(
        harness.ipc.invoke(WIDGET_PRESENTATION, payload, widgetEvent),
      ).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
    }
    expect(setPresentation).not.toHaveBeenCalled()
  })

  it('reports unavailable when no widget coordinator is registered', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const { widgetContents, widgetFrame, widgetUrl } = widgetSender()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
      ],
    })

    await expect(
      harness.ipc.invoke(WIDGET_PRESENTATION, {
        presentation: 'idle-resting',
        generation: 0,
      }, {
        sender: widgetContents,
        senderFrame: widgetFrame,
      }),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })

  it('lets only the widget renderer report drag phases and forwards each payload', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const { widgetContents, widgetFrame, widgetUrl } = widgetSender()
    const reportDrag = vi.fn()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        { role: 'main' as const, webContents: harness.trustedContents, url: harness.trustedUrl },
        { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
      ],
      widget: { setPresentation: vi.fn(), reportDrag },
    })
    const widgetEvent = { sender: widgetContents, senderFrame: widgetFrame }

    for (const payload of [
      { phase: 'start', generation: 5, gestureId: 8 },
      { phase: 'move', generation: 5, gestureId: 8 },
      { phase: 'end', generation: 5, gestureId: 8 },
    ] as const) {
      await expect(
        harness.ipc.invoke(WIDGET_DRAG, payload, widgetEvent),
      ).resolves.toEqual({ ok: true })
      expect(reportDrag).toHaveBeenLastCalledWith(payload)
    }
    expect(reportDrag).toHaveBeenCalledTimes(3)

    // The main renderer and unknown senders may not drive the widget window.
    await expect(
      harness.ipc.invoke(WIDGET_DRAG, { phase: 'start', generation: 5 }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED_IPC_SENDER' })
    expect(reportDrag).toHaveBeenCalledTimes(3)
  })

  it('rejects malformed drag payloads before they reach the window seam', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const { widgetContents, widgetFrame, widgetUrl } = widgetSender()
    const reportDrag = vi.fn()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
      ],
      widget: { setPresentation: vi.fn(), reportDrag },
    })
    const widgetEvent = { sender: widgetContents, senderFrame: widgetFrame }

    for (const payload of [
      { phase: 'hover', generation: 1, gestureId: 3 },
      { phase: 'move', generation: 1, gestureId: 3, x: 1, y: 0 },
      { phase: 'move', generation: 1, gestureId: 3, extra: true },
      { phase: 'start', generation: 1, gestureId: 3, x: 1, y: 1 },
      { phase: 'end', generation: 1, gestureId: 3, extra: true },
      { phase: 'move', generation: 1 },
      { phase: 'move' },
      'start',
      null,
    ]) {
      await expect(
        harness.ipc.invoke(WIDGET_DRAG, payload, widgetEvent),
      ).rejects.toMatchObject({ code: 'INVALID_IPC_PAYLOAD' })
    }
    expect(reportDrag).not.toHaveBeenCalled()
  })

  it('reports unavailable drag handling when no widget dependency is registered', async () => {
    const harness = createIpcHarness()
    harness.cleanup()
    const { widgetContents, widgetFrame, widgetUrl } = widgetSender()
    registerIpc(harness.ipc, {
      settings: harness.settings,
      history: harness.history,
      startup: harness.startup,
      hotkeys: harness.hotkeys,
      app: harness.app,
      trustedSenders: () => [
        { role: 'widget' as const, webContents: widgetContents, url: widgetUrl },
      ],
    })

    await expect(
      harness.ipc.invoke(WIDGET_DRAG, { phase: 'start', generation: 0, gestureId: 0 }, {
        sender: widgetContents,
        senderFrame: widgetFrame,
      }),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' })
  })
})
