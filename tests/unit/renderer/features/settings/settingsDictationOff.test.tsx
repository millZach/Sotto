import { baseProps } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
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
/** Cleanup is a page of its own; the speech model and what happens after dictating are groups on Dictation. */
const DICTATION_PAGES = ['Cleanup']
const DICTATION_GROUPS = ['settings-transcription', 'settings-output']

function tabNames(): string[] {
  return within(screen.getByRole('tablist', { name: 'Settings sections' })).getAllByRole('tab').map(tab => tab.textContent ?? '')
}

describe('SettingsView with dictation off (Owl dictation-off)', () => {
  it('shows no switch while the Owl feature is off, even with dictation saved off', () => {
    const { container } = render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, dictationEnabled: false } })} />)
    expect(screen.queryByRole('switch', { name: /Dictate with Sotto/u })).toBeNull()
    expect(screen.queryByText(NOTE)).toBeNull()
    for (const name of DICTATION_PAGES) expect(tabNames()).toContain(name)
    for (const id of DICTATION_GROUPS) expect(container.querySelector(`#${id}`)).not.toBeNull()
  })

  it('shows the switch on and every section while dictation is on', () => {
    owl.on = true
    render(<SettingsView {...baseProps()} />)
    expect(screen.getByRole('switch', { name: /Dictate with Sotto/u })).toBeChecked()
    expect(screen.queryByText(NOTE)).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Microphone' })).toBeInTheDocument()
    for (const name of DICTATION_PAGES) expect(tabNames()).toContain(name)
  })

  it('hides the other Dictation rows and the dictation sections while dictation is off', () => {
    owl.on = true
    const { container } = render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, dictationEnabled: false } })} />)
    expect(screen.getByRole('switch', { name: /Dictate with Sotto/u })).not.toBeChecked()
    expect(screen.getByText(NOTE)).toBeVisible()
    expect(screen.queryByRole('combobox', { name: 'Microphone' })).toBeNull()
    expect(screen.queryByRole('switch', { name: /Sound cues/u })).toBeNull()
    for (const id of DICTATION_GROUPS) expect(container.querySelector(`#${id}`)).toBeNull()
    // Cleanup leaves with dictation: the thread's own model writing titles, commits and pull requests lives with
    // Threads and Git & worktrees, so it stays.
    for (const name of DICTATION_PAGES) expect(tabNames()).not.toContain(name)
    expect(screen.queryByRole('switch', { name: /AI formatting/u, hidden: true })).toBeNull()
    expect(screen.getByRole('switch', { name: /Generated commit messages/u, hidden: true })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /Generated thread titles/u, hidden: true })).toBeInTheDocument()
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
