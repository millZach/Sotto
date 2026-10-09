import { deferred, baseProps, selectCategory } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import { TRANSCRIPTION_PRIVACY_NOTICE, type TranscriptionKeyCheck } from '../../../../../src/shared/contracts'
import { DEFAULT_SETTINGS } from '../../../../../src/shared/settings'

describe('SettingsView', () => {
  it('retains the credential draft and in-flight verification across category navigation', async () => {
    const user = userEvent.setup()
    const pending = deferred<boolean>()
    const check = vi.fn(async () => ({ ok: true as const }))
    const update = vi.fn(() => pending.promise)
    render(<SettingsView {...baseProps({ onUpdateSettings: update, onCheckTranscriptionKey: check })} />)
    await selectCategory('Transcription')
    const draft = crypto.randomUUID()
    await user.type(screen.getByLabelText('OpenRouter API key'), draft)
    await user.click(screen.getByRole('button', { name: 'Verify key' }))
    await selectCategory('Output')
    await selectCategory('Transcription')
    expect(screen.getByLabelText('OpenRouter API key')).toHaveValue(draft)
    expect(screen.getByRole('button', { name: 'Verifying...' })).toBeDisabled()
    expect(update).toHaveBeenCalledOnce()
    expect(check).not.toHaveBeenCalled()
    await selectCategory('Output')
    pending.resolve(true)
    await waitFor(() => expect(check).toHaveBeenCalledOnce())
    await selectCategory('Transcription')
    expect(screen.getByText('Key verified.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Verify key' })).toBeEnabled()
  })

  it('shows only MAI and puts its shared key and verification in Transcription', async () => {
    const { container } = render(<SettingsView {...baseProps()} />)
    await selectCategory('Transcription')
    const section = container.querySelector('#settings-transcription') as HTMLElement
    expect(within(section).getByLabelText('OpenRouter API key')).toHaveAttribute('type', 'password')
    expect(within(section).getByRole('button', { name: 'Verify key' })).toBeVisible()
    expect(within(section).getByText('Language & speech to text')).toBeVisible()
    expect(container.querySelectorAll('.settings-model-statement')).toHaveLength(1)
    expect(container.querySelectorAll('.settings-model-card')).toHaveLength(0)
    expect(within(section).getByRole('heading', { name: 'MAI-Transcribe-2' })).toBeVisible()
    expect(within(section).getByText(TRANSCRIPTION_PRIVACY_NOTICE)).toBeVisible()
    expect(within(container.querySelector('#settings-formatting') as HTMLElement).queryByLabelText('OpenRouter API key')).toBeNull()
    expect(screen.queryByRole('button', { name: /install.*model|test connection/i })).toBeNull()
    expect(screen.queryByLabelText('Transcription server')).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Use the transcription server' })).toBeNull()
  })

  it.each([
    [{ ok: true }, 'Key verified.'],
    [{ ok: false, reason: 'unauthorized' }, 'OpenRouter rejected this key.'],
    [{ ok: false, reason: 'unconfigured' }, 'Enter your OpenRouter API key first.'],
    [{ ok: false, reason: 'network' }, 'Could not reach OpenRouter.'],
    [{ ok: false, reason: 'timeout' }, 'Could not reach OpenRouter.'],
    [{ ok: false, reason: 'http' }, 'OpenRouter returned an error.'],
  ] as const)('shows the verification result %j', async (result, message) => {
    const user = userEvent.setup()
    render(<SettingsView {...baseProps({ onCheckTranscriptionKey: vi.fn(async (): Promise<TranscriptionKeyCheck> => result) })} />)
    await selectCategory('Transcription')
    await user.click(screen.getByRole('button', { name: 'Verify key' }))
    expect(await screen.findByText(message)).toBeVisible()
  })

  it('awaits draft persistence before checking', async () => {
    const user = userEvent.setup()
    const pending = deferred<boolean>()
    const update = vi.fn(() => pending.promise)
    const check = vi.fn(async () => ({ ok: true as const }))
    render(<SettingsView {...baseProps({ onUpdateSettings: update, onCheckTranscriptionKey: check })} />)
    await selectCategory('Transcription')
    // A generated inert value exercises credential plumbing without storing any key in a fixture.
    await user.type(screen.getByLabelText('OpenRouter API key'), crypto.randomUUID())
    await user.click(screen.getByRole('button', { name: 'Verify key' }))
    expect(update).toHaveBeenCalledOnce()
    expect(check).not.toHaveBeenCalled()
    pending.resolve(true)
    expect(await screen.findByText('Key verified.')).toBeVisible()
    expect(check).toHaveBeenCalledOnce()
  })

  it('keeps the saved placeholder through verification and credential replacement', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    const stored = 'Saved in your operating system credential store'
    render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, llmApiKey: stored }, onUpdateSettings: update })} />)
    await selectCategory('Transcription')
    // The saved key shows as a state, never as the placeholder sentence itself.
    expect(screen.getByLabelText('OpenRouter API key')).toHaveValue('')
    expect(screen.getByLabelText('OpenRouter API key')).toHaveAttribute('placeholder', 'Key saved')
    await user.click(screen.getByRole('button', { name: 'Verify key' }))
    expect(await screen.findByText('Key verified.')).toBeVisible()
    expect(update).not.toHaveBeenCalled()
    await user.clear(screen.getByLabelText('OpenRouter API key'))
    await user.type(screen.getByLabelText('OpenRouter API key'), crypto.randomUUID())
    await user.click(screen.getByRole('button', { name: 'Verify key' }))
    expect(await screen.findByText('Key verified.')).toBeVisible()
    expect(screen.getByLabelText('OpenRouter API key')).toHaveAttribute('placeholder', 'Key saved')
  })

  it('preserves newer typing and suppresses a stale verification result during a save', async () => {
    const user = userEvent.setup()
    const pending = deferred<boolean>()
    const check = vi.fn(async () => ({ ok: true as const }))
    const props = baseProps({ onUpdateSettings: vi.fn(() => pending.promise), onCheckTranscriptionKey: check })
    const rendered = render(<SettingsView {...props} />)
    await selectCategory('Transcription')
    const input = screen.getByLabelText('OpenRouter API key')
    await user.type(input, crypto.randomUUID())
    await user.click(screen.getByRole('button', { name: 'Verify key' }))
    await user.clear(input)
    const newer = crypto.randomUUID()
    await user.type(input, newer)
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, llmApiKey: 'Saved in your operating system credential store' }} />)
    pending.resolve(true)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verify key' })).toBeEnabled())
    expect((input as HTMLInputElement).value === newer).toBe(true)
    expect(check).not.toHaveBeenCalled()
  })

  it('does not verify a draft that failed to save', async () => {
    const user = userEvent.setup()
    const check = vi.fn(async () => ({ ok: true as const }))
    render(<SettingsView {...baseProps({ onUpdateSettings: vi.fn(async () => false), onCheckTranscriptionKey: check })} />)
    await selectCategory('Transcription')
    await user.type(screen.getByLabelText('OpenRouter API key'), crypto.randomUUID())
    await user.click(screen.getByRole('button', { name: 'Verify key' }))
    expect(await screen.findByText('The API key could not be saved.')).toBeVisible()
    expect(check).not.toHaveBeenCalled()
  })
})

it('explains a failed secure key migration beside the Settings key field until a key is saved', () => {
  const props = baseProps({ openRouterKeyMigrationFailed: true })
  const view = render(<SettingsView {...props} />)
  expect(screen.getByText('The OpenRouter key could not be stored securely. Enter it again.')).toBeInTheDocument()
  view.rerender(<SettingsView {...props} settings={{ ...DEFAULT_SETTINGS, llmApiKey: 'Saved in your operating system credential store' }} />)
  expect(screen.queryByText('The OpenRouter key could not be stored securely. Enter it again.')).not.toBeInTheDocument()
})
