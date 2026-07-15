import { act, render, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type {
  CommandResult,
  DictationCommand,
  TalkTypeBridge,
} from '../../src/shared/contracts'
import type { DictationState, WidgetSnapshot } from '../../src/shared/dictation'
import type { HistoryEntry } from '../../src/shared/history'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/settings'
import {
  AppProvider,
  createProductionDictationController,
  useApp,
  type AppContextValue,
  type AppControllerFactory,
  type AppControllerFactoryBindings,
} from '../../src/renderer/src/state/AppContext'

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, reject, resolve }
}

const OK = Object.freeze({ ok: true as const })

function createBridge(overrides: Partial<TalkTypeBridge> = {}): TalkTypeBridge {
  return {
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
    updateSettings: vi.fn(async (patch) => ({ ...DEFAULT_SETTINGS, ...patch })),
    resetSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
    listHistory: vi.fn(async () => []),
    addHistory: vi.fn(async (entry) => [entry]),
    searchHistory: vi.fn(async () => []),
    deleteHistory: vi.fn(async () => true),
    clearHistory: vi.fn(async () => undefined),
    getHotkey: vi.fn(async () => DEFAULT_SETTINGS.hotkey),
    replaceHotkey: vi.fn(async () => OK),
    requestDictation: vi.fn(async () => OK),
    onDictationCommand: vi.fn(() => () => undefined),
    publishWidgetState: vi.fn(async () => OK),
    getModelStatus: vi.fn(async (preset) => ({ preset, state: 'ready' as const })),
    listModelDisclosures: vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const })),
    installModel: vi.fn(async () => OK),
    removeModel: vi.fn(async () => OK),
    onModelStatus: vi.fn(() => () => undefined),
    deliverOutput: vi.fn(async () => 'copied' as const),
    getStartup: vi.fn(async () => ({ enabled: false })),
    setStartup: vi.fn(async (enabled) => ({ enabled })),
    showApp: vi.fn(async () => undefined),
    hideApp: vi.fn(async () => undefined),
    minimizeApp: vi.fn(async () => undefined),
    quitApp: vi.fn(async () => undefined),
    ...overrides,
  }
}

interface FakeController {
  readonly start: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly stop: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly toggle: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly cancel: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly dispose: ReturnType<typeof vi.fn<() => void>>
  getState(): DictationState
}

function createControllerFactory(state: DictationState = { status: 'idle' }) {
  const controllers: FakeController[] = []
  const bindings: AppControllerFactoryBindings[] = []
  const factory: AppControllerFactory = (nextBindings) => {
    bindings.push(nextBindings)
    let current = state
    const controller: FakeController = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      toggle: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      dispose: vi.fn(),
      getState: () => current,
    }
    Object.defineProperty(controller, 'setState', {
      value: (next: DictationState) => {
        current = next
      },
    })
    controllers.push(controller)
    return controller
  }
  return { bindings, controllers, factory }
}

let currentContext: AppContextValue | undefined

function Probe(): ReactNode {
  currentContext = useApp()
  return null
}

function mountProvider(bridge: TalkTypeBridge, createController: AppControllerFactory) {
  currentContext = undefined
  return render(
    createElement(
      AppProvider,
      { bridge, createController },
      createElement(Probe),
    ),
  )
}

