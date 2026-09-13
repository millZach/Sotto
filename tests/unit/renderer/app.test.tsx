import React, { StrictMode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { App, applyDocumentPreferences } from '../../../src/renderer/src/App'
import { appearancePreview } from '../../../src/renderer/src/state/appearance'
import type { MicrophoneTestController } from '../../../src/renderer/src/features/onboarding/microphoneTest'
import {
  AppProvider,
  type AppControllerFactory,
} from '../../../src/renderer/src/state/AppContext'
import {
  type SottoBridge,
  type UpdateStatus,
} from '../../../src/shared/contracts'
import { platformCopy } from '../../../src/renderer/src/platformCopy'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'

const OK = Object.freeze({ ok: true as const })

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail })
  return { promise, reject, resolve }
}

function createBridge(overrides: Partial<SottoBridge> = {}): SottoBridge {
  return {
    platform: 'win32',
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
    transcribe: vi.fn(async () => ({ ok: false as const, reason: 'unconfigured' as const })),
    cancelTranscription: vi.fn(async () => OK),
    checkTranscriptionKey: vi.fn(async () => ({ ok: false as const, reason: 'unconfigured' as const })),
    polishTranscript: vi.fn(async (request) => ({ text: request.text, applied: false })),
    deliverOutput: vi.fn(async () => 'copied' as const),
    getUpdateStatus: vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const })),
    checkForUpdates: vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const })),
    downloadUpdate: vi.fn(async () => OK),
    installUpdate: vi.fn(async () => OK),
    onUpdateStatus: vi.fn(() => () => undefined),
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
  bridge: SottoBridge,
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
  await waitFor(() => expect(screen.getByRole('heading', { name: /dictation, ready when you are/i })).toBeVisible())
  await user.click(screen.getByRole('button', { name: /continue/i }))
}

async function completeReadySetup(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await reachMicrophoneStep(user)
  await user.click(screen.getByRole('button', { name: /test microphone/i }))
  await waitFor(() => expect(screen.getByText(/microphone ready/i)).toBeVisible())
  await user.click(screen.getByRole('button', { name: /continue/i }))
  await waitFor(() => expect(screen.getByText(/connect your openrouter key/i)).toBeVisible())
  await user.click(screen.getByRole('button', { name: /continue/i }))
  await user.click(screen.getByRole('button', { name: /finish setup/i }))
}

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.accent
  delete document.documentElement.dataset.reducedMotion
  appearancePreview.reset()
  localStorage.clear()
})

describe('shared main-window frame', () => {
  it.each([
    {
      name: 'loading',
      createStateBridge: () => createBridge({
        getSettings: vi.fn(() => new Promise<AppSettings>(() => undefined)),
      }),
      stateText: /preparing sotto/i,
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
      stateText: /dictation, ready when you are/i,
    },
    {
      name: 'ready',
      createStateBridge: () => createBridge({
        getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      }),
      stateText: /ready when you are/i,
    },
  ])('renders exactly one strip and both window controls in the $name state', async ({
    createStateBridge,
    stateText,
  }) => {
    const { container } = renderApp(createStateBridge())

    await waitFor(() => expect(document.body).toHaveTextContent(stateText))

    expect(container.querySelectorAll('.app-strip')).toHaveLength(1)
    expect(container.querySelectorAll('.app-titlebar, .app-navigation, .dictation-strip')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Minimize Sotto' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Close Sotto to tray' })).toBeVisible()
  })
})

