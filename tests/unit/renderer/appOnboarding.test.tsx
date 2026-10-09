import { deferred, createBridge, shell, openPage, renderApp, reachMicrophoneStep, finishRemainingSteps, completeReadySetup, setupThreadsTourTests } from '../../fixtures/renderer/appHarness'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { MicrophoneTestController } from '../../../src/renderer/src/features/onboarding/microphoneTest'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

describe('Sotto application onboarding integration', () => {
  it('shows the complete management dashboard after onboarding is already complete', async () => {
    renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
    }))
    await openPage('home')

    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: /ready when you are/i })).toBeVisible())
    expect(screen.queryByText(/step 1 of 9/i)).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Dictate' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab', { name: /agents/i })).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Pages' })).toBeInTheDocument()
    expect(screen.getByRole('contentinfo')).toHaveTextContent(/add your openrouter api key in settings/i)
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
    await finishRemainingSteps(user)
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
    for (const destination of ['History', 'Settings', 'Help']) {
      expect(screen.getByRole('link', { name: destination })).toBeVisible()
    }
    expect(screen.queryByRole('link', { name: 'Chats' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Threads' }))
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
    expect(screen.getByRole('heading', { name: /answer your threads from your iphone/i })).toBeVisible()
    expect(document.body).not.toHaveTextContent('private storage detail')
  })

  it('uses the saved dictation input when testing during onboarding', async () => {
    const microphone = { start: vi.fn(async () => 'ready' as const), stop: vi.fn(async () => undefined) }
    renderApp(createBridge({ getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, microphoneId: 'saved-headset' })) }), () => microphone)
    await reachMicrophoneStep(userEvent.setup())
    await userEvent.click(screen.getByRole('button', { name: /test microphone/i }))
    await waitFor(() => expect(microphone.start).toHaveBeenCalledWith(expect.any(Function), 'saved-headset', expect.any(Function)))
  })

  it('stops a ready onboarding test and asks for a new one when another input is chosen', async () => {
    const microphone = { start: vi.fn(async () => 'ready' as const), stop: vi.fn(async () => undefined) }
    renderApp(createBridge({ getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, microphoneId: 'saved-headset' })) }), () => microphone)
    const user = userEvent.setup()
    await reachMicrophoneStep(user)
    await user.click(screen.getByRole('button', { name: 'Test microphone' }))
    await screen.findByText(/Microphone ready/i)
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()

    await user.selectOptions(screen.getByRole('combobox', { name: 'Microphone' }), '')

    await waitFor(() => expect(microphone.stop).toHaveBeenCalledOnce())
    expect(microphone.start).toHaveBeenCalledOnce()
    expect(screen.getByText('Run a quick input-level test.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Test microphone' }))
    await screen.findByText(/Microphone ready/i)
    expect(microphone.start).toHaveBeenLastCalledWith(expect.any(Function), undefined, expect.any(Function))
  })

  it('clears a blocked onboarding result when another input is chosen', async () => {
    const microphone = { start: vi.fn(async () => 'denied' as const), stop: vi.fn(async () => undefined) }
    renderApp(createBridge({ getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, microphoneId: 'saved-headset' })) }), () => microphone)
    const user = userEvent.setup()
    await reachMicrophoneStep(user)
    await user.click(screen.getByRole('button', { name: 'Test microphone' }))
    await screen.findByText('Microphone access is blocked.')

    await user.selectOptions(screen.getByRole('combobox', { name: 'Microphone' }), '')

    expect(await screen.findByText('Run a quick input-level test.')).toBeVisible()
    expect(screen.queryByText('Microphone access is blocked.')).not.toBeInTheDocument()
    expect(microphone.start).toHaveBeenCalledOnce()
  })

  it('reports an ended onboarding input and ignores an older ended callback after retry', async () => {
    const ended: Array<(outcome: 'missing') => void> = []
    const start = vi.fn<MicrophoneTestController['start']>(async (onLevel, _id, onEnded) => {
      ended.push(onEnded!)
      onLevel(0.6)
      return 'ready'
    })
    renderApp(createBridge(), () => ({ start, stop: vi.fn(async () => undefined) }))
    await reachMicrophoneStep(userEvent.setup())
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    await screen.findByText(/Microphone ready/i)
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
    act(() => ended[0]!('missing'))
    expect(screen.getByText('No microphone was found.')).toBeVisible()
    expect(screen.queryByRole('meter', { name: 'Microphone level' })).not.toBeInTheDocument()
    expect(document.querySelector('.onboarding-microphone-test .voice-wave')).toHaveAttribute('data-stage', 'idle')
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Try microphone again' }))
    await screen.findByText(/Microphone ready/i)
    act(() => ended[0]!('missing'))
    expect(screen.getByText(/Microphone ready/i)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
    act(() => ended[1]!('missing'))
    expect(screen.getByText('No microphone was found.')).toBeVisible()
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
    await user.click(screen.getByRole('button', { name: /skip for now/i }))
    stopped.resolve()

    await screen.findByRole('heading', { name: /connect your openrouter key/i })
    await act(async () => undefined)
    expect(createMicrophoneTest).toHaveBeenCalledOnce()
    expect(replacement.start).not.toHaveBeenCalled()
    await finishRemainingSteps(user)
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
    await user.click(screen.getByRole('button', { name: /skip for now/i }))
    await waitFor(() => expect(microphone.stop).toHaveBeenCalledOnce())
    started.resolve('ready')

    await screen.findByRole('heading', { name: /connect your openrouter key/i })
    await act(async () => undefined)
    expect(microphone.stop).toHaveBeenCalledOnce()
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
      await screen.findByRole('heading', { level: 1, name: 'Talk to your computer and your coding agents' })
      expect(await screen.findByRole('dialog')).toHaveTextContent('forge')
    } finally {
      Reflect.deleteProperty(window, 'sotto')
    }
  })
})

describe('Threads tour after first-run setup', () => {
  setupThreadsTourTests()

  it('opens the Threads tour on the Threads page right after setup finishes', async () => {
    const user = userEvent.setup()
    renderApp(createBridge())
    await completeReadySetup(user)
    await waitFor(() => expect(shell.navigation).toBe('threads'))
    const dialog = await screen.findByRole('dialog', { name: 'Projects and threads' })
    expect(dialog).toBeVisible()
  })

  it('ends the Threads tour from its note', async () => {
    const user = userEvent.setup()
    renderApp(createBridge())
    await completeReadySetup(user)
    const note = await screen.findByRole('dialog', { name: 'Projects and threads' })
    // This page has no agents bridge, so the tour may have only the parts it can show: Skip tour, or Done on its last stop.
    await user.click(within(note).getByRole('button', { name: /^(Skip tour|Done)$/ }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('dismisses the Threads tour with Escape', async () => {
    const user = userEvent.setup()
    renderApp(createBridge())
    await completeReadySetup(user)
    await screen.findByRole('dialog', { name: 'Projects and threads' })
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('never shows the Threads tour for a profile that is already onboarded', async () => {
    renderApp(createBridge({ getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })) }))
    await openPage('home')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    act(() => shell.navigate('threads'))
    await waitFor(() => expect(shell.navigation).toBe('threads'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
