import { deferred } from '../../fixtures/deferred'
import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Onboarding } from '../../../src/renderer/src/features/onboarding/Onboarding'
import { platformCopy } from '../../../src/renderer/src/platformCopy'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

afterEach(cleanup)

const keyProps = { settings: DEFAULT_SETTINGS, onUpdateSettings: vi.fn(async () => true), onCheckTranscriptionKey: vi.fn(async () => ({ ok: true as const })) }

/** Steps forward from wherever setup starts to the 1-indexed step named, clicking whichever forward
 * button each step shows: "Get started" on Welcome, else "Continue" or "Skip for now". */
async function goToStep(user: ReturnType<typeof userEvent.setup>, step: number): Promise<void> {
  for (let current = 1; current < step; current += 1) {
    const button = current === 1
      ? screen.getByRole('button', { name: 'Get started' })
      : screen.getByRole('button', { name: /^(continue|skip for now)$/i })
    await user.click(button)
  }
}

/** Steps forward, from wherever setup is, until Finish setup is on screen (the last, iPhone step). */
async function advanceToFinish(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  while (screen.queryByRole('button', { name: /finish setup/i }) === null) {
    await user.click(screen.getByRole('button', { name: /^(continue|skip for now)$/i }))
  }
}



describe('first-run onboarding', () => {
  it.each(['idle', 'requesting', 'denied', 'missing', 'error'] as const)('keeps %s at the microphone step until the user explicitly skips', async microphoneState => {
    const complete = vi.fn()
    const user = userEvent.setup()
    render(<Onboarding {...keyProps} microphoneState={microphoneState} shortcut="Ctrl+Shift+Space" platform="win32" onRequestMicrophone={vi.fn()} onComplete={complete} />)
    await goToStep(user, 3)
    expect(screen.getByRole('heading', { name: 'Check your microphone' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    expect(screen.getByText('Sotto opens the microphone only while you dictate or run this test.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('heading', { name: 'Choose how Sotto looks' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('heading', { name: 'Check your microphone' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(screen.getByRole('heading', { name: 'Connect your OpenRouter key' })).toBeVisible()
    await advanceToFinish(user)
    await user.click(screen.getByRole('button', { name: 'Finish setup' }))
    expect(complete).toHaveBeenCalledWith({ microphoneSkipped: true })
  })

  it('explains Hyprland dictation and paste on Linux instead of the global shortcut', async () => {
    const user = userEvent.setup()
    render(<Onboarding {...keyProps} microphoneState="ready" shortcut="CommandOrControl+Shift+Space" platform="linux" onRequestMicrophone={vi.fn()} onComplete={vi.fn()} />)
    expect(screen.getByText(/Hold F9 to talk after installing Sotto’s compositor bindings in Hyprland/)).toBeVisible()
    expect(screen.queryByText(/wherever you were typing/)).toBeNull()
    await goToStep(user, 5)
    expect(screen.getByRole('heading', { name: 'Speak, then paste into any window' })).toBeVisible()
    expect(screen.getByText(/Hold F9 to talk, or press Super\+Ctrl\+X to start and stop/)).toBeVisible()
    expect(screen.getByText('Omarchy defaults')).toBeVisible()
    expect(screen.getByText('F9 · Super+Ctrl+X')).toBeVisible()
  })

  it('states the hosted transcription privacy boundary', () => {
    render(
      <Onboarding {...keyProps}
        microphoneState="idle"
        shortcut="Ctrl+Shift+Space"
        platform="win32"
        onRequestMicrophone={vi.fn()}
        onComplete={vi.fn()}
      />,
    )

    expect(screen.getByText(/Microsoft MAI-Transcribe-2 through OpenRouter/i)).toBeVisible()
    expect(screen.getByText(/Audio leaves this computer only while you dictate/i)).toBeVisible()
    expect(screen.getByText(/no Sotto account/i)).toBeVisible()
    expect(screen.getByText(/no telemetry/i)).toBeVisible()
  })

  it('has no Back button on Welcome and advances with Get started', () => {
    render(
      <Onboarding {...keyProps}
        microphoneState="idle"
        shortcut="Ctrl+Shift+Space"
        platform="win32"
        onRequestMicrophone={vi.fn()}
        onComplete={vi.fn()}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Talk to your computer and your coding agents' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Get started' })).toBeVisible()
  })

  it('lists detected inputs on the microphone step and saves the chosen device', async () => {
    const user = userEvent.setup()
    const onUpdateSettings = vi.fn(async () => true)
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [
        { deviceId: 'mic-builtin', groupId: 'a', kind: 'audioinput' as const, label: 'MacBook Pro Microphone', toJSON: () => ({}) },
        { deviceId: 'mic-c922', groupId: 'b', kind: 'audioinput' as const, label: 'C922 Pro Stream Webcam', toJSON: () => ({}) },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    render(
      <Onboarding
        {...keyProps}
        onUpdateSettings={onUpdateSettings}
        microphoneState="idle"
        shortcut="Control+Shift+Space"
        platform="darwin"
        mediaDevices={mediaDevices}
        onRequestMicrophone={vi.fn()}
        onComplete={vi.fn()}
      />,
    )
    await goToStep(user, 3)

    const picker = await screen.findByRole('combobox', { name: 'Microphone' })
    expect(screen.getByRole('option', { name: 'System default' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'MacBook Pro Microphone' })).toHaveValue('mic-builtin')
    expect(screen.getByRole('option', { name: 'C922 Pro Stream Webcam' })).toHaveValue('mic-c922')
    await user.selectOptions(picker, 'mic-c922')
    expect(onUpdateSettings).toHaveBeenCalledWith({ microphoneId: 'mic-c922' })
  })

  it('opens the microphone only from the test button, never from a picker change', async () => {
    const user = userEvent.setup()
    const request = vi.fn()
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [
        { deviceId: 'mic-builtin', groupId: 'a', kind: 'audioinput' as const, label: 'MacBook Pro Microphone', toJSON: () => ({}) },
        { deviceId: 'mic-c922', groupId: 'b', kind: 'audioinput' as const, label: 'C922 Pro Stream Webcam', toJSON: () => ({}) },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    render(
      <Onboarding
        {...keyProps}
        microphoneState="idle"
        shortcut="Control+Shift+Space"
        platform="darwin"
        mediaDevices={mediaDevices}
        onRequestMicrophone={request}
        onComplete={vi.fn()}
      />,
    )
    await goToStep(user, 3)

    const picker = await screen.findByRole('combobox', { name: 'Microphone' })
    await user.selectOptions(picker, 'mic-builtin')
    await user.selectOptions(picker, 'mic-c922')
    expect(request).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Test microphone' }))
    expect(request).toHaveBeenCalledExactlyOnceWith('mic-c922')
  })

  it('retires the previous input\'s test when another input is chosen, without opening the new one', async () => {
    const user = userEvent.setup()
    const request = vi.fn()
    const reset = vi.fn()
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [
        { deviceId: 'mic-builtin', groupId: 'a', kind: 'audioinput' as const, label: 'MacBook Pro Microphone', toJSON: () => ({}) },
        { deviceId: 'mic-c922', groupId: 'b', kind: 'audioinput' as const, label: 'C922 Pro Stream Webcam', toJSON: () => ({}) },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    render(
      <Onboarding
        {...keyProps}
        microphoneState="ready"
        shortcut="Control+Shift+Space"
        platform="darwin"
        mediaDevices={mediaDevices}
        onRequestMicrophone={request}
        onResetMicrophone={reset}
        onComplete={vi.fn()}
      />,
    )
    await goToStep(user, 3)

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Microphone' }), 'mic-c922')
    expect(reset).toHaveBeenCalledOnce()
    expect(request).not.toHaveBeenCalled()
  })

  it('says so and goes back to the saved microphone when the choice cannot be saved', async () => {
    const user = userEvent.setup()
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [
        { deviceId: 'mic-builtin', groupId: 'a', kind: 'audioinput' as const, label: 'MacBook Pro Microphone', toJSON: () => ({}) },
        { deviceId: 'mic-c922', groupId: 'b', kind: 'audioinput' as const, label: 'C922 Pro Stream Webcam', toJSON: () => ({}) },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    render(
      <Onboarding
        {...keyProps}
        settings={{ ...DEFAULT_SETTINGS, microphoneId: 'mic-builtin' }}
        onUpdateSettings={vi.fn(async () => false)}
        microphoneState="idle"
        shortcut="Control+Shift+Space"
        platform="darwin"
        mediaDevices={mediaDevices}
        onRequestMicrophone={vi.fn()}
        onComplete={vi.fn()}
      />,
    )
    await goToStep(user, 3)

    const picker = await screen.findByRole('combobox', { name: 'Microphone' })
    await user.selectOptions(picker, 'mic-c922')

    expect(await screen.findByText('Sotto could not save that microphone. The previous one is still selected.')).toBeVisible()
    expect(picker).toHaveValue('mic-builtin')
  })

  it('retests the microphone just chosen before that choice is saved', async () => {
    const user = userEvent.setup()
    const request = vi.fn()
    const pending = deferred<boolean>()
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [
        { deviceId: 'mic-builtin', groupId: 'a', kind: 'audioinput' as const, label: 'MacBook Pro Microphone', toJSON: () => ({}) },
        { deviceId: 'mic-c922', groupId: 'b', kind: 'audioinput' as const, label: 'C922 Pro Stream Webcam', toJSON: () => ({}) },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    render(
      <Onboarding
        {...keyProps}
        settings={{ ...DEFAULT_SETTINGS, microphoneId: 'mic-builtin' }}
        onUpdateSettings={() => pending.promise}
        microphoneState="ready"
        shortcut="Control+Shift+Space"
        platform="darwin"
        mediaDevices={mediaDevices}
        onRequestMicrophone={request}
        onComplete={vi.fn()}
      />,
    )
    await goToStep(user, 3)

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Microphone' }), 'mic-c922')
    await user.click(screen.getByRole('button', { name: 'Test microphone' }))

    expect(request).toHaveBeenCalledExactlyOnceWith('mic-c922')
    pending.resolve(true)
  })

  it('keeps the microphone test wave running while the stream is open, even in silence', async () => {
    const user = userEvent.setup()
    render(
      <Onboarding
        {...keyProps}
        microphoneState="ready"
        microphoneLevel={0}
        shortcut="Control+Shift+Space"
        platform="darwin"
        onRequestMicrophone={vi.fn()}
        onComplete={vi.fn()}
      />,
    )
    await goToStep(user, 3)
    await user.click(screen.getByRole('button', { name: 'Test microphone' }))

    expect(screen.getByText('Listening. Say something.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Stop test' })).toBeVisible()
    expect(screen.getByTestId('listening-bars')).toHaveAttribute('data-speaking', 'true')
  })

  it('passes the test only once it hears a voice, then closes the microphone and offers Continue', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      const stop = vi.fn()
      const props = { ...keyProps, shortcut: 'Ctrl+Shift+Space', platform: 'win32' as const, onRequestMicrophone: vi.fn(), onStopMicrophone: stop, onComplete: vi.fn() }
      const { rerender } = render(<Onboarding {...props} microphoneState="idle" />)
      await goToStep(user, 3)
      // Every step but this one closes the microphone as it shows; count only what the test itself does.
      stop.mockClear()
      expect(screen.getByText('Not tested yet.')).toBeVisible()
      await user.click(screen.getByRole('button', { name: 'Test microphone' }))
      expect(props.onRequestMicrophone).toHaveBeenCalledOnce()

      // Access confirmed but silence: still listening, and moving on is still a skip.
      rerender(<Onboarding {...props} microphoneState="ready" microphoneLevel={0} />)
      await act(async () => { vi.advanceTimersByTime(1_000) })
      expect(screen.getByText('Listening. Say something.')).toBeVisible()
      expect(screen.getByRole('button', { name: 'Skip for now' })).toBeVisible()
      expect(stop).not.toHaveBeenCalled()

      rerender(<Onboarding {...props} microphoneState="ready" microphoneLevel={0.3} />)
      await act(async () => { vi.advanceTimersByTime(400) })
      expect(screen.getByText('Sotto heard you. Your microphone works.')).toBeVisible()
      expect(screen.getByRole('button', { name: 'Continue' })).toBeVisible()
      expect(screen.getByRole('button', { name: 'Test again' })).toBeVisible()
      expect(screen.queryByRole('meter', { name: 'Microphone level' })).toBeNull()
      expect(stop).toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('keeps focus on the test button while the microphone opens', async () => {
    const user = userEvent.setup()
    const props = { ...keyProps, shortcut: 'Ctrl+Shift+Space', platform: 'win32' as const, onRequestMicrophone: vi.fn(), onComplete: vi.fn() }
    const { rerender } = render(<Onboarding {...props} microphoneState="idle" />)
    await goToStep(user, 3)
    screen.getByRole('button', { name: 'Test microphone' }).focus()
    await user.keyboard('{Enter}')
    rerender(<Onboarding {...props} microphoneState="requesting" />)
    const button = screen.getByRole('button', { name: 'Test microphone' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(props.onRequestMicrophone).toHaveBeenCalledOnce()
    rerender(<Onboarding {...props} microphoneState="ready" />)
    expect(screen.getByRole('button', { name: 'Stop test' })).toHaveFocus()
  })

  it('stops the test on Stop test, and starts over when another microphone is chosen after it heard a voice', async () => {
    const user = userEvent.setup()
    const stop = vi.fn()
    const reset = vi.fn()
    const mediaDevices = {
      enumerateDevices: vi.fn(async () => [
        { deviceId: 'mic-builtin', groupId: 'a', kind: 'audioinput' as const, label: 'Built-in Microphone', toJSON: () => ({}) },
        { deviceId: 'mic-usb', groupId: 'b', kind: 'audioinput' as const, label: 'USB Microphone', toJSON: () => ({}) },
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    const props = { ...keyProps, shortcut: 'Ctrl+Shift+Space', platform: 'win32' as const, mediaDevices, onRequestMicrophone: vi.fn(), onStopMicrophone: stop, onResetMicrophone: reset, onComplete: vi.fn() }
    const { rerender } = render(<Onboarding {...props} microphoneState="ready" microphoneLevel={0} />)
    await goToStep(user, 3)
    stop.mockClear()
    await user.click(screen.getByRole('button', { name: 'Test microphone' }))
    const button = screen.getByRole('button', { name: 'Stop test' })
    await user.click(button)
    expect(stop).toHaveBeenCalledOnce()
    // The one button changes with the test, so focus stays on it.
    expect(screen.getByRole('button', { name: 'Test microphone' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Test microphone' }))
    rerender(<Onboarding {...props} microphoneState="ready" microphoneLevel={0.5} />)
    expect(await screen.findByText('Sotto heard you. Your microphone works.')).toBeVisible()
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Microphone' }), 'mic-usb')
    expect(reset).toHaveBeenCalled()
    expect(screen.getByText('Not tested yet.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeVisible()
  })

  it('says when it has heard nothing for a while', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<Onboarding {...keyProps} microphoneState="ready" microphoneLevel={0} shortcut="Ctrl+Shift+Space" platform="win32" onRequestMicrophone={vi.fn()} onComplete={vi.fn()} />)
      await goToStep(user, 3)
      await user.click(screen.getByRole('button', { name: 'Test microphone' }))
      expect(screen.getByText('Listening. Say something.')).toBeVisible()
      await act(async () => { vi.advanceTimersByTime(6_100) })
      expect(screen.getByText('Nothing heard yet.')).toBeVisible()
      expect(screen.getByText('Check that the microphone above is the one you speak into, then say something.')).toBeVisible()
    } finally { vi.useRealTimers() }
  })

  it('keeps the wave still while access is still being asked for', async () => {
    const user = userEvent.setup()
    render(
      <Onboarding
        {...keyProps}
        microphoneState="requesting"
        microphoneLevel={0}
        shortcut="Control+Shift+Space"
        platform="darwin"
        onRequestMicrophone={vi.fn()}
        onComplete={vi.fn()}
      />,
    )
    await goToStep(user, 3)

    expect(screen.getByTestId('listening-bars')).not.toHaveAttribute('data-speaking')
  })

  it('requests microphone access, displays live level, and provides Windows recovery guidance', async () => {
    const user = userEvent.setup()
    const request = vi.fn()
    const view = render(
      <Onboarding {...keyProps}
        microphoneState="denied"
        microphoneLevel={0.42}
        shortcut="Ctrl+Shift+Space"
        platform="win32"
        onRequestMicrophone={request}
        onComplete={vi.fn()}
      />,
    )
    await goToStep(user, 3)

    await user.click(screen.getByRole('button', { name: /try microphone again/i }))
    expect(request).toHaveBeenCalledOnce()
    // Denied, there is no stream to report: the wave rests and is not a live meter.
    expect(screen.queryByRole('meter', { name: /microphone level/i })).toBeNull()
    expect(screen.getByText(platformCopy('win32').onboardingMicrophoneDenied)).toBeVisible()
    // Once the test's stream runs the same wave the widget shows reports the level.
    view.rerender(
      <Onboarding {...keyProps}
        microphoneState="ready"
        microphoneLevel={0.42}
        shortcut="Ctrl+Shift+Space"
        platform="win32"
        onRequestMicrophone={request}
        onComplete={vi.fn()}
      />,
    )
    expect(screen.getByRole('meter', { name: /microphone level/i })).toHaveAttribute(
      'aria-valuenow',
      '0.42',
    )
  })

  it('offers the key step and can advance and finish without a key', async () => {
    const user = userEvent.setup()
    const complete = vi.fn()
    render(<Onboarding {...keyProps} microphoneState="ready" shortcut="Ctrl+Shift+Space" platform="win32" onRequestMicrophone={vi.fn()} onComplete={complete} />)
    await goToStep(user, 4)
    expect(screen.getByRole('heading', { name: 'Connect your OpenRouter key' })).toBeVisible()
    expect(screen.getByLabelText('OpenRouter API key')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Verify key' }))
    expect(await screen.findByText('Key verified.')).toBeVisible()
    // The key is still empty, so the step is not done: the forward button offers to skip it, not continue.
    await user.click(screen.getByRole('button', { name: 'Skip for now' }))
    await advanceToFinish(user)
    await user.click(screen.getByRole('button', { name: 'Finish setup' }))
    expect(complete).toHaveBeenCalledOnce()
  })

  it('retains progress when navigating back and offers a safe paste test field', async () => {
    const user = userEvent.setup()
    render(
      <Onboarding {...keyProps}
        microphoneState="ready"
        shortcut="Ctrl+Shift+Space"
        platform="win32"
        onRequestMicrophone={vi.fn()}
        onComplete={vi.fn()}
      />,
    )
    await goToStep(user, 5)

    const field = screen.getByRole('textbox', { name: /paste test/i })
    await user.type(field, 'kept locally')
    await user.click(screen.getByRole('button', { name: /back/i }))
    await user.click(screen.getByRole('button', { name: /^(continue|skip for now)$/i }))
    expect(screen.getByRole('textbox', { name: /paste test/i })).toHaveValue('kept locally')
    expect(screen.getByLabelText('Ctrl+Shift+Space')).toBeVisible()
  })

  it('still guards Finish if a previously ready microphone becomes unavailable', async () => {
    const user = userEvent.setup()
    const complete = vi.fn()
    const { rerender } = render(
      <Onboarding {...keyProps}
        microphoneState="ready"
        shortcut="Ctrl+Shift+Space"
        platform="win32"
        onRequestMicrophone={vi.fn()}
        onComplete={complete}
      />,
    )
    await goToStep(user, 9)
    rerender(<Onboarding {...keyProps} microphoneState="denied" shortcut="Ctrl+Shift+Space" platform="win32" onRequestMicrophone={vi.fn()} onComplete={complete} />)
    expect(screen.getByRole('button', { name: /finish setup/i })).toBeDisabled()

    rerender(
      <Onboarding {...keyProps}
        microphoneState="ready"
        shortcut="Ctrl+Shift+Space"
        platform="win32"
        onRequestMicrophone={vi.fn()}
        onComplete={complete}
      />,
    )
    await user.click(screen.getByRole('button', { name: /finish setup/i }))
    expect(complete).toHaveBeenCalledOnce()
  })

  it('offers Skip for now on the microphone step and finishes setup as skipped', async () => {
    const user = userEvent.setup()
    const complete = vi.fn()
    render(
      <Onboarding {...keyProps}
        microphoneState="missing"
        shortcut="Ctrl+Shift+Space"
        platform="win32"
        onRequestMicrophone={vi.fn()}
        onComplete={complete}
      />,
    )
    await goToStep(user, 3)

    await user.click(screen.getByRole('button', { name: /skip for now/i }))
    // Pressing Skip for now records the skip and advances; the reminder follows onto the shortcut step.
    await user.click(screen.getByRole('button', { name: /^(continue|skip for now)$/i }))
    expect(screen.getByText(/microphone test skipped/i)).toBeVisible()

    await advanceToFinish(user)
    await user.click(screen.getByRole('button', { name: /finish setup/i }))
    expect(complete).toHaveBeenCalledWith({ microphoneSkipped: true })
  })

  it('drops the skip once the microphone tests ready', async () => {
    const user = userEvent.setup()
    const complete = vi.fn()
    const { rerender } = render(
      <Onboarding {...keyProps}
        microphoneState="missing"
        shortcut="Ctrl+Shift+Space"
        platform="win32"
        onRequestMicrophone={vi.fn()}
        onComplete={complete}
      />,
    )
    await goToStep(user, 3)
    await user.click(screen.getByRole('button', { name: /skip for now/i }))

    rerender(
      <Onboarding {...keyProps}
        microphoneState="ready"
        shortcut="Ctrl+Shift+Space"
        platform="win32"
        onRequestMicrophone={vi.fn()}
        onComplete={complete}
      />,
    )
    expect(screen.queryByText(/microphone test skipped/i)).not.toBeInTheDocument()
    await advanceToFinish(user)
    await user.click(screen.getByRole('button', { name: /finish setup/i }))
    expect(complete).toHaveBeenCalledWith({ microphoneSkipped: false })
  })

  it('focuses each step heading and announces progress after keyboard navigation', async () => {
    const user = userEvent.setup()
    render(
      <Onboarding {...keyProps}
        microphoneState="ready"
        shortcut="Ctrl+Shift+Space"
        platform="win32"
        onRequestMicrophone={vi.fn()}
        onComplete={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus()
    await user.tab()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('heading', { name: 'Choose how Sotto looks' })).toHaveFocus()
    expect(screen.getByText('Step 2 of 9 · Look')).toHaveAttribute('aria-live', 'polite')
  })

  it('awaits completion persistence and preserves the setup when saving fails', async () => {
    const user = userEvent.setup()
    const save = deferred<boolean>()
    const complete = vi.fn(() => save.promise)
    render(
      <Onboarding {...keyProps}
        microphoneState="ready"
        shortcut="Ctrl+Shift+Space"
        platform="win32"
        onRequestMicrophone={vi.fn()}
        onComplete={complete}
      />,
    )
    await goToStep(user, 9)
    await user.click(screen.getByRole('button', { name: /finish setup/i }))
    expect(screen.getByRole('button', { name: /saving setup/i })).toBeDisabled()
    save.resolve(false)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not be saved/i))
    expect(screen.getByRole('heading', { name: /answer your threads/i })).toBeVisible()
  })

  it.each(['denied', 'missing'] as const)('gives macOS %s recovery guidance and the darwin shortcut form', async (microphoneState) => {
    const user = userEvent.setup()
    const copy = platformCopy('darwin')
    render(
      <Onboarding {...keyProps}
        microphoneState={microphoneState}
        shortcut="Control+Shift+Space"
        platform="darwin"
        onRequestMicrophone={vi.fn()}
        onComplete={vi.fn()}
      />,
    )
    await goToStep(user, 3)
    expect(screen.getByText(
      microphoneState === 'denied' ? copy.onboardingMicrophoneDenied : copy.onboardingMicrophoneMissing,
    )).toBeVisible()

    await user.click(screen.getByRole('button', { name: /skip for now/i }))
    await user.click(screen.getByRole('button', { name: /^(continue|skip for now)$/i }))
    expect(screen.getByLabelText('Control+Shift+Space')).toBeVisible()
  })

  it('opens the macOS Microphone pane from the blocked microphone step, by keyboard', async () => {
    const user = userEvent.setup()
    const openSystemSettings = vi.fn(async () => ({ ok: true as const }))
    window.sotto = { openSystemSettings } as never
    try {
      render(
        <Onboarding {...keyProps}
          microphoneState="denied"
          shortcut="Control+Shift+Space"
          platform="darwin"
          onRequestMicrophone={vi.fn()}
          onComplete={vi.fn()}
        />,
      )
      await goToStep(user, 3)
      const open = screen.getByRole('button', { name: 'Open System Settings at Privacy & Security, Microphone' })
      expect(open).toHaveTextContent('Open System Settings')
      open.focus()
      await user.keyboard('{Enter}')
      expect(openSystemSettings).toHaveBeenCalledExactlyOnceWith('microphone')
    } finally {
      delete window.sotto
    }
  })
})
