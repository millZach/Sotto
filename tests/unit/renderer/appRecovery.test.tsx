import { deferred, createBridge, createController, shell, NavigationProbe, openPage, renderApp } from '../../fixtures/renderer/appHarness'
import React from 'react'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../../src/renderer/src/App'
import { AppProvider, createProductionDictationController, useApp, type AppControllerFactory } from '../../../src/renderer/src/state/AppContext'
import { type SottoBridge } from '../../../src/shared/contracts'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'

it.each(['unmount', 'blur'] as const)('shows dictionary save failures after Settings closes (%s)', async trigger => {
  const pending = deferred<AppSettings>()
  const bridge = createBridge({
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
    updateSettings: vi.fn(() => pending.promise),
  })
  render(<AppProvider bridge={bridge}><NavigationProbe /><App /></AppProvider>)
  await openPage('settings')
  await userEvent.click(screen.getByRole('tab', { name: 'Cleanup' }))
  const dictionary = screen.getByRole('textbox', { name: 'Personal dictionary' })
  await userEvent.type(dictionary, 'Sotto')
  if (trigger === 'blur') await userEvent.tab()
  act(() => shell.navigate('history'))
  await act(async () => { pending.reject(new Error('Synthetic save failure')) })
  expect(await screen.findByText('Your dictionary edits were not saved. Open Settings, choose Cleanup and enter them again.')).toBeVisible()
  expect(screen.getByText('Your dictionary edits were not saved. Open Settings, choose Cleanup and enter them again.')).toHaveAttribute('role', 'alert')
  if (trigger === 'blur') {
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss dictionary save notice' }))
  } else {
    vi.mocked(bridge.updateSettings).mockResolvedValueOnce({ ...DEFAULT_SETTINGS, onboardingComplete: true, llmDictionary: 'Recovered dictionary' })
    act(() => shell.navigate('settings'))
    await userEvent.click(screen.getByRole('tab', { name: 'Cleanup' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Personal dictionary' }), 'Recovered dictionary')
    await userEvent.tab()
  }
  await waitFor(() => expect(screen.queryByText('Your dictionary edits were not saved. Open Settings, choose Cleanup and enter them again.')).not.toBeInTheDocument())
})

it('retains failed dictation across navigation and later dictation, and copies without retranscription or paste', async () => {
  let recordings = 0
  const transcribe = vi.fn(async () => ({ text: `Completed words ${++recordings}`, language: 'en' }))
  const factory: AppControllerFactory = bindings => createProductionDictationController(bindings, {
    createRecorder: () => ({ start: async () => undefined, stop: async () => ({ samples: new Float32Array([0.2]), sourceSampleRate: 16_000, durationMs: 500 }), cancel: async () => undefined }),
    createTranscriber: () => ({ transcribe, cancel: () => undefined, dispose: () => undefined }),
    createCuePlayer: () => ({ playStart: () => undefined, playStop: () => undefined }),
  })
  const deliverOutput = vi.fn<SottoBridge['deliverOutput']>()
    .mockRejectedValueOnce(new Error('Synthetic copy failure'))
    .mockRejectedValueOnce(new Error('Synthetic copy failure'))
    .mockRejectedValueOnce(new Error('Synthetic retry failure'))
    .mockResolvedValue('copied')
  const bridge = createBridge({
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true, historyEnabled: false, llmApiKey: 'synthetic', autoPaste: true })),
    deliverOutput,
  })
  const user = userEvent.setup()
  render(<AppProvider bridge={bridge} createController={factory}><NavigationProbe /><App /></AppProvider>)
  await openPage('home')
  const dictate = async () => {
    await user.click(screen.getByRole('button', { name: 'Start dictation' }))
    await user.click(screen.getByRole('button', { name: 'Stop' }))
  }
  await dictate()
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Completed dictation text' })).toHaveValue('Completed words 1'))
  act(() => shell.navigate('history'))
  act(() => shell.navigate('home'))
  expect(screen.getByRole('textbox', { name: 'Completed dictation text' })).toHaveValue('Completed words 1')
  await dictate()
  await waitFor(() => expect(screen.getAllByRole('textbox', { name: 'Completed dictation text' })).toHaveLength(2))
  expect(screen.getAllByRole('textbox', { name: 'Completed dictation text' }).map(node => (node as HTMLTextAreaElement).value)).toEqual(['Completed words 1', 'Completed words 2'])
  await user.click(screen.getAllByRole('button', { name: 'Copy text' })[0]!)
  expect(await screen.findByText('Copy failed. Your text is still here. Try again or select and copy it.')).toBeVisible()
  await user.click(screen.getAllByRole('button', { name: 'Copy text' })[0]!)
  await waitFor(() => expect(screen.getByText('Copied.')).toBeVisible())
  expect(deliverOutput.mock.calls.slice(2)).toEqual([
    [expect.objectContaining({ text: 'Completed words 1', autoPaste: false })],
    [expect.objectContaining({ text: 'Completed words 1', autoPaste: false })],
  ])
  expect(transcribe).toHaveBeenCalledTimes(2)
  await dictate()
  await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(3))
  expect(screen.getAllByRole('textbox', { name: 'Completed dictation text' })).toHaveLength(2)
  expect(bridge.addHistory).not.toHaveBeenCalled()
  await user.click(screen.getAllByRole('button', { name: 'Dismiss text' })[0]!)
  expect(screen.getByRole('textbox', { name: 'Completed dictation text' })).toHaveValue('Completed words 2')
})

