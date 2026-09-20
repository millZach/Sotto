import React, { StrictMode } from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { App, applyDocumentPreferences } from '../../../src/renderer/src/App'
import { appearancePreview } from '../../../src/renderer/src/state/appearance'
import type { MicrophoneTestController } from '../../../src/renderer/src/features/onboarding/microphoneTest'
import {
  AppProvider,
  useApp,
  type AppControllerFactory,
  type AppNavigation,
} from '../../../src/renderer/src/state/AppContext'
import { threadsStateFixture } from './liveAgentState'
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
    onUpdateCheckRequested: vi.fn(() => () => undefined),
    getStartup: vi.fn(async () => ({ enabled: false })),
    setStartup: vi.fn(async (enabled) => ({ enabled })),
    showApp: vi.fn(async () => undefined),
    hideApp: vi.fn(async () => undefined),
    minimizeApp: vi.fn(async () => undefined),
    reloadApp: vi.fn(async () => undefined),
    toggleMaximizeApp: vi.fn(async () => undefined),
    getWindowMaximized: vi.fn(async () => false),
    onWindowMaximized: vi.fn(() => () => undefined),
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

/**
 * Sotto opens on Threads, so a test about one of the pages under the strip
 * says which page it is about. The probe reads the navigation the provider
 * settled on and hands back the action that changes it, which is what the
 * Threads page's own switch calls.
 */
const shell = {
  navigation: null as AppNavigation | null,
  navigate: ((): void => undefined) as (destination: AppNavigation) => void,
}

function NavigationProbe(): null {
  const app = useApp()
  shell.navigation = app.navigation
  shell.navigate = app.actions.navigate
  return null
}

