import React, { StrictMode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { App, applyDocumentPreferences } from '../../../src/renderer/src/App'
import type { MicrophoneTestController } from '../../../src/renderer/src/features/onboarding/microphoneTest'
import {
  AppProvider,
  type AppControllerFactory,
} from '../../../src/renderer/src/state/AppContext'
import {
  MODEL_DOWNLOAD_PRIVACY_NOTICE,
  type ModelDisclosureCatalog,
  type TalkTypeBridge,
} from '../../../src/shared/contracts'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'

const OK = Object.freeze({ ok: true as const })
const DISCLOSURES: ModelDisclosureCatalog = Object.freeze({
  models: Object.freeze([
    Object.freeze({
      preset: 'fast' as const,
      repository: 'Xenova/whisper-tiny',
      sourceProvider: 'Hugging Face' as const,
      sourceHost: 'huggingface.co' as const,
      revision: '5332fcc35e32a33b86612b9a57a89be7906102b1',
      totalBytes: 42_000_000,
      license: 'Apache-2.0' as const,
      bundled: false,
    }),
    Object.freeze({
      preset: 'balanced' as const,
      repository: 'Xenova/whisper-base',
      sourceProvider: 'Hugging Face' as const,
      sourceHost: 'huggingface.co' as const,
      revision: '64da57285918e20ea79ea5c88eed7197933abaa8',
      totalBytes: 82_000_000,
      license: 'Apache-2.0' as const,
      bundled: true,
    }),
    Object.freeze({
      preset: 'accurate' as const,
      repository: 'Xenova/whisper-small',
      sourceProvider: 'Hugging Face' as const,
      sourceHost: 'huggingface.co' as const,
      revision: '2d67713f236afa48a18992566e7647f6ca848e13',
      totalBytes: 125_000_000,
      license: 'Apache-2.0' as const,
      bundled: false,
    }),
  ]),
  optionalDownloadNotice: MODEL_DOWNLOAD_PRIVACY_NOTICE,
})

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail })
  return { promise, reject, resolve }
}

function createBridge(overrides: Partial<TalkTypeBridge> = {}): TalkTypeBridge {
  return {
    listRecoveryNotices: vi.fn(async () => []),
    onRecoveryNotice: vi.fn(() => () => undefined),
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
    onSettingsChanged: vi.fn(() => () => undefined),
    publishWidgetState: vi.fn(async () => OK),
    getModelStatus: vi.fn(async (preset) => ({ preset, state: 'bundled' as const })),
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

const createController: AppControllerFactory = () => ({
  getState: () => ({ status: 'idle' }),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  toggle: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
  dispose: vi.fn(),
})

function renderApp(
  bridge: TalkTypeBridge,
  createMicrophoneTest: () => MicrophoneTestController = () => ({
    start: vi.fn(async () => 'ready' as const),
    stop: vi.fn(async () => undefined),
  }),
  strict = false,
) {
  const content = (
    <AppProvider bridge={bridge} createController={createController}>
      <App createMicrophoneTest={createMicrophoneTest} />
    </AppProvider>
  )
  return render(strict ? <StrictMode>{content}</StrictMode> : content)
}

async function reachMicrophoneStep(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await waitFor(() => expect(screen.getByRole('heading', { name: /private dictation/i })).toBeVisible())
  await user.click(screen.getByRole('button', { name: /continue/i }))
}

async function completeReadySetup(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await reachMicrophoneStep(user)
  await user.click(screen.getByRole('button', { name: /test microphone/i }))
  await waitFor(() => expect(screen.getByText(/microphone ready/i)).toBeVisible())
  await user.click(screen.getByRole('button', { name: /continue/i }))
  await waitFor(() => expect(screen.getByText(/balanced model is included and ready/i)).toBeVisible())
  await user.click(screen.getByRole('button', { name: /continue/i }))
  await user.click(screen.getByRole('button', { name: /finish setup/i }))
}

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.reducedMotion
})