describe('Sotto application onboarding integration', () => {
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
    expect(screen.getByRole('heading', { level: 1, name: /ready when you are/i })).toBeVisible()
  })

  it('explains both macOS permission panes when auto-paste is refused', async () => {
    const bridge = createBridge({
      platform: 'darwin',
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      listRecoveryNotices: vi.fn(async () => [{ code: 'ACCESSIBILITY_PERMISSION_REQUIRED' as const }]),
    })
    renderApp(bridge)

    const toast = await screen.findByText(/copied the transcript instead of pasting it/i)
    expect(toast).toBeVisible()
    expect(toast).toHaveTextContent(/Privacy & Security > Accessibility/i)
    expect(toast).toHaveTextContent(/Privacy & Security > Automation/i)
  })

  it('renders loading and a finite recovery state when settings cannot load', async () => {
    const settings = deferred<AppSettings>()
    const bridge = createBridge({ getSettings: vi.fn(() => settings.promise) })
    renderApp(bridge)
    expect(screen.getByRole('status')).toHaveTextContent(/preparing sotto/i)

    settings.reject(new Error('private storage detail'))
    await waitFor(() => expect(screen.getByRole('heading', { name: /could not finish starting/i })).toBeVisible())
    expect(document.body).not.toHaveTextContent('private storage detail')
  })

  it('shows first-run onboarding and applies the motion preference and the chosen appearance, not the widget theme', async () => {
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({
        ...DEFAULT_SETTINGS,
        theme: 'dark' as const,
        appearance: 'light' as const,
        accent: 'rose' as const,
        reducedMotion: 'on' as const,
      })),
    })
    renderApp(bridge)

    await waitFor(() => expect(screen.getByRole('heading', { name: /dictation, ready when you are/i })).toBeVisible())
    // The heading commits with the settings render; the preferences land in an
    // effect, so the attributes need their own wait.
    await waitFor(() => expect(document.documentElement.dataset.reducedMotion).toBe('on'))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(document.documentElement).toHaveAttribute('data-accent', 'rose')
  })

  it('removes a forced motion attribute when following system motion', () => {
    document.documentElement.dataset.reducedMotion = 'on'
    applyDocumentPreferences({ ...DEFAULT_SETTINGS, reducedMotion: 'system' })
    expect(document.documentElement).not.toHaveAttribute('data-reduced-motion')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement).toHaveAttribute('data-accent', 'teal')
  })

  it.each(['light', 'dark', 'system'] as const)('paints an upgraded install dark whatever its persisted %s widget theme says', (theme) => {
    document.documentElement.dataset.theme = 'light'
    applyDocumentPreferences({ ...DEFAULT_SETTINGS, theme, reducedMotion: 'on' }, document.documentElement, false)
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement.dataset.reducedMotion).toBe('on')
  })

  it('resolves system appearance against the operating system scheme and follows it live', async () => {
    const listeners = new Set<() => void>()
    const query = { matches: false, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) }
    vi.stubGlobal('matchMedia', vi.fn((media: string) => media === '(prefers-color-scheme: dark)' ? query : { matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }))
    try {
      renderApp(createBridge({ getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'system' as const, accent: 'blue' as const })) }))
      await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'light'))
      expect(document.documentElement).toHaveAttribute('data-accent', 'blue')
      act(() => {
        query.matches = true
        for (const listener of listeners) listener()
      })
      await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'dark'))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('previews Light and then an accent together while both saves are delayed, and never repaints an older choice', async () => {
    const user = userEvent.setup()
    const saves: Array<{ patch: Partial<AppSettings>; result: ReturnType<typeof deferred<AppSettings>> }> = []
    let persisted: AppSettings = { ...DEFAULT_SETTINGS, onboardingComplete: true }
    const bridge = createBridge({
      getSettings: vi.fn(async () => persisted),
      updateSettings: vi.fn((patch) => {
        const result = deferred<AppSettings>()
        saves.push({ patch, result })
        return result.promise
      }),
    })
    renderApp(bridge)
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'dark'))
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    const root = document.documentElement

    await user.click(screen.getByRole('radio', { name: 'Light' }))
    expect(root).toHaveAttribute('data-theme', 'light')
    await user.click(screen.getByRole('radio', { name: 'Violet' }))
    expect(root).toHaveAttribute('data-theme', 'light')
    expect(root).toHaveAttribute('data-accent', 'violet')
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Violet' })).toHaveAttribute('aria-checked', 'true')

    // The settings queue sends the accent only after the mode save answers.
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]!.patch).toEqual({ appearance: 'light' })
    persisted = { ...persisted, appearance: 'light' }
    await act(async () => { saves[0]!.result.resolve(persisted) })
    expect(root).toHaveAttribute('data-theme', 'light')
    expect(root).toHaveAttribute('data-accent', 'violet')

    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1]!.patch).toEqual({ accent: 'violet' })
    persisted = { ...persisted, accent: 'violet' }
    await act(async () => { saves[1]!.result.resolve(persisted) })
    expect(root).toHaveAttribute('data-theme', 'light')
    expect(root).toHaveAttribute('data-accent', 'violet')
    expect(screen.getByText(/Sotto is/u)).toHaveTextContent('Sotto is light with a violet accent.')
  })

  it('restores the truthful persisted look when the final overlapping appearance save fails', async () => {
    const user = userEvent.setup()
    const saves: Array<ReturnType<typeof deferred<AppSettings>>> = []
    let persisted: AppSettings = { ...DEFAULT_SETTINGS, onboardingComplete: true }
    renderApp(createBridge({
      getSettings: vi.fn(async () => persisted),
      updateSettings: vi.fn(() => {
        const result = deferred<AppSettings>()
        saves.push(result)
        return result.promise
      }),
    }))
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-accent', 'teal'))
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    const root = document.documentElement

    await user.click(screen.getByRole('radio', { name: 'Light' }))
    await user.click(screen.getByRole('radio', { name: 'Amber' }))
    expect(root).toHaveAttribute('data-theme', 'light')
    expect(root).toHaveAttribute('data-accent', 'amber')

    await waitFor(() => expect(saves).toHaveLength(1))
    persisted = { ...persisted, appearance: 'light' }
    await act(async () => { saves[0]!.resolve(persisted) })
    await waitFor(() => expect(saves).toHaveLength(2))
    await act(async () => { saves[1]!.reject(new Error('disk full')) })

    await waitFor(() => expect(root).toHaveAttribute('data-accent', 'teal'))
    expect(root).toHaveAttribute('data-theme', 'light')
    expect(screen.getByRole('radio', { name: 'Teal' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be saved/i)
  })

  it('paints the next launch from the last applied look before settings answer', async () => {
    renderApp(createBridge({ getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'light' as const, accent: 'green' as const })) }))
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-accent', 'green'))
    const { readCachedAppearance } = await import('../../../src/renderer/src/state/appearance')
    expect(readCachedAppearance()).toEqual({ appearance: 'light', accent: 'green' })
    localStorage.setItem('sotto.appearance', '{"appearance":"sepia","accent":"green"}')
    expect(readCachedAppearance()).toEqual({ appearance: 'dark', accent: 'green' })
    localStorage.setItem('sotto.appearance', 'not json')
    expect(readCachedAppearance()).toEqual({ appearance: 'dark', accent: 'teal' })
  })

  it('shows the complete management dashboard after onboarding is already complete', async () => {
    renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
    }))

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: /ready when you are/i })).toBeVisible())
    expect(screen.queryByText(/step 1 of 4/i)).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Dictate' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('navigation', { name: 'Pages' })).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toHaveTextContent(/add your openrouter api key in settings/i)
  })

  it('carries a release offer into the management window and keeps a dismissal for the session', async () => {
    const user = userEvent.setup()
    const downloadUpdate = vi.fn(async () => OK)
    let publish: ((status: UpdateStatus) => void) | null = null
    renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      getUpdateStatus: vi.fn(async () => ({
        currentVersion: '3.4.0',
        phase: { phase: 'available' as const, version: '3.5.0' },
      })),
      onUpdateStatus: vi.fn((listener: (status: UpdateStatus) => void) => {
        publish = listener
        return () => undefined
      }),
      downloadUpdate,
    }))

    await screen.findByRole('heading', { level: 1, name: /ready when you are/i })
    await screen.findByText('Sotto 3.5.0 is available')
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(downloadUpdate).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: 'Dismiss update notice' }))
    expect(screen.queryByText('Sotto 3.5.0 is available')).not.toBeInTheDocument()

    // Progress on the version that was waved away stays waved away.
    act(() => publish?.({
      currentVersion: '3.4.0',
      phase: { phase: 'downloading', version: '3.5.0', percent: 30 },
    }))
    expect(screen.queryByText('Downloading Sotto 3.5.0')).not.toBeInTheDocument()

    // A finished download is a different moment, so it surfaces once more.
    act(() => publish?.({
      currentVersion: '3.4.0',
      phase: { phase: 'downloaded', version: '3.5.0' },
    }))
    expect(screen.getByText('Sotto 3.5.0 is ready to install')).toBeVisible()
  })

  it('keeps the management window quiet while nothing is on offer', async () => {
    renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      getUpdateStatus: vi.fn(async () => ({
        currentVersion: '3.4.0',
        phase: { phase: 'up-to-date' as const },
      })),
    }))

    await screen.findByRole('heading', { level: 1, name: /ready when you are/i })
    expect(document.querySelector('.update-banner')).toBeNull()
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
    await screen.findByRole('heading', { level: 1, name: /ready when you are/i })
    await user.click(screen.getByRole('link', { name: 'History' }))
    await user.click(screen.getAllByRole('button', { name: 'Copy transcript' })[0]!)
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
    await screen.findByRole('heading', { level: 1, name: /ready when you are/i })
    await user.click(screen.getByRole('button', { name: /minimize sotto/i }))
    await user.click(screen.getByRole('button', { name: /close sotto to tray/i }))
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
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: /ready when you are/i })).toBeVisible())
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

    await screen.findByRole('heading', { name: /connect your openrouter key/i })
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

    await screen.findByRole('heading', { name: /connect your openrouter key/i })
    await act(async () => undefined)
    expect(microphone.stop).toHaveBeenCalledOnce()
  })


})

describe('transcription pipeline prewarm', () => {
  function createPrewarmHarness(bridge: SottoBridge) {
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

  it('does not prewarm again when settings change', async () => {
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
        language: 'es',
      })
    })
    await waitFor(() => expect(prewarm).toHaveBeenCalledTimes(1))
  })
  it('carries the bridge platform into every main-window view', async () => {
    const user = userEvent.setup()
    const copy = platformCopy('darwin')
    renderApp(createBridge({
      platform: 'darwin',
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
    }))

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: /ready when you are/i })).toBeInTheDocument())
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Add your OpenRouter API key in Settings')
    expect(screen.queryByRole('button', { name: /minimize sotto/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: /help/i }))
    expect(screen.getByText(copy.helpMicrophoneAccess)).toBeVisible()
    expect(screen.getByText(copy.accessibilityHelp ?? '')).toBeVisible()

    await user.click(screen.getByRole('link', { name: /settings/i }))
    expect(await screen.findByRole('switch', { name: copy.settingsLaunchAtStartupLabel })).toBeVisible()
  })
})