async function openPage(destination: AppNavigation): Promise<void> {
  await waitFor(() => expect(shell.navigation).toBe('threads'))
  act(() => shell.navigate(destination))
}

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
      <NavigationProbe />
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
  shell.navigation = null
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.themeId
  document.documentElement.removeAttribute('style')
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

  it('seats the Threads sidebar beside Dictate, with the window controls above the room and no strip', async () => {
    const { container } = renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
    }))
    await openPage('home')

    await waitFor(() => expect(document.body).toHaveTextContent(/ready when you are/i))
    expect(container.querySelectorAll('.app-strip')).toHaveLength(0)
    expect(container.querySelectorAll('.app-titlebar, .app-navigation, .dictation-strip')).toHaveLength(0)
    const sidebar = screen.getByRole('complementary', { name: 'Thread sidebar' })
    expect(within(sidebar).getByText('Sotto')).toBeInTheDocument()
    expect(within(sidebar).getByRole('tab', { name: 'Dictate' })).toHaveAttribute('aria-selected', 'true')
    expect(container.querySelector('.app-room__top')).toContainElement(screen.getByRole('button', { name: 'Minimize Sotto' }))
    expect(screen.getByRole('button', { name: 'Close Sotto to tray' })).toBeVisible()
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Add your OpenRouter API key in Settings')
  })

  it('opens on Threads, which owns the whole window and carries the window controls once', async () => {
    const bridge = createBridge({ getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })) })
    const state = threadsStateFixture()
    window.sotto = {
      ...bridge,
      agents: { get: async () => state, command: async () => state, onState: () => () => undefined },
    }
    try {
      const { container } = renderApp(bridge)

      const sidebar = await screen.findByRole('complementary', { name: 'Thread sidebar' })
      expect(sidebar).toBeVisible()
      expect(shell.navigation).toBe('threads')
      expect(container.querySelector('.app-shell')).toHaveClass('app-shell--page')
      expect(container.querySelectorAll('.app-strip')).toHaveLength(0)
      expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
      expect(screen.getAllByRole('main')).toHaveLength(1)
      expect(container.querySelectorAll('.app-controls')).toHaveLength(1)
      expect(screen.getByRole('button', { name: 'Minimize Sotto' })).toBeVisible()
      expect(screen.getByRole('button', { name: 'Close Sotto to tray' })).toBeVisible()
    } finally {
      delete window.sotto
    }
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
    await openPage('home')
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
        lightTheme: 'ember',
        reducedMotion: 'on' as const,
      })),
    })
    renderApp(bridge)

    await waitFor(() => expect(screen.getByRole('heading', { name: /dictation, ready when you are/i })).toBeVisible())
    // The heading commits with the settings render; the preferences land in an
    // effect, so the attributes need their own wait.
    await waitFor(() => expect(document.documentElement.dataset.reducedMotion).toBe('on'))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(document.documentElement).toHaveAttribute('data-theme-id', 'ember')
  })

  it('removes a forced motion attribute when following system motion', () => {
    document.documentElement.dataset.reducedMotion = 'on'
    applyDocumentPreferences({ ...DEFAULT_SETTINGS, reducedMotion: 'system' })
    expect(document.documentElement).not.toHaveAttribute('data-reduced-motion')
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(document.documentElement).toHaveAttribute('data-theme-id', 't3-code')
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
      renderApp(createBridge({ getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'system' as const, lightTheme: 't3-chat', darkTheme: 'iris' })) }))
      await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'light'))
      expect(document.documentElement).toHaveAttribute('data-theme-id', 't3-chat')
      act(() => {
        query.matches = true
        for (const listener of listeners) listener()
      })
      // The system change hands the window to the independently chosen dark half.
      await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'dark'))
      expect(document.documentElement).toHaveAttribute('data-theme-id', 'iris')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('previews Light and then a light theme together while both saves are delayed, and never repaints an older choice', async () => {
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
    await openPage('home')
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'dark'))
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    const root = document.documentElement

    await user.click(screen.getByRole('tab', { name: 'Appearance', exact: true }))
    await user.click(screen.getByRole('button', { name: 'Use light mode' }))
    expect(root).toHaveAttribute('data-theme', 'light')
    await user.click(screen.getByRole('button', { name: 'Use Dusk light mode' }))
    expect(root).toHaveAttribute('data-theme', 'light')
    expect(root).toHaveAttribute('data-theme-id', 'iris')
    expect(screen.getByRole('button', { name: 'Use light mode' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Use Dusk light mode' })).toHaveAttribute('aria-pressed', 'true')
    // Only the light half moved: the dark half still belongs to Sotto.
    expect(screen.getByRole('button', { name: 'Use Sotto dark mode' })).toHaveAttribute('aria-pressed', 'true')

    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]!.patch).toEqual({ appearance: 'light' })
    persisted = { ...persisted, appearance: 'light' }
    await act(async () => { saves[0]!.result.resolve(persisted) })
    expect(root).toHaveAttribute('data-theme-id', 'iris')

    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1]!.patch).toEqual({ lightTheme: 'iris' })
    persisted = { ...persisted, lightTheme: 'iris' }
    await act(async () => { saves[1]!.result.resolve(persisted) })
    expect(root).toHaveAttribute('data-theme', 'light')
    expect(root).toHaveAttribute('data-theme-id', 'iris')
    expect(screen.getByRole('button', { name: 'Use light mode' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Use Dusk light mode' })).toHaveAttribute('aria-pressed', 'true')
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
    await openPage('home')
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme-id', 't3-code'))
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    const root = document.documentElement

    await user.click(screen.getByRole('tab', { name: 'Appearance', exact: true }))
    await user.click(screen.getByRole('button', { name: 'Use light mode' }))
    await user.click(screen.getByRole('button', { name: /^Use Copper theme/u }))
    expect(root).toHaveAttribute('data-theme', 'light')
    expect(root).toHaveAttribute('data-theme-id', 'ember')

    await waitFor(() => expect(saves).toHaveLength(1))
    persisted = { ...persisted, appearance: 'light' }
    await act(async () => { saves[0]!.resolve(persisted) })
    await waitFor(() => expect(saves).toHaveLength(2))
    await act(async () => { saves[1]!.reject(new Error('disk full')) })

    await waitFor(() => expect(root).toHaveAttribute('data-theme-id', 't3-code'))
    expect(root).toHaveAttribute('data-theme', 'light')
    expect(screen.getByRole('button', { name: 'Use Sotto theme, currently active' })).toHaveAttribute('aria-pressed', 'true')
    expect(document.body).toHaveTextContent(/could not be saved/i)
  })

  it('paints the next launch from the last applied look before settings answer', async () => {
    renderApp(createBridge({ getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'light' as const, lightTheme: 'grove', glassOpacity: 55 })) }))
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme-id', 'grove'))
    expect(document.documentElement.style.getPropertyValue('--theme-glass-opacity')).toBe('55%')
    const { readCachedAppearance } = await import('../../../src/renderer/src/state/appearance')
    expect(readCachedAppearance()).toMatchObject({ appearance: 'light', lightTheme: 'grove', darkTheme: 't3-code', glassOpacity: 55 })
    localStorage.setItem('sotto.appearance', '{"appearance":"sepia","lightTheme":"grove","accent":"green"}')
    expect(readCachedAppearance()).toMatchObject({ appearance: 'dark', lightTheme: 'grove' })
    expect(readCachedAppearance()).not.toHaveProperty('accent')
    localStorage.setItem('sotto.appearance', 'not json')
    expect(readCachedAppearance()).toMatchObject({ appearance: 'dark', lightTheme: 't3-code', darkTheme: 't3-code' })
  })

  it('shows the complete management dashboard after onboarding is already complete', async () => {
    renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
    }))
    await openPage('home')

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: /ready when you are/i })).toBeVisible())
    expect(screen.queryByText(/step 1 of 4/i)).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Dictate' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab', { name: /agents/i })).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Pages' })).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toHaveTextContent(/add your openrouter api key in settings/i)
  })

  it('carries a release offer through the update control: download, a toast when it lands, then a confirmed restart', async () => {
    const user = userEvent.setup()
    let publish: ((status: UpdateStatus) => void) | null = null
    const downloadUpdate = vi.fn(async () => {
      publish?.({ currentVersion: '3.4.0', phase: { phase: 'downloaded', version: '3.5.0', problem: null }, checkedAt: 1 })
      return OK
    })
    const installUpdate = vi.fn(async () => OK)
    const openExternalLink = vi.fn(async () => OK)
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      getUpdateStatus: vi.fn(async () => ({
        currentVersion: '3.4.0',
        phase: { phase: 'available' as const, version: '3.5.0', problem: null },
        checkedAt: 1,
      })),
      onUpdateStatus: vi.fn((listener: (status: UpdateStatus) => void) => {
        publish = listener
        return () => undefined
      }),
      downloadUpdate,
      installUpdate,
      openExternalLink,
    })
    // The toast's "Read more" link opens through the window bridge, as every external link does.
    window.sotto = bridge
    renderApp(bridge)
    await openPage('home')

    await screen.findByRole('heading', { level: 1, name: /ready when you are/i })
    const offer = await screen.findByRole('button', { name: 'Update 3.5.0 ready to download' })
    expect(screen.getByRole('complementary', { name: 'Thread sidebar' })).toContainElement(offer)
    expect(document.querySelector('.update-banner')).toBeNull()
    await user.click(offer)
    expect(downloadUpdate).toHaveBeenCalledOnce()

    const toast = await screen.findByRole('status', { name: '' })
    expect(toast).toHaveTextContent(/Update downloaded/)
    expect(toast).toHaveAttribute('data-tone', 'success')
    await user.click(screen.getByRole('button', { name: 'Read more' }))
    expect(openExternalLink).toHaveBeenCalledWith('https://github.com/millZach/Sotto-releases/releases/tag/v3.5.0')

    // The control now offers the restart, and the restart asks first.
    await user.click(screen.getByRole('button', { name: 'Update 3.5.0 downloaded. Click to restart and install.' }))
    const dialog = screen.getByRole('dialog', { name: 'Install update 3.5.0 and restart Sotto?' })
    expect(dialog).toHaveTextContent(/will be interrupted/)
    await user.click(screen.getByRole('button', { name: 'Not now' }))
    expect(installUpdate).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Update 3.5.0 downloaded. Click to restart and install.' }))
    await user.click(screen.getByRole('button', { name: 'Restart and install' }))
    expect(installUpdate).toHaveBeenCalledOnce()
    delete window.sotto
  })

  it('says why a download or install could not be completed and offers the same action again', async () => {
    const user = userEvent.setup()
    let publish: ((status: UpdateStatus) => void) | null = null
    const downloadUpdate = vi.fn(async () => {
      publish?.({ currentVersion: '3.4.0', phase: { phase: 'available', version: '3.5.0', problem: 'net::ERR_INTERNET_DISCONNECTED' }, checkedAt: 1 })
      return { ok: false as const, reason: 'unavailable' as const }
    })
    renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      getUpdateStatus: vi.fn(async () => ({
        currentVersion: '3.4.0',
        phase: { phase: 'available' as const, version: '3.5.0', problem: null },
        checkedAt: 1,
      })),
      onUpdateStatus: vi.fn((listener: (status: UpdateStatus) => void) => {
        publish = listener
        return () => undefined
      }),
      downloadUpdate,
    }))
    await openPage('home')

    await screen.findByRole('heading', { level: 1, name: /ready when you are/i })
    await user.click(await screen.findByRole('button', { name: 'Update 3.5.0 ready to download' }))

    const toast = await screen.findByRole('alert')
    expect(toast).toHaveTextContent('Could not download update net::ERR_INTERNET_DISCONNECTED')
    expect(screen.getByRole('button', { name: 'Download failed for 3.5.0. Click to retry.' })).toBeInTheDocument()

    act(() => publish?.({ currentVersion: '3.4.0', phase: { phase: 'downloaded', version: '3.5.0', problem: 'No update filepath provided, can’t quit and install' }, checkedAt: 1 }))
    expect(screen.getByRole('button', { name: 'Install failed for 3.5.0. Click to retry.' })).toBeInTheDocument()
  })

  it('runs a check from the footer control, from the application menu, and says when neither can', async () => {
    const user = userEvent.setup()
    let requestCheck: (() => void) | null = null
    const checkForUpdates = vi.fn(async () => ({
      currentVersion: '3.4.0',
      phase: { phase: 'failed' as const, problem: 'GitHub answered 503' },
      checkedAt: 2,
    }))
    renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      getUpdateStatus: vi.fn(async () => ({
        currentVersion: '3.4.0',
        phase: { phase: 'up-to-date' as const },
        checkedAt: 1,
      })),
      onUpdateCheckRequested: vi.fn((listener: () => void) => {
        requestCheck = listener
        return () => undefined
      }),
      checkForUpdates,
    }))
    await openPage('home')

    await screen.findByRole('heading', { level: 1, name: /ready when you are/i })
    await user.click(await screen.findByRole('button', { name: 'Check for updates' }))
    expect(checkForUpdates).toHaveBeenCalledOnce()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check for updates GitHub answered 503')

    act(() => requestCheck?.())
    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(2))
  })

  it('disables the footer control on a build without an update feed', async () => {
    renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      getUpdateStatus: vi.fn(async () => ({
        currentVersion: '3.4.0',
        phase: { phase: 'unsupported' as const },
        checkedAt: null,
      })),
    }))
    await openPage('home')

    await screen.findByRole('heading', { level: 1, name: /ready when you are/i })
    const control = await screen.findByRole('button', { name: 'Update checks run only in the installed Windows app.' })
    expect(control).toHaveAttribute('aria-disabled', 'true')
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
    await openPage('home')
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
    await openPage('home')
    await screen.findByRole('heading', { level: 1, name: /ready when you are/i })
    await user.click(screen.getByRole('button', { name: /minimize sotto/i }))
    await user.click(screen.getByRole('button', { name: /close sotto to tray/i }))
    expect(minimizeApp).toHaveBeenCalledOnce()
    expect(hideApp).toHaveBeenCalledOnce()
    expect(quitApp).not.toHaveBeenCalled()
  })

  it('persists onboarding through AppContext before opening Threads', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn(async (patch) => ({ ...DEFAULT_SETTINGS, ...patch }))
    const bridge = createBridge({ updateSettings })
    const { container } = renderApp(bridge)

    await completeReadySetup(user)
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ onboardingComplete: true, microphoneSkipped: false }))
    // Setup hands over to the page the returning user will always land on.
    await waitFor(() => expect(shell.navigation).toBe('threads'))
    expect(container.querySelector('.app-shell')).toHaveClass('app-shell--page')
    expect(container.querySelectorAll('.app-strip')).toHaveLength(0)
    expect(screen.queryByRole('heading', { level: 1, name: /ready when you are/i })).not.toBeInTheDocument()
  })

  it('finishes setup without a microphone and lands in a working shell', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn(async (patch) => ({ ...DEFAULT_SETTINGS, ...patch }))
    renderApp(
      createBridge({ updateSettings }),
      () => ({ start: vi.fn(async () => 'missing' as const), stop: vi.fn(async () => undefined) }),
    )

    await reachMicrophoneStep(user)
    await user.click(screen.getByRole('button', { name: /test microphone/i }))
    await waitFor(() => expect(screen.getByText(/no microphone was found/i)).toBeVisible())
    await user.click(screen.getByRole('button', { name: /skip for now/i }))
    await user.click(screen.getByRole('button', { name: /continue/i }))
    await user.click(screen.getByRole('button', { name: /continue/i }))
    await user.click(screen.getByRole('button', { name: /finish setup/i }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ onboardingComplete: true, microphoneSkipped: true }))
    await waitFor(() => expect(shell.navigation).toBe('threads'))
    act(() => shell.navigate('home'))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: /no microphone is set up/i })).toBeVisible())
    // Everything that is not voice is still one click away. The beta hides the
    // voice coordinator, so the switch offers Dictate and Threads only.
    expect(screen.getByRole('tab', { name: 'Threads' })).toBeVisible()
    expect(screen.queryByRole('tab', { name: /agents/i })).not.toBeInTheDocument()
    // The sidebar's foot carries the other pages as icon links; Threads is the switch's own tab.
    for (const destination of ['Chats', 'History', 'Settings', 'Help']) {
      expect(screen.getByRole('link', { name: destination })).toBeVisible()
    }
    await user.click(screen.getByRole('link', { name: 'Chats' }))
    expect(screen.queryByRole('heading', { name: /check your microphone/i })).not.toBeInTheDocument()
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
    await openPage('home')

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: /ready when you are/i })).toBeInTheDocument())
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Add your OpenRouter API key in Settings')
    expect(screen.queryByRole('button', { name: /minimize sotto/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: /help/i }))
    expect(screen.getByText(copy.helpMicrophoneAccess)).toBeVisible()
    expect(screen.getByText(copy.accessibilityHelp ?? '')).toBeVisible()

    await user.click(screen.getByRole('link', { name: /settings/i }))
    await user.click(screen.getByRole('tab', { name: 'Application', exact: true }))
    expect(await screen.findByRole('switch', { name: copy.settingsLaunchAtStartupLabel })).toBeVisible()
  })
})
