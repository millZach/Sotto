import { registerAgentIpc } from '../../src/main/agents/ipc'
import { MICROPHONE_ENSURE_ACCESS, TRANSCRIPT_POLISH, TRANSCRIPTION_CANCEL, TRANSCRIPTION_CHECK_KEY, TRANSCRIPTION_TRANSCRIBE } from '../../src/shared/channels'
// @vitest-environment node
import type { preloadElectron } from '../fixtures/preloadElectron'
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createSystemSettingsOpener } from '../../src/main/app/systemSettings'
import {
  createSottoBridge,
  createSottoWidgetBridge,
  exposeE2EBridge,
  exposeRendererBridge,
  parsePlatformArgument,
  parseRendererRoleArgument,
} from '../../src/preload'
import {
  DICTATION_COMMAND,
  DICTATION_REQUEST,
  EXTERNAL_LINK_OPEN,
  OUTPUT_DELIVER,
  RECOVERY_NOTICE,
  RECOVERY_NOTICE_LIST,
  SETTINGS_CHANGED,
  SETTINGS_UPDATE,
  SYSTEM_SETTINGS_OPEN,
  UPDATE_STATUS,
  WIDGET_DRAG,
  WIDGET_PRESENTATION,
  WIDGET_PUBLISH,
  WIDGET_STATE,
  WIDGET_VISIBILITY
} from '../../src/shared/channels'
import {
  type OutputDeliveryRequest,
  type SottoBridge,
} from '../../src/shared/contracts'
import type { WidgetSnapshot } from '../../src/shared/dictation'
import {
  DEFAULT_SETTINGS,
  type SettingsPatch
} from '../../src/shared/settings'
import { DEFAULT_WIDGET_PALETTE } from '../../src/shared/themeBranding'
import { createIpcHarness, idleWidgetSnapshot } from '../fixtures/ipcHarness'

vi.mock('electron', async () => {
  const mock = (await import('../fixtures/preloadElectron')).preloadElectron()
  mock.ipcRenderer.invoke.mockResolvedValue(undefined)
  return mock
})
const electronMock = await import('electron') as unknown as ReturnType<typeof preloadElectron>

