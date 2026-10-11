import { baseProps, selectCategory } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import { DEFAULT_SETTINGS } from '../../../../../src/shared/settings'

describe('SettingsView', () => {
  it('offers no widget theme choice and still saves reduced motion', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Application')

    expect(screen.queryByRole('combobox', { name: 'Theme' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Reduced motion' }), 'on')
    expect(update).toHaveBeenCalledWith({ reducedMotion: 'on' })
    expect(document.documentElement.dataset.reducedMotion).toBe('on')
  })

  it('shows the persisted mode and both theme halves and saves each choice as its own patch', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'light', lightTheme: 'citrine', darkTheme: 'tropic' } })} />)
    await selectCategory('Appearance')
    const section = document.querySelector('#settings-appearance') as HTMLElement

    expect(within(section).getByRole('heading', { level: 2, name: 'Appearance' })).toBeVisible()
    // The scope stays short; checked choices communicate the persisted selections.
    expect(within(section).getByText('Themes & interface')).toBeVisible()
    expect(section).not.toHaveTextContent(/using Citrine/u)
    expect(within(section).queryByRole('radiogroup', { name: 'Accent' })).not.toBeInTheDocument()
    expect(within(within(section).getByRole('radiogroup', { name: 'Color scheme' })).getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true')
    const light = within(section).getByRole('radiogroup', { name: 'Light theme' })
    const dark = within(section).getByRole('radiogroup', { name: 'Dark theme' })
    for (const label of ['Sotto', 'Hush', 'Linen', 'Nocturne', 'Tropic', 'Citrine']) {
      expect(within(light).getByRole('radio', { name: label })).toBeVisible()
      expect(within(dark).getByRole('radio', { name: label })).toBeVisible()
    }
    expect(within(light).getByRole('radio', { name: 'Citrine' })).toHaveAttribute('aria-checked', 'true')
    expect(within(dark).getByRole('radio', { name: 'Tropic' })).toHaveAttribute('aria-checked', 'true')

    await user.click(within(section).getByRole('radio', { name: 'Match Windows' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ appearance: 'system' }))
    await user.click(within(dark).getByRole('radio', { name: 'Linen' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ darkTheme: 'linen' }))
    expect(update).toHaveBeenCalledTimes(2)
  })

  it('reaches the scheme and both halves by keyboard, one Tab stop per group, in reading order', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Appearance')
    const section = document.querySelector('#settings-appearance') as HTMLElement
    const scheme = within(section).getByRole('radiogroup', { name: 'Color scheme' })
    const light = within(section).getByRole('radiogroup', { name: 'Light theme' })
    const dark = within(section).getByRole('radiogroup', { name: 'Dark theme' })

    // Scheme, then the theme actions, then the Light column and the Dark column, each group one stop.
    within(scheme).getByRole('radio', { name: 'Dark' }).focus()
    await user.keyboard('{Tab}')
    expect(within(section).getByRole('button', { name: 'Create theme' })).toHaveFocus()
    await user.keyboard('{Tab}{Tab}')
    expect(within(light).getByRole('radio', { name: 'Sotto' })).toHaveFocus()
    await user.keyboard('{Tab}')
    expect(within(dark).getByRole('radio', { name: 'Sotto' })).toHaveFocus()

    // Arrows choose as they move, and wrap.
    await user.keyboard('{ArrowUp}')
    expect(within(dark).getByRole('radio', { name: 'Citrine' })).toHaveFocus()
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ darkTheme: 'citrine' }))

    within(scheme).getByRole('radio', { name: 'Dark' }).focus()
    await user.keyboard('{ArrowLeft}')
    expect(within(scheme).getByRole('radio', { name: 'Match Windows' })).toHaveFocus()
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ appearance: 'system' }))
  })
})
