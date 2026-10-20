import { baseProps, selectCategory, SOTTO_MODEL, ULTRA_MODEL } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import { DEFAULT_SETTINGS } from '../../../../../src/shared/settings'
import { PARAKEET_ULTRA, PARAKEET_V2, PARAKEET_V3, sottoSpeechModelOption } from '../../../../../src/shared/speechModel'
import type { SottoPlatform } from '../../../../../src/shared/platform'

const picker = (): HTMLSelectElement => screen.getByRole('combobox', { name: 'Speech model' })
const DOWNLOADS = [PARAKEET_V3, PARAKEET_ULTRA, PARAKEET_V2].map((model) => sottoSpeechModelOption(model, false))
const groups = (): string[] => [...picker().querySelectorAll('optgroup')].map(group => group.label)
const options = (): string[] => within(screen.getByRole('combobox', { name: 'Speech model' })).getAllByRole('option').map(option => option.textContent ?? '')

describe('Settings → Transcription speech model', () => {
  it('lists every model Sotto can run here, and names the chosen one with its maker and languages', async () => {
    render(<SettingsView {...baseProps({ speechModels: [SOTTO_MODEL, ULTRA_MODEL], settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, speechModel: ULTRA_MODEL.id } })} />)
    await selectCategory('Transcription')
    expect(options()).toEqual(['Parakeet v3', 'Parakeet Ultra'])
    expect(screen.getByRole('combobox', { name: 'Speech model' })).toHaveValue(ULTRA_MODEL.id)
    expect(screen.getByRole('heading', { level: 3, name: 'Parakeet Ultra' })).toBeVisible()
    expect(screen.getByText('Speech recognition by Moondream, on this computer. 25 European languages.')).toBeVisible()
    expect(screen.getByText(/2\.4 GB on this computer\./)).toBeVisible()
  })

  it('switches dictation to the model picked from the list', async () => {
    const onChooseSpeechModel = vi.fn()
    render(<SettingsView {...baseProps({ speechModels: [SOTTO_MODEL, ULTRA_MODEL], onChooseSpeechModel })} />)
    await selectCategory('Transcription')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Speech model' }), 'Parakeet Ultra')
    expect(onChooseSpeechModel).toHaveBeenCalledExactlyOnceWith(ULTRA_MODEL.id)
  })

  it('asks for a choice while none is made, and offers no download by itself', async () => {
    render(<SettingsView {...baseProps({ speechModel: { state: 'missing' }, speechModels: [ULTRA_MODEL], settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, speechModel: null } })} />)
    await selectCategory('Transcription')
    expect(options()).toEqual(['Choose a model', 'Parakeet Ultra'])
    expect(screen.getByRole('combobox', { name: 'Speech model' })).toHaveValue('')
    expect(screen.getByText('No speech model chosen yet. Choose one above.')).toBeVisible()
    expect(screen.queryByRole('button', { name: /download/i })).toBeNull()
  })

  it('shows the download size on Sotto’s model while it is not on this computer', async () => {
    render(<SettingsView {...baseProps({ speechModel: { state: 'missing' }, speechModels: [{ ...SOTTO_MODEL, installed: false }], settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, speechModel: null } })} />)
    await selectCategory('Transcription')
    expect(options()).toEqual(['Choose a model', 'Parakeet v3, 670 MB'])
  })

  it('says why nothing changed when the chosen model is no longer on this computer', async () => {
    render(<SettingsView {...baseProps({ speechModels: [SOTTO_MODEL], speechModelRefused: true })} />)
    await selectCategory('Transcription')
    expect(screen.getByText('Sotto could not switch to that model, so nothing changed. It may no longer be on this computer; choose it again or another one.')).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'Speech model' })).toHaveAttribute('aria-invalid', 'true')
  })

  it.each(['win32', 'linux'] as const)('offers Sotto\'s three models as downloads with their sizes on %s', async (platform) => {
    render(<SettingsView {...baseProps({ platform, speechModel: { state: 'missing' }, speechModels: DOWNLOADS, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, speechModel: null } })} />)
    await selectCategory('Transcription')
    expect(options()).toEqual(['Choose a model', 'Parakeet v3, 670 MB', 'Parakeet Ultra, 671 MB', 'Parakeet v2, 661 MB'])
    expect(groups()).toEqual(['Download'])
  })

  it('offers what is on a Mac first and a download only of models it does not have', async () => {
    const coreMl = { ...ULTRA_MODEL, name: 'Parakeet Ultra (Core ML)' }
    render(<SettingsView {...baseProps({ platform: 'darwin', speechModels: [coreMl, DOWNLOADS[0]!, DOWNLOADS[2]!], settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, speechModel: coreMl.id } })} />)
    await selectCategory('Transcription')
    expect(options()).toEqual(['Parakeet Ultra (Core ML)', 'Parakeet v3, 670 MB', 'Parakeet v2, 661 MB'])
    expect(groups()).toEqual(['Already on this computer', 'Download'])
  })

  describe.each(['win32', 'linux'] as const)('from the keyboard on %s', (platform: SottoPlatform) => {
    const renderPicker = async (onChooseSpeechModel = vi.fn()) => {
      render(<SettingsView {...baseProps({ platform, speechModel: { state: 'missing' }, speechModels: DOWNLOADS, onChooseSpeechModel, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, speechModel: null } })} />)
      await selectCategory('Transcription')
      picker().focus()
      return onChooseSpeechModel
    }

    it('moves through the closed list with the arrow keys without starting a download', async () => {
      const onChooseSpeechModel = await renderPicker()
      // The key's own change is stopped, so the list never fires a change of its own.
      expect(fireEvent.keyDown(picker(), { key: 'ArrowDown' })).toBe(false)
      expect(picker()).toHaveValue(PARAKEET_V3.id)
      expect(fireEvent.keyDown(picker(), { key: 'ArrowDown' })).toBe(false)
      expect(picker()).toHaveValue(PARAKEET_ULTRA.id)
      expect(fireEvent.keyDown(picker(), { key: 'End' })).toBe(false)
      expect(picker()).toHaveValue(PARAKEET_V2.id)
      expect(fireEvent.keyDown(picker(), { key: 'ArrowUp' })).toBe(false)
      expect(picker()).toHaveValue(PARAKEET_ULTRA.id)
      expect(screen.getByText('Press Enter to download Parakeet Ultra, 671 MB, and switch dictation to it.')).toBeVisible()
      expect(onChooseSpeechModel).not.toHaveBeenCalled()
    })

    it('chooses the model moved to on Enter', async () => {
      const onChooseSpeechModel = await renderPicker()
      fireEvent.keyDown(picker(), { key: 'ArrowDown' })
      fireEvent.keyDown(picker(), { key: 'ArrowDown' })
      expect(fireEvent.keyDown(picker(), { key: 'Enter' })).toBe(false)
      expect(onChooseSpeechModel).toHaveBeenCalledExactlyOnceWith(PARAKEET_ULTRA.id)
    })

    it('goes back to the chosen model on Escape or on leaving the list', async () => {
      const onChooseSpeechModel = await renderPicker()
      fireEvent.keyDown(picker(), { key: 'ArrowDown' })
      expect(fireEvent.keyDown(picker(), { key: 'Escape' })).toBe(false)
      expect(picker()).toHaveValue('')
      fireEvent.keyDown(picker(), { key: 'ArrowDown' })
      fireEvent.blur(picker())
      expect(picker()).toHaveValue('')
      expect(screen.getByText('The model that turns your speech into text. Choosing one switches dictation to it.')).toBeVisible()
      expect(onChooseSpeechModel).not.toHaveBeenCalled()
    })

    it('goes to a model by its first letter without choosing it', async () => {
      const onChooseSpeechModel = await renderPicker()
      expect(fireEvent.keyDown(picker(), { key: 'p' })).toBe(false)
      expect(picker()).toHaveValue(PARAKEET_V3.id)
      fireEvent.keyDown(picker(), { key: 'p' })
      expect(picker()).toHaveValue(PARAKEET_ULTRA.id)
      expect(onChooseSpeechModel).not.toHaveBeenCalled()
    })

    it('still chooses with a click in the open list', async () => {
      const onChooseSpeechModel = await renderPicker()
      await userEvent.selectOptions(picker(), 'Parakeet v2, 661 MB')
      expect(onChooseSpeechModel).toHaveBeenCalledExactlyOnceWith(PARAKEET_V2.id)
    })
  })

  it('leaves the keys to the menu macOS opens, where only Enter or a click chooses', async () => {
    const onChooseSpeechModel = vi.fn()
    render(<SettingsView {...baseProps({ platform: 'darwin', speechModels: DOWNLOADS, onChooseSpeechModel, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, speechModel: null } })} />)
    await selectCategory('Transcription')
    expect(fireEvent.keyDown(picker(), { key: 'ArrowDown' })).toBe(true)
    expect(fireEvent.keyDown(picker(), { key: 'Enter' })).toBe(true)
    expect(onChooseSpeechModel).not.toHaveBeenCalled()
  })
})
