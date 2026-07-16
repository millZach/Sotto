import React, { StrictMode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

describe('TalkType application onboarding integration', () => {
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

  it('shows only a minimal ready shell after onboarding is already complete', async () => {
    renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
    }))

    await waitFor(() => expect(screen.getByRole('heading', { name: /ready to dictate/i })).toBeVisible())
    expect(screen.queryByText(/step 1 of 4/i)).not.toBeInTheDocument()
  })

  it('persists onboarding through AppContext before navigating to the ready shell', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn(async (patch) => ({ ...DEFAULT_SETTINGS, ...patch }))
    const bridge = createBridge({ updateSettings })
    renderApp(bridge)

    await completeReadySetup(user)
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ onboardingComplete: true }))
    await waitFor(() => expect(screen.getByRole('heading', { name: /ready to dictate/i })).toBeVisible())
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
})
