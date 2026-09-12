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
    expect(screen.getByText(/Audio is uploaded only while you dictate/i)).toBeVisible()
    expect(screen.getByText(/no account/i)).toBeVisible()
    expect(screen.getByText(/no telemetry/i)).toBeVisible()
  })

  it('requests microphone access, displays live level, and provides Windows recovery guidance', async () => {
    const user = userEvent.setup()
    const request = vi.fn()
    render(
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
    expect(screen.getByRole('meter', { name: /microphone level/i })).toHaveAttribute(
      'aria-valuenow',
      '0.42',
    )
    expect(screen.getByText(platformCopy('win32').onboardingMicrophoneDenied)).toBeVisible()
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

  it('disables Finish until the microphone is ready', async () => {
    const user = userEvent.setup()
    const complete = vi.fn()
    const { rerender } = render(
      <Onboarding {...keyProps}
        microphoneState="denied"
        shortcut="Ctrl+Shift+Space"
        platform="win32"
        onRequestMicrophone={vi.fn()}
        onComplete={complete}
      />,
    )
    await goToStep(user, 4)
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

    await user.click(screen.getByRole('button', { name: /continue/i }))
    await user.click(screen.getByRole('button', { name: /continue/i }))
    expect(screen.getByLabelText('Control+Shift+Space')).toBeVisible()
  })
})
