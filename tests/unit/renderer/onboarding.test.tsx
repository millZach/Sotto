import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Onboarding } from '../../../src/renderer/src/features/onboarding/Onboarding'
import { platformCopy } from '../../../src/renderer/src/platformCopy'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

afterEach(cleanup)

const keyProps = { settings: DEFAULT_SETTINGS, onUpdateSettings: vi.fn(async () => true), onCheckTranscriptionKey: vi.fn(async () => ({ ok: true as const })) }

async function goToStep(user: ReturnType<typeof userEvent.setup>, step: number): Promise<void> {
  for (let current = 1; current < step; current += 1) {
    await user.click(screen.getByRole('button', { name: /continue/i }))
  }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((done, fail) => { resolve = done; reject = fail })
  return { promise, reject, resolve }
}

describe('first-run onboarding', () => {
  it.each(['idle', 'requesting', 'denied', 'missing', 'error'] as const)('keeps %s at the microphone step until the user explicitly skips', async microphoneState => {
    const complete = vi.fn()
    const user = userEvent.setup()
    render(<Onboarding {...keyProps} microphoneState={microphoneState} shortcut="Ctrl+Shift+Space" platform="win32" onRequestMicrophone={vi.fn()} onComplete={complete} />)
    await goToStep(user, 2)
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    expect(screen.getByText(/Test your microphone or choose Skip for now to continue/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('heading', { name: 'Check your microphone' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Finish setup' }))
    expect(complete).toHaveBeenCalledWith({ microphoneSkipped: true })
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
    await goToStep(user, 2)

    const picker = await screen.findByRole('combobox', { name: 'Microphone' })
    expect(screen.getByRole('option', { name: 'System default' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'MacBook Pro Microphone' })).toHaveValue('mic-builtin')
    expect(screen.getByRole('option', { name: 'C922 Pro Stream Webcam' })).toHaveValue('mic-c922')
    await user.selectOptions(picker, 'mic-c922')
    expect(onUpdateSettings).toHaveBeenCalledWith({ microphoneId: 'mic-c922' })
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
    await goToStep(user, 2)

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Microphone' }), 'mic-c922')
    await user.click(screen.getByRole('button', { name: /retest microphone/i }))

    expect(request).toHaveBeenLastCalledWith('mic-c922')
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
    await goToStep(user, 2)

    expect(screen.getByRole('button', { name: /retest microphone/i })).toBeVisible()
    expect(screen.getByTestId('listening-bars')).toHaveAttribute('data-speaking', 'true')
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
    await goToStep(user, 2)

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
    await goToStep(user, 3)
    expect(screen.getByRole('heading', { name: 'Connect your OpenRouter key' })).toBeVisible()
    expect(screen.getByLabelText('OpenRouter API key')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Verify key' }))
    expect(await screen.findByText('Key verified.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
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
    await goToStep(user, 4)

    const field = screen.getByRole('textbox', { name: /paste test/i })
    await user.type(field, 'kept locally')
    await user.click(screen.getByRole('button', { name: /back/i }))
    await user.click(screen.getByRole('button', { name: /continue/i }))
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
    await goToStep(user, 4)
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
    await goToStep(user, 2)

    await user.click(screen.getByRole('button', { name: /skip for now/i }))
    expect(screen.getByText(/microphone test skipped/i)).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
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
    await goToStep(user, 2)
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
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
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
    expect(screen.getByRole('heading', { name: /check your microphone/i })).toHaveFocus()
    expect(screen.getByText('Step 2 of 4')).toHaveAttribute('aria-live', 'polite')
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
    await goToStep(user, 4)
    await user.click(screen.getByRole('button', { name: /finish setup/i }))
    expect(screen.getByRole('button', { name: /saving setup/i })).toBeDisabled()
    save.resolve(false)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not be saved/i))
    expect(screen.getByRole('heading', { name: /one shortcut/i })).toBeVisible()
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
    await goToStep(user, 2)
    expect(screen.getByText(
      microphoneState === 'denied' ? copy.onboardingMicrophoneDenied : copy.onboardingMicrophoneMissing,
    )).toBeVisible()

    await user.click(screen.getByRole('button', { name: /skip for now/i }))
    await user.click(screen.getByRole('button', { name: /continue/i }))
    await user.click(screen.getByRole('button', { name: /continue/i }))
    expect(screen.getByLabelText('Control+Shift+Space')).toBeVisible()
  })
})
