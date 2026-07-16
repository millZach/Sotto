import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Onboarding } from '../../../src/renderer/src/features/onboarding/Onboarding'
import {
  MODEL_DOWNLOAD_PRIVACY_NOTICE,
  type ModelDisclosureCatalog,
} from '../../../src/shared/contracts'

afterEach(cleanup)

const disclosures: ModelDisclosureCatalog = Object.freeze({
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
  it('states the offline privacy promise without implying an account, fee, or telemetry', () => {
    render(
      <Onboarding
        microphoneState="idle"
        modelState="ready"
        shortcut="Ctrl+Shift+Space"
        onRequestMicrophone={vi.fn()}
        onComplete={vi.fn()}
      />,
    )

    expect(screen.getByText(/speech stays on this computer/i)).toBeVisible()
    expect(screen.getByText(/free/i)).toBeVisible()
    expect(screen.getByText(/no account/i)).toBeVisible()
    expect(screen.getByText(/no telemetry/i)).toBeVisible()
  })

  it('requests microphone access, displays live level, and provides Windows recovery guidance', async () => {
    const user = userEvent.setup()
    const request = vi.fn()
    render(
      <Onboarding
        microphoneState="denied"
        microphoneLevel={0.42}
        modelState="ready"
        shortcut="Ctrl+Shift+Space"
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
    expect(screen.getByText(/windows settings/i)).toBeVisible()
  })

  it('discloses optional download metadata and requires explicit consent', async () => {
    const user = userEvent.setup()
    const install = vi.fn()
    render(
      <Onboarding
        microphoneState="ready"
        modelState="ready"
        shortcut="Ctrl+Shift+Space"
        disclosures={disclosures}
        onRequestMicrophone={vi.fn()}
        onInstallModel={install}
        onComplete={vi.fn()}
      />,
    )
    await goToStep(user, 3)

    expect(screen.getByText(/balanced model is included and ready/i)).toBeVisible()
    expect(screen.getByText(/ip address and request time/i)).toBeVisible()
    const installFast = screen.getByRole('button', { name: /install fast/i })
    expect(installFast).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: /allow the fast model download/i }))
    await user.click(installFast)
    expect(install).toHaveBeenCalledWith('fast')
  })

  it('prevents duplicate optional downloads and reports a finite start failure', async () => {
    const user = userEvent.setup()
    const start = deferred<void>()
    const install = vi.fn(() => start.promise)
    render(
      <Onboarding
        microphoneState="ready"
        modelState="ready"
        shortcut="Ctrl+Shift+Space"
        disclosures={disclosures}
        onRequestMicrophone={vi.fn()}
        onInstallModel={install}
        onComplete={vi.fn()}
      />,
    )
    await goToStep(user, 3)
    await user.click(screen.getByRole('checkbox', { name: /allow the fast model download/i }))
    await user.click(screen.getByRole('button', { name: /install fast/i }))

    expect(screen.getByRole('button', { name: /starting fast/i })).toBeDisabled()
    expect(install).toHaveBeenCalledOnce()

    start.reject(new Error('private network detail'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/download could not start/i))
    expect(document.body).not.toHaveTextContent('private network detail')
  })

  it('retains progress when navigating back and offers a safe paste test field', async () => {
    const user = userEvent.setup()
    render(
      <Onboarding
        microphoneState="ready"
        modelState="ready"
        shortcut="Ctrl+Shift+Space"
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

  it('disables Finish until both microphone and bundled model are ready', async () => {
    const user = userEvent.setup()
    const complete = vi.fn()
    const { rerender } = render(
      <Onboarding
        microphoneState="denied"
        modelState="ready"
        shortcut="Ctrl+Shift+Space"
        onRequestMicrophone={vi.fn()}
        onComplete={complete}
      />,
    )
    await goToStep(user, 4)
    expect(screen.getByRole('button', { name: /finish setup/i })).toBeDisabled()

    rerender(
      <Onboarding
        microphoneState="ready"
        modelState="ready"
        shortcut="Ctrl+Shift+Space"
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
      <Onboarding
        microphoneState="ready"
        modelState="ready"
        shortcut="Ctrl+Shift+Space"
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

  it.each(['missing', 'error', 'unavailable'] as const)(
    'blocks completion and offers a model retry when Balanced is %s',
    async (modelState) => {
      const user = userEvent.setup()
      const retry = vi.fn()
      render(
        <Onboarding
          microphoneState="ready"
          modelState={modelState}
          shortcut="Ctrl+Shift+Space"
          onRequestMicrophone={vi.fn()}
          onRetryModel={retry}
          onComplete={vi.fn()}
        />,
      )
      await goToStep(user, 3)
      await user.click(screen.getByRole('button', { name: /retry model check/i }))
      expect(retry).toHaveBeenCalledOnce()
      await user.click(screen.getByRole('button', { name: /continue/i }))
      expect(screen.getByRole('button', { name: /finish setup/i })).toBeDisabled()
    },
  )

  it('keeps optional installs disabled when no trusted install handler is supplied', async () => {
    const user = userEvent.setup()
    render(
      <Onboarding
        microphoneState="ready"
        modelState="ready"
        shortcut="Ctrl+Shift+Space"
        disclosures={disclosures}
        onRequestMicrophone={vi.fn()}
        onComplete={vi.fn()}
      />,
    )
    await goToStep(user, 3)
    await user.click(screen.getByRole('checkbox', { name: /allow the fast model download/i }))
    expect(screen.getByRole('button', { name: /install fast/i })).toBeDisabled()
    expect(screen.getByText('Xenova/whisper-tiny')).toBeVisible()
  })

  it.each(['checking', 'missing', 'error', 'unavailable'] as const)(
    'does not claim Balanced is usable when disclosures are unavailable and the model is %s',
    async (modelState) => {
      const user = userEvent.setup()
      render(
        <Onboarding
          microphoneState="ready"
          modelState={modelState}
          shortcut="Ctrl+Shift+Space"
          onRequestMicrophone={vi.fn()}
          onComplete={vi.fn()}
        />,
      )
      await goToStep(user, 3)

      expect(screen.queryByText(/balanced remains local and usable/i)).not.toBeInTheDocument()
      expect(screen.getByText(/optional download details are unavailable/i)).toBeVisible()
    },
  )

  it('awaits completion persistence and preserves the setup when saving fails', async () => {
    const user = userEvent.setup()
    const save = deferred<boolean>()
    const complete = vi.fn(() => save.promise)
    render(
      <Onboarding
        microphoneState="ready"
        modelState="ready"
        shortcut="Ctrl+Shift+Space"
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
})
