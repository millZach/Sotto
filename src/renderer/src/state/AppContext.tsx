import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import type {
  HotkeyChangeResult,
  ModelDisclosureCatalog,
  ModelInstallRequest,
  ModelStatus,
  RemoteAsrHealth,
  StartupState,
  SottoBridge,
  TranscriptPolishAsrContext,
  UnavailableResult,
  UpdateStatus,
} from '../../../shared/contracts'
import { initialDictationState, type DictationState, type WidgetSnapshot } from '../../../shared/dictation'
import type { HistoryEntry } from '../../../shared/history'
import type { SottoPlatform } from '../../../shared/platform'
import type { AppSettings, ModelPreset, SettingsPatch } from '../../../shared/settings'
import type { RecoveryNotice } from '../../../shared/recoveryNotice'
import { AudioRecorder, type AudioRecorderOptions } from '../audio/audioRecorder'
import { SoundCuePlayer } from '../audio/soundCues'
import {
  DictationController,
  type DictationControllerDependencies,
  type DictationCuePlayer,
  type DictationRecorder,
  type DictationTranscriber,
} from '../features/dictation/dictationController'
import { platformCopy, type PlatformCopy } from '../platformCopy'
import { updatePromptKey } from '../features/updates/updatePrompt'
import { TranscriptionClient } from '../transcription/client'
import { FallbackTranscriber } from '../transcription/fallbackTranscriber'
import {
  RemoteTranscriptionClient,
  type RemoteTranscriptionBridge,
} from '../transcription/remoteClient'

export type AppStatus = 'loading' | 'ready' | 'unavailable'
export type HistoryStatus = 'loading' | 'ready' | 'degraded'
export type AppNavigation = 'onboarding' | 'home' | 'history' | 'settings' | 'help'
export type AppFailureCode =
  | 'SETTINGS_LOAD_FAILED'
  | 'SETTINGS_UPDATE_FAILED'
  | 'HISTORY_LOAD_FAILED'
  | 'HISTORY_UPDATE_FAILED'
  | 'HOTKEY_UPDATE_FAILED'
  | 'STARTUP_UPDATE_FAILED'
  | 'MODEL_OPERATION_FAILED'
  | 'APP_ACTION_FAILED'

export interface AppController {
  getState(): DictationState
  start(): Promise<void>
  stop(): Promise<void>
  toggle(): Promise<void>
  cancel(): Promise<void>
  prewarm?(): Promise<void>
  dispose(): void
}

export interface AppControllerFactoryBindings {
  readonly getSettings: () => AppSettings
  readonly deliverOutput: SottoBridge['deliverOutput']
  readonly addHistory: SottoBridge['addHistory']
  readonly publishWidgetState: (snapshot: WidgetSnapshot) => ReturnType<SottoBridge['publishWidgetState']>
  readonly polishTranscript?: SottoBridge['polishTranscript']
  /** Present only when the preload bridge exposes the remote ASR channels. */
  readonly remoteAsr?: RemoteTranscriptionBridge
  readonly platform?: SottoPlatform
}

export type AppControllerFactory = (
  bindings: AppControllerFactoryBindings,
) => AppController

export interface ProductionControllerFactories {
  readonly createRecorder: (options: AudioRecorderOptions) => DictationRecorder
  readonly createTranscriber: (bindings: AppControllerFactoryBindings) => DictationTranscriber
  readonly createCuePlayer: () => DictationCuePlayer
}

/**
 * The local worker client is the transcriber unless the bridge offers the
 * remote channels, in which case it becomes the fallback behind them. Reading
 * the toggle through getSettings keeps a mid-session change effective without
 * rebuilding the controller.
 */
function createProductionTranscriber(
  bindings: AppControllerFactoryBindings,
): DictationTranscriber {
  const local = new TranscriptionClient()
  const remoteBridge = bindings.remoteAsr
  if (remoteBridge === undefined) return local
  return new FallbackTranscriber({
    local,
    remote: new RemoteTranscriptionClient({ bridge: remoteBridge }),
    isRemoteEnabled: () => {
      try {
        const settings = bindings.getSettings()
        return settings.remoteAsr && settings.remoteAsrUrl.trim().length > 0
      } catch {
        return false
      }
    },
  })
}

