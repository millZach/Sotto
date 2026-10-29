import { baseProps } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import { CLOUD_TRANSCRIPTION_PRIVACY_NOTICE, TRANSCRIPTION_PRIVACY_NOTICE, type CloudSpeechModel, type CloudSpeechModelList } from '../../../../../src/shared/contracts'
import { DEFAULT_SETTINGS, STORED_CREDENTIAL_PLACEHOLDER, type AppSettings } from '../../../../../src/shared/settings'

const owl = vi.hoisted(() => ({ on: true }))
vi.mock('../../../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'cloud-dictation' && owl.on,
}))

afterEach(() => {
  cleanup()
  owl.on = true
})

const model = (id: string, name: string, patch: Partial<CloudSpeechModel> = {}): CloudSpeechModel => ({
  id, name, maker: 'Maker', zdr: true, wer: 0.03, medianMs: 600, usdPerHour: 0.2, scoredBy: 'sotto', ...patch,
})
const MODELS: CloudSpeechModel[] = [
  model('a/first', 'First', { wer: 0.02, medianMs: 500 }),
  model('b/second', 'Second', { zdr: false, usdPerHour: 0.27 }),
  model('c/third', 'Third'),
  model('d/fourth', 'Fourth'),
  model('e/fifth', 'Fifth'),
  model('f/sixth', 'Sixth', { wer: null, medianMs: null, usdPerHour: null, scoredBy: null }),
]

function renderSettings(settings: Partial<AppSettings>, list: () => Promise<CloudSpeechModelList> = async () => ({ ok: true, models: MODELS })) {
  const props = baseProps({ settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, ...settings } })
  const onListCloudSpeechModels = vi.fn(list)
  render(<SettingsView {...props} onListCloudSpeechModels={onListCloudSpeechModels} />)
  return { onUpdateSettings: props.onUpdateSettings, onListCloudSpeechModels }
}

const group = (): HTMLElement => document.getElementById('settings-transcription')!