describe('shared main-window frame', () => {
  it.each([
    {
      name: 'loading',
      createStateBridge: () => createBridge({
        getSettings: vi.fn(() => new Promise<AppSettings>(() => undefined)),
      }),
      stateText: /preparing talktype/i,
    },
    {
      name: 'unavailable',
      createStateBridge: () => createBridge({
        getSettings: vi.fn(async () => { throw new Error('startup failed') }),
      }),
      stateText: /could not finish starting/i,
    },
    {
      name: 'onboarding',
      createStateBridge: () => createBridge(),
      stateText: /private dictation/i,
    },
    {
      name: 'ready',
      createStateBridge: () => createBridge({
        getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      }),
      stateText: 'Home',
    },
  ])('renders exactly one titlebar and both controls in the $name state', async ({
    createStateBridge,
    stateText,
  }) => {
    const { container } = renderApp(createStateBridge())

    await waitFor(() => expect(document.body).toHaveTextContent(stateText))

    expect(container.querySelectorAll('.app-titlebar')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Minimize TalkType' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Close TalkType to tray' })).toBeVisible()
  })
})

describe('TalkType application onboarding integration', () => {
  it('shows deduplicated non-blocking recovery notices without paths or transcript content', async () => {
    let recoveryListener: ((notice: { code: 'SETTINGS_RECOVERED' | 'HISTORY_RECOVERED' }) => void) | undefined
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      listRecoveryNotices: vi.fn(async () => [
        { code: 'SETTINGS_RECOVERED' },
        { code: 'HISTORY_RECOVERED' },
      ]),
      onRecoveryNotice: vi.fn((listener) => {
        recoveryListener = listener
        return () => undefined
      }),
    })
    renderApp(bridge)
    act(() => recoveryListener?.({ code: 'SETTINGS_RECOVERED' }))

    await waitFor(() => expect(screen.getAllByRole('status').filter((node) =>
      node.classList.contains('tt-toast'),
    )).toHaveLength(2))
    expect(screen.getByText(/restored default settings/i)).toBeVisible()
    expect(screen.getByText(/started with an empty history/i)).toBeVisible()
    expect(document.body).not.toHaveTextContent('C:\\private\\settings.json')
    expect(document.body).not.toHaveTextContent('private transcript content')
    expect(screen.getByRole('heading', { name: /ready when you are/i })).toBeVisible()
  })

  it('renders loading and a finite recovery state when settings cannot load', async () => {
    const settings = deferred<AppSettings>()
    const bridge = createBridge({ getSettings: vi.fn(() => settings.promise) })
    renderApp(bridge)
    expect(screen.getByRole('status')).toHaveTextContent(/preparing talktype/i)

    settings.reject(new Error('private storage detail'))
    await waitFor(() => expect(screen.getByRole('heading', { name: /could not finish starting/i })).toBeVisible())
    expect(document.body).not.toHaveTextContent('private storage detail')
  })

  it('shows first-run onboarding and applies forced theme and motion preferences', async () => {
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({
        ...DEFAULT_SETTINGS,
        theme: 'dark' as const,
        reducedMotion: 'on' as const,
      })),
    })
    renderApp(bridge)

    await waitFor(() => expect(screen.getByRole('heading', { name: /private dictation/i })).toBeVisible())
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.reducedMotion).toBe('on')
  })

  it('removes forced root attributes when following system preferences', () => {
    document.documentElement.dataset.theme = 'dark'
    document.documentElement.dataset.reducedMotion = 'on'
    applyDocumentPreferences({ ...DEFAULT_SETTINGS, theme: 'system', reducedMotion: 'system' })
    expect(document.documentElement).not.toHaveAttribute('data-theme')
    expect(document.documentElement).not.toHaveAttribute('data-reduced-motion')
  })

  it('shows the complete management dashboard after onboarding is already complete', async () => {
    renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
    }))

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible())
    expect(screen.queryByText(/step 1 of 4/i)).not.toBeInTheDocument()
  })

  it('navigates the management shell and copies History through the trusted bridge without auto-paste', async () => {
    const user = userEvent.setup()
    const deliverOutput = vi.fn(async () => 'copied' as const)
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true, pasteDelayMs: 275 })),
      listHistory: vi.fn(async () => [{ id: 'one', text: 'trusted local transcript', createdAt: 1, durationMs: 10, language: 'en', modelPreset: 'balanced' as const }]),
      deliverOutput,
    })
    renderApp(bridge)
    await screen.findByRole('heading', { level: 1, name: 'Home' })
    await user.click(screen.getByRole('link', { name: 'History' }))
    await user.click(screen.getByRole('button', { name: 'Copy transcript' }))
    expect(deliverOutput).toHaveBeenCalledWith({ text: 'trusted local transcript', autoPaste: false, pasteDelayMs: 275 })
  })

  it('minimizes natively and closes only to the tray without quitting', async () => {
    const user = userEvent.setup()
    const minimizeApp = vi.fn(async () => undefined)
    const hideApp = vi.fn(async () => undefined)
    const quitApp = vi.fn(async () => undefined)
    renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      minimizeApp,
      hideApp,
      quitApp,
    }))
    await screen.findByRole('heading', { level: 1, name: 'Home' })
    await user.click(screen.getByRole('button', { name: /minimize talktype/i }))
    await user.click(screen.getByRole('button', { name: /close talktype to tray/i }))
    expect(minimizeApp).toHaveBeenCalledOnce()
    expect(hideApp).toHaveBeenCalledOnce()
    expect(quitApp).not.toHaveBeenCalled()
  })

  it('persists onboarding through AppContext before navigating to the ready shell', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn(async (patch) => ({ ...DEFAULT_SETTINGS, ...patch }))
    const bridge = createBridge({ updateSettings })
    renderApp(bridge)

    await completeReadySetup(user)
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ onboardingComplete: true }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible())
  })

  it('installs an optional model only after returned disclosure and explicit consent', async () => {
    const user = userEvent.setup()
    const installModel = vi.fn(async () => OK)
    const bridge = createBridge({
      listModelDisclosures: vi.fn(async () => DISCLOSURES),
      installModel,
    })
    renderApp(bridge)

    await reachMicrophoneStep(user)
    await user.click(screen.getByRole('button', { name: /continue/i }))
    const installFast = await screen.findByRole('button', { name: /install fast/i })
    expect(installFast).toBeDisabled()
    expect(installModel).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox', { name: /allow the fast model download/i }))
    await user.click(installFast)
    await waitFor(() => expect(installModel).toHaveBeenCalledWith({ preset: 'fast', consent: true }))
  })

  it('shows a finite optional-download failure when the desktop bridge is unavailable', async () => {
    const user = userEvent.setup()
    const bridge = createBridge({
      listModelDisclosures: vi.fn(async () => DISCLOSURES),
      installModel: vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const })),
    })
    renderApp(bridge)

    await reachMicrophoneStep(user)
    await user.click(screen.getByRole('button', { name: /continue/i }))
    await screen.findByText(/ip address and request time/i)
    await user.click(screen.getByRole('checkbox', { name: /allow the fast model download/i }))
    await user.click(screen.getByRole('button', { name: /install fast/i }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/download could not start/i))
    expect(screen.getByText(/balanced model is unchanged/i)).toBeVisible()
    expect(document.body).not.toHaveTextContent('MODEL_INSTALL_UNAVAILABLE')
  })

  it('stays in setup and reports a save failure instead of claiming completion', async () => {
    const user = userEvent.setup()
    const bridge = createBridge({
      updateSettings: vi.fn(async () => { throw new Error('private storage detail') }),
    })
    renderApp(bridge)

    await completeReadySetup(user)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not be saved/i))
    expect(screen.getByRole('heading', { name: /one shortcut/i })).toBeVisible()
    expect(document.body).not.toHaveTextContent('private storage detail')
  })

  it('releases an active microphone test across StrictMode unmount cleanup', async () => {
    const user = userEvent.setup()
    const microphone = {
      start: vi.fn(async () => 'ready' as const),
      stop: vi.fn(async () => undefined),
    }
    const mounted = renderApp(createBridge(), () => microphone, true)
    await reachMicrophoneStep(user)
    await user.click(screen.getByRole('button', { name: /test microphone/i }))
    await waitFor(() => expect(microphone.start).toHaveBeenCalled())

    mounted.unmount()
    await waitFor(() => expect(microphone.stop).toHaveBeenCalled())
  })

  it('does not start a replacement microphone after navigation overtakes a deferred retest stop', async () => {
    const user = userEvent.setup()
    const stopped = deferred<void>()
    const active = {
      start: vi.fn(async () => 'ready' as const),
      stop: vi.fn(() => stopped.promise),
    }
    const replacement = {
      start: vi.fn(async () => 'ready' as const),
      stop: vi.fn(async () => undefined),
    }
    const createMicrophoneTest = vi.fn()
      .mockReturnValueOnce(active)
      .mockReturnValue(replacement)
    renderApp(createBridge(), createMicrophoneTest)
    await reachMicrophoneStep(user)
    await user.click(screen.getByRole('button', { name: /test microphone/i }))
    await screen.findByText(/microphone ready/i)

    await user.click(screen.getByRole('button', { name: /retest microphone/i }))
    await waitFor(() => expect(active.stop).toHaveBeenCalledOnce())
    await user.click(screen.getByRole('button', { name: /continue/i }))
    stopped.resolve()

    await screen.findByRole('heading', { name: /your local model/i })
    await act(async () => undefined)
    expect(createMicrophoneTest).toHaveBeenCalledOnce()
    expect(replacement.start).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /continue/i }))
    expect(screen.getByRole('button', { name: /finish setup/i })).toBeEnabled()
  })

  it('does not start or leak a replacement microphone after unmount overtakes a deferred retest', async () => {
    const user = userEvent.setup()
    const stopped = deferred<void>()
    const active = {
      start: vi.fn(async () => 'ready' as const),
      stop: vi.fn(() => stopped.promise),
    }
    const replacement = {
      start: vi.fn(async () => 'ready' as const),
      stop: vi.fn(async () => undefined),
    }
    const createMicrophoneTest = vi.fn()
      .mockReturnValueOnce(active)
      .mockReturnValue(replacement)
    const mounted = renderApp(createBridge(), createMicrophoneTest)
    await reachMicrophoneStep(user)
    await user.click(screen.getByRole('button', { name: /test microphone/i }))
    await screen.findByText(/microphone ready/i)

    await user.click(screen.getByRole('button', { name: /retest microphone/i }))
    await waitFor(() => expect(active.stop).toHaveBeenCalledOnce())
    mounted.unmount()
    stopped.resolve()

    await act(async () => undefined)
    expect(createMicrophoneTest).toHaveBeenCalledOnce()
    expect(replacement.start).not.toHaveBeenCalled()
    expect(replacement.stop).not.toHaveBeenCalled()
  })

  it('lets only the latest concurrent retest allocate a microphone controller', async () => {
    const user = userEvent.setup()
    const stopped = deferred<void>()
    const active = {
      start: vi.fn(async () => 'ready' as const),
      stop: vi.fn(() => stopped.promise),
    }
    const replacement = {
      start: vi.fn(async () => 'ready' as const),
      stop: vi.fn(async () => undefined),
    }
    const staleReplacement = {
      start: vi.fn(async () => 'ready' as const),
      stop: vi.fn(async () => undefined),
    }
    const createMicrophoneTest = vi.fn()
      .mockReturnValueOnce(active)
      .mockReturnValueOnce(replacement)
      .mockReturnValue(staleReplacement)
    renderApp(createBridge(), createMicrophoneTest)
    await reachMicrophoneStep(user)
    await user.click(screen.getByRole('button', { name: /test microphone/i }))
    await screen.findByText(/microphone ready/i)

    const retest = screen.getByRole('button', { name: /retest microphone/i })
    act(() => {
      retest.click()
      retest.click()
    })
    await waitFor(() => expect(active.stop).toHaveBeenCalledOnce())
    stopped.resolve()

    await waitFor(() => expect(replacement.start).toHaveBeenCalledOnce())
    expect(createMicrophoneTest).toHaveBeenCalledTimes(2)
    expect(staleReplacement.start).not.toHaveBeenCalled()
  })

  it('stops a controller whose pending start is overtaken by navigation', async () => {
    const user = userEvent.setup()
    const started = deferred<'ready'>()
    const microphone = {
      start: vi.fn(() => started.promise),
      stop: vi.fn(async () => undefined),
    }
    renderApp(createBridge(), () => microphone)
    await reachMicrophoneStep(user)

    await user.click(screen.getByRole('button', { name: /test microphone/i }))
    await waitFor(() => expect(microphone.start).toHaveBeenCalledOnce())
    await user.click(screen.getByRole('button', { name: /continue/i }))
    await waitFor(() => expect(microphone.stop).toHaveBeenCalledOnce())
    started.resolve('ready')

    await screen.findByRole('heading', { name: /your local model/i })
    await act(async () => undefined)
    expect(microphone.stop).toHaveBeenCalledOnce()
  })

  it('keeps a newer model-status event when an older explicit check resolves later', async () => {
    const user = userEvent.setup()
    const check = deferred<Awaited<ReturnType<TalkTypeBridge['getModelStatus']>>>()
    const listeners: Array<Parameters<TalkTypeBridge['onModelStatus']>[0]> = []
    const bridge = createBridge({
      getModelStatus: vi.fn(() => check.promise),
      onModelStatus: vi.fn((listener) => {
        listeners.push(listener)
        return () => undefined
      }),
    })
    renderApp(bridge)
    await waitFor(() => expect(listeners).toHaveLength(1))
    await waitFor(() => expect(bridge.getModelStatus).toHaveBeenCalledWith('balanced'))

    act(() => listeners[0]?.({ preset: 'balanced', state: 'ready' }))
    await reachMicrophoneStep(user)
    await user.click(screen.getByRole('button', { name: /continue/i }))
    await screen.findByText(/balanced model is included and ready/i)

    check.resolve({ preset: 'balanced', state: 'missing' })
    await act(async () => undefined)
    expect(screen.getByText(/balanced model is included and ready/i)).toBeVisible()
    expect(screen.queryByText(/balanced model is not ready/i)).not.toBeInTheDocument()
  })
})