const productionFactories: ProductionControllerFactories = {
  createRecorder: (options) => new AudioRecorder(options),
  createTranscriber: createProductionTranscriber,
  createCuePlayer: () => new SoundCuePlayer(),
}

export function createProductionDictationController(
  bindings: AppControllerFactoryBindings,
  factories: ProductionControllerFactories = productionFactories,
): AppController {
  const polish = bindings.polishTranscript
  const platform = bindings.platform
  const dependencies: DictationControllerDependencies = {
    createRecorder: factories.createRecorder,
    transcriber: factories.createTranscriber(bindings),
    cuePlayer: factories.createCuePlayer(),
    getSettings: bindings.getSettings,
    deliverOutput: bindings.deliverOutput,
    addHistory: bindings.addHistory,
    publishWidgetState: bindings.publishWidgetState,
    ...(platform === undefined ? {} : { platform }),
    ...(polish === undefined
      ? {}
      : {
          polishTranscript: (text: string, asr?: TranscriptPolishAsrContext) =>
            polish({ text, ...(asr === undefined ? {} : { asr }) }),
        }),
  }
  return new DictationController(dependencies)
}

export interface AppActions {
  start(): Promise<void>
  stop(): Promise<void>
  toggle(): Promise<void>
  cancel(): Promise<void>
  navigate(destination: AppNavigation): void
  updateSettings(patch: SettingsPatch): Promise<boolean>
  resetSettings(): Promise<boolean>
  replaceHotkey(accelerator: string): Promise<HotkeyChangeResult>
  setStartup(enabled: boolean): Promise<StartupState | null>
  listHistory(): Promise<boolean>
  searchHistory(query: string): Promise<boolean>
  deleteHistory(id: string): Promise<boolean>
  clearHistory(): Promise<boolean>
  copyHistory(text: string): Promise<boolean>
  getModelStatus(preset: ModelPreset): Promise<ModelStatus | UnavailableResult>
  listModelDisclosures(): Promise<ModelDisclosureCatalog | UnavailableResult>
  installModel(request: ModelInstallRequest): ReturnType<SottoBridge['installModel']>
  removeModel(preset: ModelPreset): ReturnType<SottoBridge['removeModel']>
  checkRemoteAsr(): Promise<RemoteAsrHealth>
  checkForUpdates(): Promise<UpdateStatus | null>
  downloadUpdate(): Promise<boolean>
  installUpdate(): Promise<boolean>
  dismissUpdate(): void
  showApp(): Promise<void>
  hideApp(): Promise<void>
  minimizeApp(): Promise<void>
  quitApp(): Promise<void>
}

export interface AppContextValue {
  readonly platform: SottoPlatform
  readonly copy: PlatformCopy
  readonly status: AppStatus
  readonly historyStatus: HistoryStatus
  readonly failure: AppFailureCode | null
  readonly settings: AppSettings | null
  readonly history: readonly HistoryEntry[]
  readonly modelStatuses: Readonly<Partial<Record<ModelPreset, ModelStatus>>>
  readonly dictation: DictationState
  readonly navigation: AppNavigation
  readonly recoveryNotices: readonly RecoveryNotice[]
  /** Null until the main process answers, and on any build without a feed. */
  readonly update: UpdateStatus | null
  /** Prompt keys the user waved away for the rest of this session. */
  readonly dismissedUpdates: readonly string[]
  readonly actions: AppActions
}

const AppContext = createContext<AppContextValue | null>(null)
const UNAVAILABLE = Object.freeze({ ok: false as const, reason: 'unavailable' as const })

export interface AppProviderProps {
  readonly children?: ReactNode
  readonly bridge?: SottoBridge | undefined
  readonly createController?: AppControllerFactory | undefined
}

