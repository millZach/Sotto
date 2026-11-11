import { createBridge, shell, openPage, renderApp, firstSetupNote, skipSetup } from '../../fixtures/renderer/appHarness'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

describe('Sotto application onboarding integration', () => {
  it('shows the complete management dashboard after onboarding is already complete', async () => {
    renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
    }))
    await openPage('home')

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: /ready when you are/i })).toBeVisible())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Dictate' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab', { name: /agents/i })).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Pages' })).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toHaveTextContent(/parakeet v3 on this computer/i)
  })

  it('names the chosen model at the foot once it is ready', async () => {
    renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true, speechModel: 'fluidaudio:parakeet-ultra' })),
      listSpeechModels: vi.fn(async () => [{ id: 'fluidaudio:parakeet-ultra', name: 'Parakeet Ultra', maker: 'Moondream', languages: '25 European languages', source: 'fluidaudio' as const, installed: true, bytes: 632_314_500 }]),
    }))
    await openPage('home')
    await waitFor(() => expect(screen.getByRole('contentinfo')).toHaveTextContent(/parakeet ultra on this computer/i))
  })

  it('copies a Journal transcript in the Dictate room through the trusted bridge without auto-paste', async () => {
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
    expect(screen.queryByRole('link', { name: 'History' })).not.toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Copy transcript' })[0]!)
    expect(deliverOutput).toHaveBeenCalledWith({ text: 'trusted local transcript', autoPaste: false, pasteDelayMs: 275 })
  })

  it('opens the Dictate room on the Journal search with Ctrl+K from any page', async () => {
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      listHistory: vi.fn(async () => [{ id: 'one', text: 'trusted local transcript', createdAt: 1, durationMs: 10, language: 'en', modelPreset: 'parakeet' as const }]),
    })
    renderApp(bridge)
    await openPage('help')
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })) })
    await waitFor(() => expect(shell.navigation).toBe('home'))
    await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Search transcripts' })).toHaveFocus())
  })

  it('opens a new profile on the real Threads page with setup’s first note over it, and saves setup’s end before the walk closes (ADR-0200)', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn(async (patch) => ({ ...DEFAULT_SETTINGS, ...patch }))
    const { container } = renderApp(createBridge({ updateSettings }))

    await firstSetupNote()
    // There is no setup card and no strip page: the app's own shell is under the note.
    expect(container.querySelector('.app-shell')).toHaveClass('app-shell--page')
    expect(container.querySelectorAll('.app-strip')).toHaveLength(0)
    expect(shell.navigation).toBe('threads')
    await user.click(screen.getByRole('button', { name: 'Skip setup' }))
    // The microphone test never opened the microphone, so dictation waits for Settings' test, as a skipped step did.
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ onboardingComplete: true, microphoneSkipped: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(shell.navigation).toBe('threads')
  })

  it('finishes setup without a microphone and lands in a working shell', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn(async (patch) => ({ ...DEFAULT_SETTINGS, ...patch }))
    renderApp(createBridge({ updateSettings }))

    await skipSetup(user)
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ onboardingComplete: true, microphoneSkipped: true }))
    await waitFor(() => expect(shell.navigation).toBe('threads'))
    act(() => shell.navigate('home'))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: /no microphone is set up/i })).toBeVisible())
    // Everything that is not voice is still one click away. The beta hides the
    // voice coordinator, so the switch offers Dictate and Threads only.
    expect(screen.getByRole('tab', { name: 'Threads' })).toBeVisible()
    expect(screen.queryByRole('tab', { name: /agents/i })).not.toBeInTheDocument()
    // The sidebar's foot carries the other pages as icon links; Threads is the switch's own tab.
    for (const destination of ['Settings', 'Help']) {
      expect(screen.getByRole('link', { name: destination })).toBeVisible()
    }
    expect(screen.queryByRole('link', { name: 'Chats' })).not.toBeInTheDocument()
  })

  it('keeps the note and reports a save failure instead of claiming completion', async () => {
    const user = userEvent.setup()
    renderApp(createBridge({ updateSettings: vi.fn(async () => { throw new Error('private storage detail') }) }))

    await skipSetup(user)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not be saved/i))
    expect(screen.getByRole('dialog', { name: 'Talk to your computer and your coding agents' })).toBeVisible()
    expect(document.body).not.toHaveTextContent('private storage detail')
  })
})

describe('SSH questions during first-run setup', () => {
  it('asks a saved host’s SSH question while setup is showing', async () => {
    const asking = {
      id: '33333333-3333-4333-8333-333333333333', name: 'forge', target: 'zach@forge', identityFile: '', installPath: '~/.local/share/sotto-host',
      dataDirectory: '~/.sotto', enabled: true, phase: 'connecting' as const, prompt: { id: 'passphrase-prompt', kind: 'passphrase' as const, text: 'Enter passphrase for key' },
    }
    const state = { localHostEnabled: true, localHostRunning: true, hosts: [asking] }
    const hosts = { get: vi.fn(async () => state), command: vi.fn(async () => state), onChanged: vi.fn(() => () => undefined) }
    // The question dialog reads the hosts bridge the preload puts on the window.
    Object.assign(window, { sotto: { hosts } })
    try {
      renderApp(createBridge())
      await firstSetupNote()
      await waitFor(() => expect(screen.getAllByRole('dialog').some(dialog => dialog.textContent?.includes('forge'))).toBe(true))
    } finally {
      Reflect.deleteProperty(window, 'sotto')
    }
  })
})

describe('first-run setup’s walk, for whom it shows (ADR-0200)', () => {
  it('never shows for a profile that has finished setup', async () => {
    renderApp(createBridge({ getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })) }))
    await openPage('home')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    act(() => shell.navigate('threads'))
    await waitFor(() => expect(shell.navigation).toBe('threads'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('starts again from Set up Sotto in Help, and ending it there saves nothing', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn(async (patch) => ({ ...DEFAULT_SETTINGS, onboardingComplete: true, ...patch }))
    renderApp(createBridge({ updateSettings, getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })) }))
    await openPage('help')
    await user.click(await screen.findByRole('button', { name: 'Set up Sotto' }))
    await firstSetupNote()
    // The walk opens its first stop's page, the real Threads page.
    await waitFor(() => expect(shell.navigation).toBe('threads'))
    await user.click(screen.getByRole('button', { name: 'Skip setup' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(updateSettings).not.toHaveBeenCalled()
  })
})