describe('Transcribe with OpenRouter in Settings → Dictation (Owl cloud-dictation, ADR-0160)', () => {
  it('shows no switch on stable, and the speech model here as before', () => {
    owl.on = false
    renderSettings({ cloudTranscription: true })
    expect(screen.queryByRole('switch', { name: /Transcribe with OpenRouter/u })).toBeNull()
    expect(within(group()).getByText(TRANSCRIPTION_PRIVACY_NOTICE)).toBeInTheDocument()
    expect(within(group()).queryByRole('radiogroup')).toBeNull()
  })

  it('puts the switch first in the Speech model group, off by default, and saves it on', async () => {
    const user = userEvent.setup()
    const { onUpdateSettings, onListCloudSpeechModels } = renderSettings({})
    const toggle = within(group()).getByRole('switch', { name: /Transcribe with OpenRouter/u })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(within(group()).getByText(TRANSCRIPTION_PRIVACY_NOTICE)).toBeInTheDocument()
    expect(onListCloudSpeechModels).not.toHaveBeenCalled()
    await user.click(toggle)
    expect(onUpdateSettings).toHaveBeenCalledWith(expect.objectContaining({ cloudTranscription: true }))
  })

  it('on, asks for a key when none is saved, and lists OpenRouter’s models best first with the top five showing', async () => {
    renderSettings({ cloudTranscription: true })
    expect(within(group()).getByLabelText('OpenRouter API key')).toBeInTheDocument()
    expect(within(group()).getByText(/Transcribing with OpenRouter needs a key/u)).toBeInTheDocument()
    const radios = await within(group()).findAllByRole('radio')
    expect(radios.map((radio) => radio.textContent?.split(' ')[0]?.replace(/^\d/u, ''))).toHaveLength(5)
    expect(radios[0]).toHaveAttribute('aria-checked', 'true')
    expect(radios[0]).toHaveAccessibleDescription(/First by Maker.*0\.5 s.*\$0\.20 per hour.*keeps no audio/u)
    expect(radios[1]).toHaveAccessibleDescription(/Not a zero-retention model/u)
    expect(within(group()).getByText(CLOUD_TRANSCRIPTION_PRIVACY_NOTICE)).toBeInTheDocument()
    expect(within(group()).queryByLabelText('Speech model')).toBeNull()
  })

  it('says the saved key is used when there is one', async () => {
    renderSettings({ cloudTranscription: true, llmApiKey: STORED_CREDENTIAL_PLACEHOLDER })
    expect(within(group()).getByText('Uses the OpenRouter key saved for AI cleanup. Change it in Settings → Cleanup.')).toBeInTheDocument()
    expect(within(group()).queryByLabelText('OpenRouter API key')).toBeNull()
    await within(group()).findAllByRole('radio')
  })

  it('saves a pick by click and by the arrow keys, and shows every model on Show all', async () => {
    const user = userEvent.setup()
    const { onUpdateSettings } = renderSettings({ cloudTranscription: true, llmApiKey: STORED_CREDENTIAL_PLACEHOLDER, cloudSpeechModel: 'c/third' })
    const radios = await within(group()).findAllByRole('radio')
    expect(radios[2]).toHaveAttribute('aria-checked', 'true')
    expect(radios[2]).toHaveAttribute('tabindex', '0')
    expect(radios[0]).toHaveAttribute('tabindex', '-1')
    await user.click(radios[1]!)
    expect(onUpdateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ cloudSpeechModel: 'b/second' }))
    radios[2]!.focus()
    await user.keyboard('{ArrowDown}')
    expect(onUpdateSettings).toHaveBeenLastCalledWith(expect.objectContaining({ cloudSpeechModel: 'd/fourth' }))
    await user.click(within(group()).getByRole('button', { name: 'Show all 6 models' }))
    const all = within(group()).getAllByRole('radio')
    expect(all).toHaveLength(6)
    expect(all[5]).toHaveTextContent('Not tested yet')
  })

  it('hides a row’s tooltip on Escape, and shows it again once focus or the pointer comes back', async () => {
    const user = userEvent.setup()
    renderSettings({ cloudTranscription: true, llmApiKey: STORED_CREDENTIAL_PLACEHOLDER })
    const radios = await within(group()).findAllByRole('radio')
    radios[0]!.focus()
    await user.keyboard('{Escape}')
    expect(radios[0]).toHaveAttribute('data-tip-quiet')
    await user.keyboard('{ArrowDown}')
    expect(radios[0]).not.toHaveAttribute('data-tip-quiet')
    await user.hover(radios[2]!)
    await user.keyboard('{Escape}')
    expect(radios[2]).toHaveAttribute('data-tip-quiet')
    await user.unhover(radios[2]!)
    expect(radios[2]).not.toHaveAttribute('data-tip-quiet')
  })

  it('says when the list cannot be read, changes nothing, and reads it again on Try again', async () => {
    const user = userEvent.setup()
    let fail = true
    const { onUpdateSettings, onListCloudSpeechModels } = renderSettings({ cloudTranscription: true, llmApiKey: STORED_CREDENTIAL_PLACEHOLDER },
      async () => fail ? { ok: false, reason: 'network' } : { ok: true, models: MODELS })
    expect(await within(group()).findByText('OpenRouter’s speech models could not be read. Nothing was changed.')).toBeInTheDocument()
    fail = false
    await user.click(within(group()).getByRole('button', { name: 'Try again' }))
    expect(await within(group()).findAllByRole('radio')).toHaveLength(5)
    expect(onListCloudSpeechModels).toHaveBeenCalledTimes(2)
    expect(onUpdateSettings).not.toHaveBeenCalled()
  })

  it('says when OpenRouter no longer lists the saved model', async () => {
    renderSettings({ cloudTranscription: true, llmApiKey: STORED_CREDENTIAL_PLACEHOLDER, cloudSpeechModel: 'z/gone' })
    expect(await within(group()).findByText('OpenRouter no longer lists z/gone. Dictation will fail until you pick another.')).toBeInTheDocument()
    const radios = within(group()).getAllByRole('radio')
    expect(radios.every((radio) => radio.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(radios[0]).toHaveAttribute('tabindex', '0')
  })
})
