import React, { StrictMode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { App } from '../../../src/renderer/src/App'
import { appearancePreview } from '../../../src/renderer/src/state/appearance'
import type { MicrophoneTestController } from '../../../src/renderer/src/features/onboarding/microphoneTest'
import { AppProvider, useApp, type AppControllerFactory, type AppNavigation } from '../../../src/renderer/src/state/AppContext'
import { type SottoBridge } from '../../../src/shared/contracts'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

const OK = Object.freeze({ ok: true as const })



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
    ensureMicrophoneAccess: vi.fn(async () => true),
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
    onWindowHidden: vi.fn(() => () => undefined),
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
  await waitFor(() => expect(screen.getByRole('heading', { name: /talk to your computer and your coding agents/i })).toBeVisible())
  await user.click(screen.getByRole('button', { name: /get started/i }))
  await waitFor(() => expect(screen.getByRole('heading', { name: /choose how sotto looks/i })).toBeVisible())
  await user.click(screen.getByRole('button', { name: /continue/i }))
  await waitFor(() => expect(screen.getByRole('heading', { name: /check your microphone/i })).toBeVisible())
}

/** Clicks whichever of Continue or Skip for now is offered until Finish setup is reached, without pressing it. */
async function finishRemainingSteps(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  while (screen.queryByRole('button', { name: 'Finish setup' }) === null) {
    await user.click(screen.getByRole('button', { name: /^(continue|skip for now)$/i }))
  }
}

async function completeReadySetup(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await reachMicrophoneStep(user)
  await user.click(screen.getByRole('button', { name: /test microphone/i }))
  await waitFor(() => expect(screen.getByText(/microphone ready/i)).toBeVisible())
  await user.click(screen.getByRole('button', { name: /continue/i }))
  await waitFor(() => expect(screen.getByText(/connect your openrouter key/i)).toBeVisible())
  await finishRemainingSteps(user)
  await user.click(screen.getByRole('button', { name: /finish setup/i }))
}

function setupThreadsTourTests(): void {
  // jsdom lays nothing out, and the tour passes over a part with no box, so every element reports one here.
  let layout: { mockRestore: () => void } | undefined
  beforeEach(() => {
    layout = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 20, left: 20, width: 200, height: 40, right: 220, bottom: 60, x: 20, y: 20, toJSON: () => ({}) } as DOMRect)
  })
  afterEach(() => layout?.mockRestore())
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

export { OK, createBridge, createController, shell, NavigationProbe, openPage, renderApp, reachMicrophoneStep, finishRemainingSteps, completeReadySetup, setupThreadsTourTests }

export { deferred } from '../deferred'