it('keeps cached history and reports failure when deletion is refused while history is off', async () => {
  const entry = { id: 'retained', text: 'Retained transcript', createdAt: 1, durationMs: 10, language: 'en', modelPreset: 'balanced' as const }
  const otherEntry = { ...entry, id: 'other-retained', text: 'Another retained transcript' }
  const bridge = createBridge({
    listHistory: vi.fn(async () => [entry, otherEntry]),
    deleteHistory: vi.fn(async () => false),
  })
  const { result } = renderHook(() => useApp(), {
    wrapper: ({ children }) => <AppProvider bridge={bridge} createController={createController}>{children}</AppProvider>,
  })
  await waitFor(() => expect(result.current.history).toEqual([entry, otherEntry]))
  await act(async () => { await result.current.actions.updateSettings({ historyEnabled: false }) })
  vi.mocked(bridge.listHistory).mockResolvedValue([])

  let deleted: boolean | undefined
  await act(async () => { deleted = await result.current.actions.deleteHistory(entry.id) })

  expect(deleted).toBe(false)
  expect(result.current.history).toEqual([entry, otherEntry])
  expect(result.current.failure).toBe('HISTORY_UPDATE_FAILED')
  expect(bridge.listHistory).toHaveBeenCalledOnce()

  vi.mocked(bridge.deleteHistory).mockResolvedValue(true)
  await act(async () => { deleted = await result.current.actions.deleteHistory(entry.id) })
  expect(deleted).toBe(true)
  expect(result.current.history).toEqual([otherEntry])
  expect(result.current.historyStatus).toBe('ready')
  await act(async () => { deleted = await result.current.actions.deleteHistory(otherEntry.id) })
  expect(deleted).toBe(true)
  expect(result.current.history).toEqual([])
  expect(result.current.historyStatus).toBe('ready')
  expect(bridge.deleteHistory).toHaveBeenNthCalledWith(3, otherEntry.id)
  expect(bridge.listHistory).toHaveBeenCalledOnce()
})