describe('AppProvider dictation integration', () => {
  it('loads settings and history in parallel, then replays every buffered command exactly once', async () => {
    const settings = deferred<AppSettings>()
    const history = deferred<HistoryEntry[]>()
    const buffered: DictationCommand[] = [{ type: 'toggle' }, { type: 'stop' }, { type: 'cancel' }]
    let commandListener: ((command: DictationCommand) => void) | null = null
    const unsubscribe = vi.fn()
    const bridge = createBridge({
      getSettings: vi.fn(() => settings.promise),
      listHistory: vi.fn(() => history.promise),
      onDictationCommand: vi.fn((listener) => {
        commandListener = listener
        for (const command of buffered.splice(0)) listener(command)
        return unsubscribe
      }),
    })
    const harness = createControllerFactory()

    const view = mountProvider(bridge, harness.factory)
    expect(bridge.getSettings).toHaveBeenCalledOnce()
    expect(bridge.listHistory).toHaveBeenCalledOnce()
    expect(bridge.onDictationCommand).not.toHaveBeenCalled()

    settings.resolve({ ...DEFAULT_SETTINGS })
    await waitFor(() => expect(harness.controllers).toHaveLength(1))
    expect(harness.controllers[0]?.toggle).toHaveBeenCalledOnce()
    expect(harness.controllers[0]?.stop).toHaveBeenCalledOnce()
    expect(harness.controllers[0]?.cancel).toHaveBeenCalledOnce()
    expect(currentContext?.status).toBe('ready')

    history.resolve([])
    await waitFor(() => expect(currentContext?.historyStatus).toBe('ready'))
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(harness.controllers[0]?.dispose).toHaveBeenCalledOnce()
    expect(commandListener).not.toBeNull()
  })

  it('updates React dictation state and publishes transcript-free snapshots with copied/pasted distinction', async () => {
    const bridge = createBridge()
    const harness = createControllerFactory()
    mountProvider(bridge, harness.factory)
    await waitFor(() => expect(harness.bindings).toHaveLength(1))

    const bindings = harness.bindings[0]!
    const controller = harness.controllers[0] as FakeController & {
      setState(next: DictationState): void
    }
    const copied: WidgetSnapshot = {
      status: 'success', sessionId: 'one', output: 'copied', theme: 'dark',
      reducedMotion: 'system', shortcut: 'Primary', cancellable: false,
    }
    controller.setState({ status: 'success', sessionId: 'one', text: 'private words', output: 'copied' })
    await act(async () => bindings.publishWidgetState(copied))
    expect(currentContext?.dictation).toEqual({
      status: 'success', sessionId: 'one', text: 'private words', output: 'copied',
    })
    expect(bridge.publishWidgetState).toHaveBeenLastCalledWith(copied)
    expect(JSON.stringify((bridge.publishWidgetState as ReturnType<typeof vi.fn>).mock.lastCall)).not.toContain('private words')

    const pasted = { ...copied, sessionId: 'two', output: 'pasted' as const }
    controller.setState({ status: 'success', sessionId: 'two', text: 'other private words', output: 'pasted' })
    await act(async () => bindings.publishWidgetState(pasted))
    expect(currentContext?.dictation).toMatchObject({ status: 'success', output: 'pasted' })
    expect(bridge.publishWidgetState).toHaveBeenLastCalledWith(pasted)
  })

  it('fails closed when settings cannot load while history failure degrades without blocking dictation', async () => {
    const failedSettingsBridge = createBridge({
      getSettings: vi.fn(async () => Promise.reject(new Error('private settings path'))),
    })
    const failedSettingsController = createControllerFactory()
    mountProvider(failedSettingsBridge, failedSettingsController.factory)
    await waitFor(() => expect(currentContext?.status).toBe('unavailable'))
    expect(currentContext?.failure).toBe('SETTINGS_LOAD_FAILED')
    expect(failedSettingsController.controllers).toHaveLength(0)
    expect(failedSettingsBridge.onDictationCommand).not.toHaveBeenCalled()

    const historyBridge = createBridge({
      listHistory: vi.fn(async () => Promise.reject(new Error('private history path'))),
    })
    const historyController = createControllerFactory()
    mountProvider(historyBridge, historyController.factory)
    await waitFor(() => expect(currentContext?.status).toBe('ready'))
    await waitFor(() => expect(currentContext?.historyStatus).toBe('degraded'))
    expect(currentContext?.history).toEqual([])
    expect(historyController.controllers).toHaveLength(1)
  })

  it('serializes settings and native-managed updates so stale responses cannot overwrite newer commits', async () => {
    const first = deferred<AppSettings>()
    const second = deferred<AppSettings>()
    const updateSettings = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const bridge = createBridge({ updateSettings })
    const harness = createControllerFactory()
    mountProvider(bridge, harness.factory)
    await waitFor(() => expect(currentContext?.status).toBe('ready'))

    let firstUpdate!: Promise<boolean>
    let secondUpdate!: Promise<boolean>
    act(() => {
      firstUpdate = currentContext!.actions.updateSettings({ theme: 'dark' })
      secondUpdate = currentContext!.actions.updateSettings({ theme: 'light' })
    })
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1))
    first.resolve({ ...DEFAULT_SETTINGS, theme: 'dark' })
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2))
    second.resolve({ ...DEFAULT_SETTINGS, theme: 'light' })
    await act(async () => Promise.all([firstUpdate, secondUpdate]))
    expect(currentContext?.settings?.theme).toBe('light')
  })

  it('serializes hotkey, startup, and reset operations around authoritative settings refreshes', async () => {
    const hotkeyRefresh = deferred<AppSettings>()
    const startupRefresh = deferred<AppSettings>()
    const getSettings = vi.fn()
      .mockResolvedValueOnce({ ...DEFAULT_SETTINGS })
      .mockImplementationOnce(() => hotkeyRefresh.promise)
      .mockImplementationOnce(() => startupRefresh.promise)
    const replaceHotkey = vi.fn(async () => OK)
    const setStartup = vi.fn(async (enabled: boolean) => ({ enabled }))
    const resetSettings = vi.fn(async () => ({ ...DEFAULT_SETTINGS }))
    const bridge = createBridge({ getSettings, replaceHotkey, setStartup, resetSettings })
    const harness = createControllerFactory()
    mountProvider(bridge, harness.factory)
    await waitFor(() => expect(currentContext?.status).toBe('ready'))

    let hotkeyResult!: Promise<unknown>
    let startupResult!: Promise<unknown>
    act(() => {
      hotkeyResult = currentContext!.actions.replaceHotkey('Alt+Space')
      startupResult = currentContext!.actions.setStartup(true)
    })
    await waitFor(() => expect(replaceHotkey).toHaveBeenCalledOnce())
    expect(setStartup).not.toHaveBeenCalled()
    hotkeyRefresh.resolve({ ...DEFAULT_SETTINGS, hotkey: 'Alt+Space' })
    await act(async () => hotkeyResult)
    await waitFor(() => expect(setStartup).toHaveBeenCalledOnce())
    startupRefresh.resolve({ ...DEFAULT_SETTINGS, hotkey: 'Alt+Space', launchAtStartup: true })
    await act(async () => startupResult)
    expect(currentContext?.settings).toMatchObject({ hotkey: 'Alt+Space', launchAtStartup: true })

    await act(async () => currentContext!.actions.resetSettings())
    expect(resetSettings).toHaveBeenCalledOnce()
    expect(currentContext?.settings).toEqual(DEFAULT_SETTINGS)
  })

  it('prevents a late initial history response from overwriting controller-added history', async () => {
    const initial = deferred<HistoryEntry[]>()
    const added: HistoryEntry = {
      id: 'new', text: 'new local words', createdAt: 2, durationMs: 20,
      language: 'en', modelPreset: 'balanced',
    }
    const bridge = createBridge({
      listHistory: vi.fn(() => initial.promise),
      addHistory: vi.fn(async () => [added]),
    })
    const harness = createControllerFactory()
    mountProvider(bridge, harness.factory)
    await waitFor(() => expect(harness.bindings).toHaveLength(1))

    await act(async () => harness.bindings[0]!.addHistory(added))
    expect(currentContext?.history).toEqual([added])
    initial.resolve([{ ...added, id: 'old', text: 'old' }])
    await act(async () => initial.promise)
    expect(currentContext?.history).toEqual([added])
  })

  it('serializes controller history adds with clear so an older add cannot repopulate cleared history', async () => {
    const add = deferred<HistoryEntry[]>()
    const added: HistoryEntry = {
      id: 'pending', text: 'pending words', createdAt: 3, durationMs: 30,
      language: 'en', modelPreset: 'balanced',
    }
    const bridge = createBridge({
      addHistory: vi.fn(() => add.promise),
      clearHistory: vi.fn(async () => undefined),
    })
    const harness = createControllerFactory()
    mountProvider(bridge, harness.factory)
    await waitFor(() => expect(harness.bindings).toHaveLength(1))

    let addResult!: Promise<HistoryEntry[]>
    let clearResult!: Promise<boolean>
    act(() => {
      addResult = harness.bindings[0]!.addHistory(added)
      clearResult = currentContext!.actions.clearHistory()
    })
    expect(bridge.clearHistory).not.toHaveBeenCalled()
    add.resolve([added])
    await act(async () => addResult)
    await act(async () => clearResult)
    expect(bridge.clearHistory).toHaveBeenCalledOnce()
    expect(currentContext?.history).toEqual([])
  })

  it('rejects settings actions while the required initial snapshot is still loading', async () => {
    const settings = deferred<AppSettings>()
    const updateSettings = vi.fn(async () => ({ ...DEFAULT_SETTINGS, theme: 'dark' as const }))
    const bridge = createBridge({ getSettings: vi.fn(() => settings.promise), updateSettings })
    const harness = createControllerFactory()
    mountProvider(bridge, harness.factory)

    await expect(currentContext!.actions.updateSettings({ theme: 'dark' })).resolves.toBe(false)
    expect(updateSettings).not.toHaveBeenCalled()
    settings.resolve({ ...DEFAULT_SETTINGS })
    await waitFor(() => expect(currentContext?.status).toBe('ready'))
    expect(harness.controllers).toHaveLength(1)
  })

  it('disposes each controller synchronously and delivers between-mount commands only to the fresh instance', async () => {
    let listener: ((command: DictationCommand) => void) | null = null
    const buffered: DictationCommand[] = []
    const bridge = createBridge({
      onDictationCommand: vi.fn((next) => {
        listener = next
        for (const command of buffered.splice(0)) next(command)
        return () => {
          if (listener === next) listener = null
        }
      }),
    })
    const harness = createControllerFactory()
    const first = mountProvider(bridge, harness.factory)
    await waitFor(() => expect(harness.controllers).toHaveLength(1))
    first.unmount()
    expect(harness.controllers[0]?.dispose).toHaveBeenCalledOnce()
    if (listener === null) buffered.push({ type: 'start' })

    mountProvider(bridge, harness.factory)
    await waitFor(() => expect(harness.controllers).toHaveLength(2))
    expect(harness.controllers[0]?.start).not.toHaveBeenCalled()
    expect(harness.controllers[1]?.start).toHaveBeenCalledOnce()
  })
})

describe('production controller seam', () => {
  it('constructs the recorder, transcription worker client, and sound cue player through injectable factories', async () => {
    const recorder = { start: vi.fn(async () => undefined), stop: vi.fn(async () => null), cancel: vi.fn(async () => undefined) }
    const transcriber = { transcribe: vi.fn(), cancel: vi.fn(), dispose: vi.fn() }
    const cuePlayer = { playStart: vi.fn(), playStop: vi.fn() }
    const createRecorder = vi.fn(() => recorder)
    const bindings: AppControllerFactoryBindings = {
      getSettings: () => ({ ...DEFAULT_SETTINGS }),
      deliverOutput: vi.fn(async (): Promise<'copied'> => 'copied'),
      addHistory: vi.fn(async () => []),
      publishWidgetState: vi.fn(async (): Promise<CommandResult> => OK),
    }
    const controller = createProductionDictationController(bindings, {
      createRecorder,
      createTranscriber: () => transcriber,
      createCuePlayer: () => cuePlayer,
    })

    await controller.start()
    expect(createRecorder).toHaveBeenCalledOnce()
    expect(bindings.publishWidgetState).toHaveBeenCalled()
    controller.dispose()
    expect(transcriber.dispose).toHaveBeenCalledOnce()
  })
})
