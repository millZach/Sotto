import { baseProps } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import { DEFAULT_SETTINGS } from '../../../../../src/shared/settings'

const owl = vi.hoisted(() => ({ on: false }))
vi.mock('../../../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'dictation-off' && owl.on,
}))

afterEach(() => {
  cleanup()
  owl.on = false
})

const NOTE = 'Dictation is off. The hotkey is free for other apps and the Dictate room is hidden. Your transcripts, vocabulary and speech model are kept.'
const DICTATION_SECTIONS = ['Transcription', 'Cleanup', 'Output']

function tabNames(): string[] {
  return screen.getAllByRole('tab').map(tab => tab.textContent ?? '')
}

describe('SettingsView with dictation off (Owl dictation-off)', () => {
  it('shows no switch while the Owl feature is off, even with dictation saved off', () => {
    const { container } = render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, dictationEnabled: false } })} />)
    expect(screen.queryByRole('switch', { name: /Dictate with Sotto/u })).toBeNull()
    expect(screen.queryByText(NOTE)).toBeNull()
    for (const name of DICTATION_SECTIONS) expect(tabNames()).toContain(name)
    expect(container.querySelector('#settings-transcription')).not.toBeNull()
  })

  it('shows the switch on and every section while dictation is on', () => {
    owl.on = true
    render(<SettingsView {...baseProps()} />)
    expect(screen.getByRole('switch', { name: /Dictate with Sotto/u })).toBeChecked()
    expect(screen.queryByText(NOTE)).toBeNull()
    expect(screen.getByLabelText('Microphone')).toBeInTheDocument()
    for (const name of DICTATION_SECTIONS) expect(tabNames()).toContain(name)
  })

  it('hides the other Dictation rows and the dictation sections while dictation is off', () => {
    owl.on = true
    const { container } = render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, dictationEnabled: false } })} />)
    expect(screen.getByRole('switch', { name: /Dictate with Sotto/u })).not.toBeChecked()
    expect(screen.getByText(NOTE)).toBeVisible()
    expect(screen.queryByLabelText('Microphone')).toBeNull()
    expect(screen.queryByRole('switch', { name: /Sound cues/u })).toBeNull()
    for (const name of ['Transcription', 'Output']) expect(tabNames()).not.toContain(name)
    for (const id of ['settings-transcription', 'settings-output']) expect(container.querySelector(`#${id}`)).toBeNull()
    // Cleanup stays for the thread drafting toggles; its dictation rows go.
    expect(tabNames()).toContain('Cleanup')
    expect(screen.queryByRole('switch', { name: /AI formatting/u })).toBeNull()
    expect(screen.getByRole('switch', { name: /Generated commit messages/u, hidden: true })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: /Show floating widget when idle/u })).toBeNull()
  })

  it('saves the switch', async () => {
    owl.on = true
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await userEvent.setup().click(screen.getByRole('switch', { name: /Dictate with Sotto/u }))
    expect(update).toHaveBeenCalledWith({ dictationEnabled: false })
  })
})