describe('Sotto application onboarding integration', () => {
  it('explains that retired chat data remains when privacy cleanup fails', async () => {
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      listRecoveryNotices: vi.fn(async () => [{ code: 'RETIRED_CHAT_HISTORY_NOT_CLEARED' as const }]),
    })
    renderApp(bridge)
    expect(await screen.findByText('Saved chat history could not be fully cleared. Some local chat data was left in place. Repair local storage, then save Settings or restart Sotto to try again.')).toBeVisible()
  })

  it('describes shared answer-storage failures without claiming the user has retired Chats', async () => {
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      listRecoveryNotices: vi.fn(async () => [{ code: 'ANSWER_HISTORY_NOT_CLEARED' as const }]),
    })
    renderApp(bridge)
    expect(await screen.findByText('Saved answer cleanup could not finish. The original file was preserved. Repair local storage, then restart Sotto to try again.')).toBeVisible()
    expect(screen.queryByText(/Saved chat history could not be fully cleared/)).not.toBeInTheDocument()
  })

  it('shows deduplicated non-blocking recovery notices without paths or transcript content', async () => {
    let recoveryListener: ((notice: { code: 'SETTINGS_RECOVERED' | 'HISTORY_RECOVERED' }) => void) | undefined
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      listRecoveryNotices: vi.fn(async () => [
        { code: 'SETTINGS_RECOVERED' as const },
        { code: 'HISTORY_RECOVERED' as const },
        { code: 'CREDENTIALS_RECOVERED' as const },
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
    )).toHaveLength(3))
    expect(screen.getByText(/restored default settings/i)).toBeVisible()
    expect(screen.getByText(/started with an empty history/i)).toBeVisible()
    expect(screen.getByText(/Add your keys again in Settings/)).toBeVisible()
    expect(document.body).not.toHaveTextContent('C:\\private\\settings.json')
    expect(document.body).not.toHaveTextContent('private transcript content')
    expect(screen.getByRole('heading', { level: 1, name: /ready when you are/i })).toBeVisible()
  })

  it('shows the startup key migration notice and repeats recovery guidance in Settings', async () => {
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      listRecoveryNotices: vi.fn(async () => [{ code: 'OPENROUTER_KEY_MIGRATION_FAILED' as const }]),
    })
    renderApp(bridge)
    await openPage('home')
    expect(await screen.findByText('The OpenRouter key could not be stored securely. Enter it again in Settings → Transcription.')).toBeVisible()
    act(() => shell.navigate('settings'))
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Transcription' }))
    expect(await screen.findByText('The OpenRouter key could not be stored securely. Enter it again.')).toBeVisible()
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
    expect(toast).toHaveTextContent(/After an update, if paste still fails, remove Sotto from the Accessibility list and add it again/)
  })

  it.each([
    ['ACCESSIBILITY_PERMISSION_REQUIRED', 'accessibility', 'Accessibility'],
    ['AUTOMATION_PERMISSION_REQUIRED', 'automation', 'Automation'],
  ] as const)('opens the macOS pane a %s notice is about', async (code, pane, paneName) => {
    const openSystemSettings = vi.fn(async () => ({ ok: true as const }))
    const bridge = createBridge({
      platform: 'darwin',
      openSystemSettings,
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      listRecoveryNotices: vi.fn(async () => [{ code }]),
    })
    // The button opens the pane through the window bridge, as external links do.
    window.sotto = bridge
    try {
      renderApp(bridge)

      const button = await screen.findByRole('button', { name: `Open System Settings at Privacy & Security, ${paneName}` })
      expect(button).toHaveTextContent('Open System Settings')
      button.focus()
      await userEvent.setup().keyboard('{Enter}')
      expect(openSystemSettings).toHaveBeenCalledExactlyOnceWith(pane)
    } finally {
      delete window.sotto
    }
  })

  it('says a denied Automation permission left the text copied', async () => {
    const bridge = createBridge({
      platform: 'darwin',
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      listRecoveryNotices: vi.fn(async () => [{ code: 'AUTOMATION_PERMISSION_REQUIRED' as const }]),
    })
    renderApp(bridge)

    const toast = await screen.findByText(/copied the transcript instead of pasting it/i)
    expect(toast).toHaveTextContent(/control System Events in System Settings > Privacy & Security > Automation/)
    expect(screen.queryByRole('button', { name: /Open System Settings/ })).toBeNull()
  })

  it.each([
    ['darwin', /allow Keychain access when macOS asks, or enter the key again in Settings → Transcription/],
    ['win32', /Nothing was deleted. Enter the key again in Settings → Transcription/],
  ] as const)('explains an unreadable saved OpenRouter key on %s', async (platform, text) => {
    const bridge = createBridge({
      platform,
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      listRecoveryNotices: vi.fn(async () => [{ code: 'OPENROUTER_KEY_UNREADABLE' as const }]),
    })
    renderApp(bridge)

    expect(await screen.findByText(text)).toBeVisible()
  })
})