describe('typed preload bridge', () => {
  it('opens only validated web/mail links through the trusted main bridge', async () => {
    const harness = createIpcHarness()
    const bridge = createSottoBridge({
      invoke: (channel, ...args) => harness.ipc.invokeArgs(channel, args),
      on: () => undefined, removeListener: () => undefined,
    }, 'win32')
    try {
      for (const url of ['https://example.com/docs?q=signal#state', 'http://localhost:3000/', 'mailto:hello@example.com?subject=Question']) {
        await expect(bridge.openExternalLink!(url)).resolves.toEqual({ ok: true })
        expect(harness.openExternalLink).toHaveBeenLastCalledWith(url)
      }
      expect(harness.openExternalLink).toHaveBeenCalledTimes(3)
      for (const url of ['javascript:alert(1)', 'file:///C:/Windows/system32/cmd.exe', 'data:text/html,test', 'ms-settings:privacy', '//example.com', 'https://user:secret@example.com', 'https://example.com\n', 'https:\\example.com', 'mailto:', 'https://']) {
        expect(() => bridge.openExternalLink!(url)).toThrow()
        await expect(harness.ipc.invoke(EXTERNAL_LINK_OPEN, url)).rejects.toThrow('Invalid IPC payload')
      }
      expect(harness.openExternalLink).toHaveBeenCalledTimes(3)
      const frame = { parent: null, url: 'file:///C:/Sotto/out/renderer/widget.html' }
      await expect(harness.ipc.invoke(EXTERNAL_LINK_OPEN, 'https://example.com', {
        sender: { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false }, senderFrame: frame,
      })).rejects.toThrow('Unauthorized IPC sender')
      expect(harness.openExternalLink).toHaveBeenCalledTimes(3)
      harness.openExternalLink.mockRejectedValueOnce(new Error('Private OS failure'))
      await expect(bridge.openExternalLink!('https://example.com')).resolves.toEqual({ ok: false, reason: 'unavailable' })
    } finally { harness.cleanup() }
  })

  it('opens only the three macOS privacy panes, and nothing on Windows', async () => {
    const opened: string[] = []
    const darwinOpener = createSystemSettingsOpener('darwin', async url => { opened.push(url) })
    expect(createSystemSettingsOpener('win32', async () => undefined)).toBeNull()
    const harness = createIpcHarness({ openSystemSettings: darwinOpener! })
    const bridge = createSottoBridge({
      invoke: (channel, ...args) => harness.ipc.invokeArgs(channel, args),
      on: () => undefined, removeListener: () => undefined,
    }, 'darwin')
    try {
      for (const pane of ['microphone', 'accessibility', 'automation'] as const) {
        await expect(bridge.openSystemSettings!(pane)).resolves.toEqual({ ok: true })
      }
      expect(opened).toEqual([
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
      ])
      for (const pane of ['camera', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera', '', 'Microphone']) {
        expect(() => bridge.openSystemSettings!(pane as never)).toThrow()
        await expect(harness.ipc.invoke(SYSTEM_SETTINGS_OPEN, pane)).rejects.toThrow('Invalid IPC payload')
      }
      await expect(darwinOpener!('camera' as never)).rejects.toThrow()
      expect(opened).toHaveLength(3)
      const frame = { parent: null, url: 'file:///C:/Sotto/out/renderer/widget.html' }
      await expect(harness.ipc.invoke(SYSTEM_SETTINGS_OPEN, 'microphone', {
        sender: { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false }, senderFrame: frame,
      })).rejects.toThrow('Unauthorized IPC sender')
      expect(opened).toHaveLength(3)
    } finally { harness.cleanup() }

    const windows = createIpcHarness()
    try {
      await expect(windows.ipc.invoke(SYSTEM_SETTINGS_OPEN, 'microphone')).resolves.toEqual({ ok: false, reason: 'unavailable' })
    } finally { windows.cleanup() }
  })

  beforeEach(() => {
    electronMock.ipcRenderer.invoke.mockClear()
    electronMock.ipcRenderer.on.mockClear()
    electronMock.ipcRenderer.removeListener.mockClear()
  })

  it('creates a frozen main-only surface without widget subscriptions or generic IPC', () => {
    const bridge = createSottoBridge(electronMock.ipcRenderer, 'win32')

    expect(Object.keys(bridge).sort()).toEqual(
      [
        'addHistory',
        'agents',
        'browser',
          'cancelTranscription',
        'checkForUpdates',
        'checkTranscriptionKey',
        'ensureMicrophoneAccess',
        'clearHistory',
        'cloudIphone',
        'downloadUpdate',
        'deleteHistory',
        'deliverOutput',
        'files',
        'getHotkey',
        'getSettings',
        'getStartup',
        'getUpdateStatus',
        'getWindowMaximized',
        'gitChanges',
        'hideApp',
        'hosts',
        'installUpdate',
        'listHistory',
        'listRecoveryNotices',
        'memory',
        'minimizeApp',
        'reloadApp',
        'toggleMaximizeApp',
        'onDictationCommand',
        'onRecoveryNotice',
        'onSettingsChanged',
        'onUpdateCheckRequested',
        'onUpdateStatus',
        'onWindowMaximized',
        'onWindowHidden',
        'openExternalLink',
        'openSystemSettings',
        'phones',
        'platform',
        'polishTranscript',
        'publishWidgetState',
        'quitApp',
        'replaceHotkey',
        'requestDictation',
        'requestDrafts',
        'resetSettings',
        'searchHistory',
        'subagents',
        'setStartup',
        'showApp',
        'terminal',
        'terminals',
        'themes',
        'transcribe',
        'updateSettings',
        'visuals',
        'canFrostWindow',
      ].sort(),
    )
    expect(bridge).not.toHaveProperty('send')
    expect(bridge).not.toHaveProperty('invoke')
    expect(bridge).not.toHaveProperty('ipcRenderer')
    expect(bridge).not.toHaveProperty('onWidgetState')
    expect(Object.isFrozen(bridge)).toBe(true)
    expect(Object.isFrozen(bridge.agents)).toBe(true)
    expect(Object.isFrozen(bridge.memory)).toBe(true)
    for (const surface of [bridge.browser, bridge.gitChanges, bridge.subagents, bridge.terminal, bridge.themes]) {
      expect(Object.isFrozen(surface)).toBe(true)
    }
    expect(Object.keys(bridge.memory!).sort()).toEqual(['command', 'get', 'onChanged'])
    expect(Object.keys(bridge.agents!).sort()).toEqual(['attachmentContent', 'attachmentPreview', 'chooseProjectDirectory', 'command', 'get', 'gitChangedFiles', 'gitPullRequest', 'gitRefs', 'hostFolders', 'onState', 'onThreadDetail', 'stageAttachment', 'threadDetail', 'workingCopyOptions'])
  })

  it('creates a frozen widget surface without private settings, dictation history, or audio processing', async () => {
    const bridge = createSottoWidgetBridge(electronMock.ipcRenderer, 'win32')
    expect(Object.keys(bridge).sort()).toEqual(
      [
        'onWidgetState',
        'onWidgetVisibilityChange',
        'platform',
        'reportDrag',
        'requestCancel',
        'requestDismiss',
        'requestRetry',
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
    expect(bridge).not.toHaveProperty('agents')
    expect(electronMock.ipcRenderer.on.mock.calls.map(([channel]) => channel)).not.toContain('sotto:agents:state')

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
    const bridge = createSottoWidgetBridge(electronMock.ipcRenderer, 'win32') as unknown as {
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
      { presentation: 'pill-controls', generation: 4 },
      { presentation: 'threads-expanded', generation: 4 },
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

  it('accepts a single cleanup rule patch and rejects an invalid rule', async () => {
    const { ipc, settings } = createIpcHarness()
    await ipc.invoke(SETTINGS_UPDATE, { worktreeCleanup: { onSettle: true } })
    expect(settings.update).toHaveBeenCalledWith({ worktreeCleanup: { onSettle: true } })
    await expect(ipc.invoke(SETTINGS_UPDATE, { worktreeCleanup: { afterDays: 3 } })).rejects.toThrow('Invalid IPC payload')
    expect(settings.update).toHaveBeenCalledOnce()
  })

  it('accepts only one immutable main-created platform argument and otherwise reports win32', () => {
    expect(parsePlatformArgument(['electron', '--sotto-platform=darwin'])).toBe('darwin')
    expect(parsePlatformArgument(['electron', '--sotto-platform=win32'])).toBe('win32')
    expect(parsePlatformArgument(['electron'])).toBe('win32')
    expect(parsePlatformArgument(['electron', '--sotto-platform=linux'])).toBe('linux')
    expect(parsePlatformArgument([
      'electron',
      '--sotto-platform=darwin',
      '--sotto-platform=win32',
    ])).toBe('win32')
  })

  it('carries the main-declared platform onto both renderer bridges', () => {
    const context = { exposeInMainWorld: vi.fn<(name: string, value: unknown) => void>() }
    exposeRendererBridge(context, electronMock.ipcRenderer, [
      'electron',
      '--sotto-renderer-role=main',
      '--sotto-platform=darwin',
    ])
    exposeRendererBridge(context, electronMock.ipcRenderer, [
      'electron',
      '--sotto-renderer-role=widget',
      '--sotto-platform=darwin',
    ])

    expect(context.exposeInMainWorld).toHaveBeenNthCalledWith(
      1,
      'sotto',
      expect.objectContaining({ platform: 'darwin' }),
    )
    expect(context.exposeInMainWorld).toHaveBeenNthCalledWith(
      2,
      'sottoWidget',
      expect.objectContaining({ platform: 'darwin' }),
    )
  })

  it('exposes exactly the role-appropriate bridge name and attaches only its relevant early buffer', () => {
    const context = { exposeInMainWorld: vi.fn() }
    expect(exposeRendererBridge(
      context,
      electronMock.ipcRenderer,
      ['electron', '--sotto-renderer-role=main'],
    )).toBe(true)
    expect(context.exposeInMainWorld).toHaveBeenCalledWith('sotto', expect.any(Object))
    expect(electronMock.ipcRenderer.on).toHaveBeenCalledTimes(4)
    expect(electronMock.ipcRenderer.on.mock.calls.map(([channel]) => channel).sort()).toEqual(
      [DICTATION_COMMAND, RECOVERY_NOTICE, SETTINGS_CHANGED, UPDATE_STATUS].sort(),
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
    const bridge = createSottoBridge(electronMock.ipcRenderer, 'win32')
    const listener = vi.fn()
    const visibilityListener = vi.fn()
    electronMock.ipcRenderer.invoke.mockResolvedValueOnce({
      ...DEFAULT_SETTINGS,
      theme: 'dark',
    })

    await bridge.updateSettings({ theme: 'dark' })
    const widgetBridge = createSottoWidgetBridge(electronMock.ipcRenderer, 'win32')
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
    const mainBridge = createSottoBridge(electronMock.ipcRenderer, 'win32')
    const widgetBridge = createSottoWidgetBridge(electronMock.ipcRenderer, 'win32')
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
      theme: 'system', palette: DEFAULT_WIDGET_PALETTE, reducedMotion: 'system', shortcut: 'Primary', cancellable: true,
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
    const bridge = createSottoBridge(electronMock.ipcRenderer, 'win32')
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
    const bridge = createSottoBridge(electronMock.ipcRenderer, 'win32')
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
    const bridge = createSottoBridge(electronMock.ipcRenderer, 'win32')
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

})

it('leaves retired voice channels unregistered while keeping dictation IPC available', async () => {
    const harness = createIpcHarness()
    const removeAgents = registerAgentIpc(harness.ipc, {
      get: vi.fn(), shell: vi.fn(), threadDetail: () => null, attachmentPreview: () => null,
    }, { command: vi.fn() }, () => [{ role: 'main', webContents: harness.trustedContents, url: harness.trustedUrl }], { encodeReceipt: vi.fn() })
    try {
      for (const channel of ['sotto:agents:speech', 'sotto:agents:speech-cancel', 'sotto:agents:grok-voices', 'sotto:agents:voice-model', 'sotto:agents:wake']) {
        expect(harness.ipc.handlers.has(channel)).toBe(false)
        await expect(harness.ipc.invoke(channel)).rejects.toThrow(`missing handler: ${channel}`)
      }
      for (const channel of [DICTATION_REQUEST, TRANSCRIPTION_TRANSCRIBE, TRANSCRIPTION_CANCEL, TRANSCRIPTION_CHECK_KEY, MICROPHONE_ENSURE_ACCESS, TRANSCRIPT_POLISH, OUTPUT_DELIVER, WIDGET_PUBLISH, WIDGET_PRESENTATION, WIDGET_DRAG]) {
        expect(harness.ipc.handlers.has(channel)).toBe(true)
      }
    } finally { removeAgents(); harness.cleanup() }
  })