describe('transcription pipeline prewarm', () => {
  function createPrewarmHarness(bridge: TalkTypeBridge) {
    const prewarm = vi.fn(async () => undefined)
    const factory: AppControllerFactory = () => ({
      getState: () => ({ status: 'idle' }),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      toggle: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      dispose: vi.fn(),
      prewarm,
    })
    render(
      <AppProvider bridge={bridge} createController={factory}>
        <App
          createMicrophoneTest={() => ({
            start: vi.fn(async () => 'ready' as const),
            stop: vi.fn(async () => undefined),
          })}
        />
      </AppProvider>,
    )
    return prewarm
  }

  it('prewarms the pipeline once the controller becomes ready', async () => {
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
    })

    const prewarm = createPrewarmHarness(bridge)

    await waitFor(() => expect(prewarm).toHaveBeenCalledTimes(1))
  })

  it('prewarms again only when the model preset or inference preference changes', async () => {
    let emitSettings: ((next: AppSettings) => void) | undefined
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      onSettingsChanged: vi.fn((listener: (next: AppSettings) => void) => {
        emitSettings = listener
        return () => undefined
      }),
    })

    const prewarm = createPrewarmHarness(bridge)
    await waitFor(() => expect(prewarm).toHaveBeenCalledTimes(1))

    act(() => {
      emitSettings?.({ ...DEFAULT_SETTINGS, onboardingComplete: true, theme: 'dark' })
    })
    expect(prewarm).toHaveBeenCalledTimes(1)

    act(() => {
      emitSettings?.({
        ...DEFAULT_SETTINGS,
        onboardingComplete: true,
        theme: 'dark',
        modelPreset: 'accurate',
      })
    })
    await waitFor(() => expect(prewarm).toHaveBeenCalledTimes(2))

    act(() => {
      emitSettings?.({
        ...DEFAULT_SETTINGS,
        onboardingComplete: true,
        theme: 'dark',
        modelPreset: 'accurate',
        inferencePreference: 'wasm',
      })
    })
    await waitFor(() => expect(prewarm).toHaveBeenCalledTimes(3))
  })
})