function invokeController(
  controller: AppController | null,
  operation: (controller: AppController) => Promise<void>,
): Promise<void> {
  if (controller === null) return Promise.resolve()
  try {
    return operation(controller).catch(() => undefined)
  } catch {
    return Promise.resolve()
  }
}

export function AppProvider({
  children,
  bridge = window.sotto,
  createController = createProductionDictationController,
}: AppProviderProps): ReactNode {
  const [status, setStatus] = useState<AppStatus>('loading')
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>('loading')
  const [failure, setFailure] = useState<AppFailureCode | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [history, setHistory] = useState<readonly HistoryEntry[]>([])
  const [modelStatuses, setModelStatuses] = useState<Partial<Record<ModelPreset, ModelStatus>>>({})
  const [dictation, setDictation] = useState<DictationState>(initialDictationState)
  const [navigation, setNavigation] = useState<AppNavigation>('onboarding')
  const [recoveryNotices, setRecoveryNotices] = useState<readonly RecoveryNotice[]>([])
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [dismissedUpdates, setDismissedUpdates] = useState<readonly string[]>([])

  // The main process resolved the platform once and carried it across the
  // bridge; an absent bridge is already the unavailable path, so it reads as
  // the Windows row rather than blocking the view.
  const platform: SottoPlatform = bridge?.platform ?? 'win32'
  const copy = platformCopy(platform)

  const settingsRef = useRef<AppSettings | null>(null)
  const updateRef = useRef<UpdateStatus | null>(null)
  const controllerRef = useRef<AppController | null>(null)
  const lifecycleGenerationRef = useRef(0)
  const activeGenerationRef = useRef(0)
  const settingsVersionRef = useRef(0)
  const historyVersionRef = useRef(0)
  const modelStatusVersionRef = useRef<Partial<Record<ModelPreset, number>>>({})
  const settingsTailRef = useRef<Promise<void>>(Promise.resolve())
  const historyTailRef = useRef<Promise<void>>(Promise.resolve())

  const commitRecoveryNotice = useCallback((notice: RecoveryNotice): void => {
    setRecoveryNotices((current) =>
      current.some((candidate) => candidate.code === notice.code)
        ? current
        : [...current, notice],
    )
  }, [])

  const commitUpdate = useCallback((next: UpdateStatus): void => {

    updateRef.current = next
    setUpdate(next)
  }, [])

  const isCurrentGeneration = useCallback(
    (generation: number): boolean => activeGenerationRef.current === generation,
    [],
  )

  const commitSettings = useCallback((next: AppSettings): void => {
    const previous = settingsRef.current
    settingsRef.current = next
    setSettings(next)
    if (
      previous !== null &&
      (previous.modelPreset !== next.modelPreset ||
        previous.inferencePreference !== next.inferencePreference)
    ) {
      void invokeController(controllerRef.current, (controller) =>
        controller.prewarm?.() ?? Promise.resolve(),
      )
    }
  }, [])

  const enqueueSettings = useCallback(
    (
      operation: () => Promise<AppSettings>,
      failureCode: AppFailureCode,
    ): Promise<boolean> => {
      if (activeGenerationRef.current === 0 || settingsRef.current === null) {
        return Promise.resolve(false)
      }
      const generation = activeGenerationRef.current
      const queued = settingsTailRef.current.then(async () => {
        const version = ++settingsVersionRef.current
        return { next: await operation(), version }
      })
      settingsTailRef.current = queued.then(() => undefined, () => undefined)
      return queued.then(
        ({ next, version }) => {
          if (!isCurrentGeneration(generation)) return false
          if (settingsVersionRef.current === version) commitSettings(next)
          setFailure(null)
          return true
        },
        () => {
          if (isCurrentGeneration(generation)) {
            setFailure(failureCode)
          }
          return false
        },
      )
    },
    [commitSettings, isCurrentGeneration],
  )

  const commitHistory = useCallback((entries: readonly HistoryEntry[]): void => {
    setHistory(entries)
    setHistoryStatus('ready')
  }, [])

  const enqueueHistoryMutation = useCallback(
    (operation: () => Promise<HistoryEntry[]>): Promise<boolean> => {
      const generation = activeGenerationRef.current
      const version = ++historyVersionRef.current
      const queued = historyTailRef.current.then(operation)
      historyTailRef.current = queued.then(() => undefined, () => undefined)
      return queued.then(
        (entries) => {
          if (!isCurrentGeneration(generation) || version !== historyVersionRef.current) {
            return false
          }
          commitHistory(entries)
          return true
        },
        () => {
          if (isCurrentGeneration(generation) && version === historyVersionRef.current) {
            setFailure('HISTORY_UPDATE_FAILED')
            setHistoryStatus('degraded')
          }
          return false
        },
      )
    },
    [commitHistory, isCurrentGeneration],
  )

  useEffect(() => {
    const generation = ++lifecycleGenerationRef.current
    activeGenerationRef.current = generation
    let localController: AppController | null = null
    let unsubscribeCommands: (() => void) | null = null
    let unsubscribeModelStatus: (() => void) | null = null
    let unsubscribeSettings: (() => void) | null = null
    let unsubscribeRecoveryNotices: (() => void) | null = null
    let unsubscribeUpdateStatus: (() => void) | null = null
    setStatus('loading')
    setHistoryStatus('loading')
    setFailure(null)
    setSettings(null)
    settingsRef.current = null
    setHistory([])
    setModelStatuses({})
    modelStatusVersionRef.current = {}
    setDictation(initialDictationState)
    setRecoveryNotices([])
    setUpdate(null)
    updateRef.current = null
    setDismissedUpdates([])

    if (bridge === undefined) {
      setStatus('unavailable')
      setHistoryStatus('degraded')
      setFailure('SETTINGS_LOAD_FAILED')
      return () => {
        if (activeGenerationRef.current === generation) activeGenerationRef.current = 0
      }
    }

    const initialHistoryVersion = ++historyVersionRef.current
    try {
      unsubscribeRecoveryNotices = bridge.onRecoveryNotice((notice) => {
        if (isCurrentGeneration(generation)) commitRecoveryNotice(notice)
      })
    } catch {
      // Retained notices remain available through the explicit snapshot below.
    }
    void bridge.listRecoveryNotices().then(
      (notices) => {
        if (!isCurrentGeneration(generation)) return
        for (const notice of notices) commitRecoveryNotice(notice)
      },
      () => undefined,
    )
    try {
      unsubscribeUpdateStatus = bridge.onUpdateStatus((updateStatus) => {
        if (isCurrentGeneration(generation)) commitUpdate(updateStatus)
      })
    } catch {
      // Updating is optional everywhere; a feed that cannot be watched stays quiet.
    }
    void bridge.getUpdateStatus().then(
      (result) => {
        if (isCurrentGeneration(generation) && 'currentVersion' in result) commitUpdate(result)
      },
      () => undefined,
    )
    try {
      unsubscribeModelStatus = bridge.onModelStatus((modelStatus) => {
        if (!isCurrentGeneration(generation)) return
        modelStatusVersionRef.current[modelStatus.preset] =
          (modelStatusVersionRef.current[modelStatus.preset] ?? 0) + 1
        setModelStatuses((current) => ({ ...current, [modelStatus.preset]: modelStatus }))
      })
    } catch {
      // Model progress is observational; explicit status requests remain available.
    }
    void bridge.listHistory().then(
      (entries) => {
        if (
          isCurrentGeneration(generation) &&
          historyVersionRef.current === initialHistoryVersion
        ) {
          commitHistory(entries)
        }
      },
      () => {
        if (
          isCurrentGeneration(generation) &&
          historyVersionRef.current === initialHistoryVersion
        ) {
          setHistory([])
          setHistoryStatus('degraded')
          setFailure('HISTORY_LOAD_FAILED')
        }
      },
    )

    const initialSettingsVersion = ++settingsVersionRef.current
    void bridge.getSettings().then(
      (loadedSettings) => {
        if (
          !isCurrentGeneration(generation) ||
          settingsVersionRef.current !== initialSettingsVersion
        ) {
          return
        }
        commitSettings(loadedSettings)
        setNavigation(loadedSettings.onboardingComplete ? 'home' : 'onboarding')

        let controller!: AppController
        const bindings: AppControllerFactoryBindings = {
          platform,
          getSettings: () => {
            const current = settingsRef.current
            if (current === null) throw new Error('SETTINGS_UNAVAILABLE')
            return current
          },
          deliverOutput: (request) => bridge.deliverOutput(request),
          polishTranscript: (request) => bridge.polishTranscript(request),
          remoteAsr: {
            transcribeRemote: (request) => bridge.transcribeRemote(request),
            cancelRemoteTranscription: (requestId) =>
              bridge.cancelRemoteTranscription(requestId),
            checkRemoteAsr: () => bridge.checkRemoteAsr(),
          },
          addHistory: async (entry) => {
            const version = ++historyVersionRef.current
            const request = historyTailRef.current.then(() => bridge.addHistory(entry))
            historyTailRef.current = request.then(() => undefined, () => undefined)
            let entries: HistoryEntry[]
            try {
              entries = await request
            } catch (error: unknown) {
              if (isCurrentGeneration(generation) && historyVersionRef.current === version) {
                setHistoryStatus('degraded')
                setFailure('HISTORY_UPDATE_FAILED')
              }
              throw error
            }
            if (isCurrentGeneration(generation) && historyVersionRef.current === version) {
              commitHistory(entries)
            }
            return entries
          },
          publishWidgetState: async (snapshot) => {
            if (!isCurrentGeneration(generation) || localController !== controller) {
              return UNAVAILABLE
            }
            setDictation(controller.getState())
            return bridge.publishWidgetState(snapshot)
          },
        }

        try {
          controller = createController(bindings)
          localController = controller
          controllerRef.current = controller
          unsubscribeSettings = bridge.onSettingsChanged((authoritativeSettings) => {
            if (!isCurrentGeneration(generation) || localController !== controller) return
            ++settingsVersionRef.current
            commitSettings(authoritativeSettings)
          })
          unsubscribeCommands = bridge.onDictationCommand((command) => {
            if (!isCurrentGeneration(generation) || localController !== controller) return
            switch (command.type) {
              case 'toggle': void invokeController(controller, (value) => value.toggle()); break
              case 'start': void invokeController(controller, (value) => value.start()); break
              case 'stop': void invokeController(controller, (value) => value.stop()); break
              case 'cancel': void invokeController(controller, (value) => value.cancel()); break
            }
          })
          setDictation(controller.getState())
          setStatus('ready')
          void invokeController(controller, (value) => value.prewarm?.() ?? Promise.resolve())
        } catch {
          try { unsubscribeSettings?.() } catch { /* listener is already unreachable */ }
          unsubscribeSettings = null
          try { unsubscribeCommands?.() } catch { /* listener is already unreachable */ }
          unsubscribeCommands = null
          localController?.dispose()
          localController = null
          controllerRef.current = null
          setStatus('unavailable')
          setFailure('SETTINGS_LOAD_FAILED')
        }
      },
      () => {
        if (
          isCurrentGeneration(generation) &&
          settingsVersionRef.current === initialSettingsVersion
        ) {
          setStatus('unavailable')
          setFailure('SETTINGS_LOAD_FAILED')
        }
      },
    )

    return () => {
      if (activeGenerationRef.current === generation) activeGenerationRef.current = 0
      try { unsubscribeCommands?.() } catch { /* listener is already unreachable */ }
      unsubscribeCommands = null
      try { unsubscribeSettings?.() } catch { /* listener is already unreachable */ }
      unsubscribeSettings = null
      try { unsubscribeModelStatus?.() } catch { /* listener is already unreachable */ }
      unsubscribeModelStatus = null
      try { unsubscribeRecoveryNotices?.() } catch { /* listener is already unreachable */ }
      unsubscribeRecoveryNotices = null
      try { unsubscribeUpdateStatus?.() } catch { /* listener is already unreachable */ }
      unsubscribeUpdateStatus = null
      if (controllerRef.current === localController) controllerRef.current = null
      try { localController?.dispose() } catch { /* resources are independently guarded */ }
      localController = null
    }
  }, [bridge, commitHistory, commitRecoveryNotice, commitSettings, commitUpdate, createController, isCurrentGeneration])

  const actions = useMemo<AppActions>(() => ({
    start: () => invokeController(controllerRef.current, (controller) => controller.start()),
    stop: () => invokeController(controllerRef.current, (controller) => controller.stop()),
    toggle: () => invokeController(controllerRef.current, (controller) => controller.toggle()),
    cancel: () => invokeController(controllerRef.current, (controller) => controller.cancel()),
    navigate: setNavigation,
    updateSettings: (patch) => bridge === undefined
      ? Promise.resolve(false)
      : enqueueSettings(() => bridge.updateSettings(patch), 'SETTINGS_UPDATE_FAILED'),
    resetSettings: () => bridge === undefined
      ? Promise.resolve(false)
      : enqueueSettings(() => bridge.resetSettings(), 'SETTINGS_UPDATE_FAILED'),
    replaceHotkey: async (accelerator) => {
      if (bridge === undefined) return UNAVAILABLE
      let result: HotkeyChangeResult = UNAVAILABLE
      await enqueueSettings(async () => {
        result = await bridge.replaceHotkey(accelerator)
        if (!result.ok) throw new Error('HOTKEY_UPDATE_FAILED')
        return bridge.getSettings()
      }, 'HOTKEY_UPDATE_FAILED')
      return result
    },
    setStartup: async (enabled) => {
      if (bridge === undefined) return null
      let result: StartupState | null = null
      await enqueueSettings(async () => {
        result = await bridge.setStartup(enabled)
        return bridge.getSettings()
      }, 'STARTUP_UPDATE_FAILED')
      return result
    },
    listHistory: () => bridge === undefined
      ? Promise.resolve(false)
      : enqueueHistoryMutation(() => bridge.listHistory()),
    searchHistory: (query) => bridge === undefined
      ? Promise.resolve(false)
      : enqueueHistoryMutation(() => bridge.searchHistory(query)),
    deleteHistory: async (id) => {
      if (bridge === undefined) return false
      return enqueueHistoryMutation(async () => {
        await bridge.deleteHistory(id)
        return bridge.listHistory()
      })
    },
    clearHistory: async () => {
      if (bridge === undefined) return false
      return enqueueHistoryMutation(async () => {
        await bridge.clearHistory()
        return []
      })
    },
    copyHistory: async (text) => {
      if (bridge === undefined || activeGenerationRef.current === 0) return false
      const current = settingsRef.current
      if (current === null || text.trim().length === 0) return false
      const generation = activeGenerationRef.current
      try {
        const result = await bridge.deliverOutput({
          text,
          autoPaste: false,
          pasteDelayMs: current.pasteDelayMs,
        })
        if (!isCurrentGeneration(generation)) return false
        if (result === 'copied') {
          setFailure(null)
          return true
        }
        setFailure('APP_ACTION_FAILED')
        return false
      } catch {
        if (isCurrentGeneration(generation)) setFailure('APP_ACTION_FAILED')
        return false
      }
    },
    getModelStatus: async (preset) => {
      if (bridge === undefined) return UNAVAILABLE
      const generation = activeGenerationRef.current
      const version = (modelStatusVersionRef.current[preset] ?? 0) + 1
      modelStatusVersionRef.current[preset] = version
      try {
        const result = await bridge.getModelStatus(preset)
        if (
          'preset' in result &&
          isCurrentGeneration(generation) &&
          modelStatusVersionRef.current[preset] === version
        ) {
          setModelStatuses((current) => ({ ...current, [result.preset]: result }))
        }
        return result
      } catch {
        if (isCurrentGeneration(generation)) setFailure('MODEL_OPERATION_FAILED')
        return UNAVAILABLE
      }
    },
    listModelDisclosures: async () => {
      if (bridge === undefined) return UNAVAILABLE
      const generation = activeGenerationRef.current
      try { return await bridge.listModelDisclosures() } catch {
        if (isCurrentGeneration(generation)) setFailure('MODEL_OPERATION_FAILED')
        return UNAVAILABLE
      }
    },
    installModel: async (request) => {
      if (bridge === undefined) return UNAVAILABLE
      const generation = activeGenerationRef.current
      try { return await bridge.installModel(request) } catch {
        if (isCurrentGeneration(generation)) setFailure('MODEL_OPERATION_FAILED')
        return UNAVAILABLE
      }
    },
    removeModel: async (preset) => {
      if (bridge === undefined) return UNAVAILABLE
      const generation = activeGenerationRef.current
      try { return await bridge.removeModel(preset) } catch {
        if (isCurrentGeneration(generation)) setFailure('MODEL_OPERATION_FAILED')
        return UNAVAILABLE
      }
    },
    checkRemoteAsr: async () => {
      if (bridge === undefined) return { ok: false, reason: 'unconfigured' }
      try { return await bridge.checkRemoteAsr() } catch { return { ok: false, reason: 'network' } }
    },
    // Nothing about updating may raise a failure banner: an update that cannot
    // be reached is simply an update the user hears nothing about.
    checkForUpdates: async () => {
      if (bridge === undefined) return null
      const generation = activeGenerationRef.current
      try {
        const result = await bridge.checkForUpdates()
        if (!('currentVersion' in result)) return null
        if (isCurrentGeneration(generation)) commitUpdate(result)
        return result
      } catch {
        return null
      }
    },
    downloadUpdate: async () => {
      if (bridge === undefined) return false
      try { return (await bridge.downloadUpdate()).ok } catch { return false }
    },
    installUpdate: async () => {
      if (bridge === undefined) return false
      try { return (await bridge.installUpdate()).ok } catch { return false }
    },
    dismissUpdate: () => {
      const key = updatePromptKey(updateRef.current)
      if (key === null) return
      setDismissedUpdates((current) => (current.includes(key) ? current : [...current, key]))
    },
    showApp: async () => {
      const generation = activeGenerationRef.current
      try { await bridge?.showApp() } catch {
        if (isCurrentGeneration(generation)) setFailure('APP_ACTION_FAILED')
      }
    },
    hideApp: async () => {
      const generation = activeGenerationRef.current
      try { await bridge?.hideApp() } catch {
        if (isCurrentGeneration(generation)) setFailure('APP_ACTION_FAILED')
      }
    },
    minimizeApp: async () => {
      const generation = activeGenerationRef.current
      try { await bridge?.minimizeApp() } catch {
        if (isCurrentGeneration(generation)) setFailure('APP_ACTION_FAILED')
      }
    },
    quitApp: async () => {
      const generation = activeGenerationRef.current
      try { await bridge?.quitApp() } catch {
        if (isCurrentGeneration(generation)) setFailure('APP_ACTION_FAILED')
      }
    },
  }), [bridge, commitUpdate, enqueueHistoryMutation, enqueueSettings, isCurrentGeneration])

  const value = useMemo<AppContextValue>(() => ({
    platform,
    copy,
    status,
    historyStatus,
    failure,
    settings,
    history,
    modelStatuses,
    dictation,
    navigation,
    recoveryNotices,
    update,
    dismissedUpdates,
    actions,
  }), [actions, copy, dictation, dismissedUpdates, failure, history, historyStatus, modelStatuses, navigation, platform, recoveryNotices, settings, status, update])

  return createElement(AppContext.Provider, { value }, children)
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (value === null) throw new Error('AppProvider is required')
  return value
}
