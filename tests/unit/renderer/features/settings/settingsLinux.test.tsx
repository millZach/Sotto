import { baseProps, selectCategory } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import { setupBridgeFixture } from '../../../../fixtures/renderer/omarchySetup'
import { UPDATE_CHECK_PRIVACY_NOTICE } from '../../../../../src/shared/contracts'
import { DEFAULT_SETTINGS, defaultSettings } from '../../../../../src/shared/settings'
import { defaultHoldShortcuts, defaultHotkey } from '../../../../../src/shared/platform'

const SHELL_PILL_DESCRIPTION = 'On Omarchy, the owl in the bar replaces the widget. Remove the shell plugin to bring it back.'
const WIDGET_DESCRIPTION = 'Keep the small dictation sliver on screen between sessions. Click it to dictate.'

afterEach(() => { vi.unstubAllGlobals() })

describe('Settings on Linux', () => {
  it('says Sotto never updates itself and offers nothing to press', async () => {
    render(<SettingsView {...baseProps({ platform: 'linux', updateStatus: { currentVersion: '0.1.37', phase: { phase: 'unsupported' }, checkedAt: null } })} />)
    await selectCategory('Application')

    expect(screen.getByText('Sotto never updates itself on Linux. New versions come through pacman.')).toBeVisible()
    expect(screen.getByText('Sotto 0.1.37')).toBeVisible()
    expect(screen.getByText('Install the next sotto-bin package with sudo pacman -U. Once sotto-bin is in a package repository, omarchy update brings it.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Check now' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Check for updates automatically' })).not.toBeInTheDocument()
    expect(screen.queryByText(UPDATE_CHECK_PRIVACY_NOTICE)).not.toBeInTheDocument()
    expect(document.getElementById('settings-updates')).not.toHaveTextContent(/GitHub|Windows/u)
  })

  it.each(['win32', 'darwin'] as const)('keeps %s update checks as they were', async (platform) => {
    render(<SettingsView {...baseProps({ platform, updateStatus: { currentVersion: '3.4.0', phase: { phase: 'unsupported' }, checkedAt: null } })} />)
    await selectCategory('Application')

    expect(screen.getByText('Sotto looks for new releases on GitHub and installs them itself.')).toBeVisible()
    expect(screen.getByText('Update checks run in the installed Windows app and in Sotto Owl on a Mac.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled()
    expect(screen.getByRole('switch', { name: 'Check for updates automatically' })).toBeEnabled()
    expect(screen.queryByText(/pacman/u)).not.toBeInTheDocument()
  })

  it('explains the idle widget row while the shell pill stands in for the widget, and saves nothing', async () => {
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ platform: 'linux', settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, shellPillInUse: true }, onUpdateSettings: update })} />)
    await selectCategory('Dictation')

    const toggle = screen.getByRole('switch', { name: 'Show floating widget when idle' })
    expect(toggle).toBeDisabled()
    expect(toggle).toBeChecked()
    expect(toggle).toHaveAccessibleDescription(SHELL_PILL_DESCRIPTION)
    expect(screen.queryByText(WIDGET_DESCRIPTION)).not.toBeInTheDocument()
    await userEvent.click(toggle)
    expect(update).not.toHaveBeenCalled()
  })

  it('keeps the idle widget row working on Linux without the shell pill', async () => {
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ platform: 'linux', settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, shellPillInUse: false }, onUpdateSettings: update })} />)
    await selectCategory('Dictation')

    const toggle = screen.getByRole('switch', { name: 'Show floating widget when idle' })
    expect(toggle).toBeEnabled()
    expect(toggle).toHaveAccessibleDescription(WIDGET_DESCRIPTION)
    await userEvent.click(toggle)
    expect(update).toHaveBeenCalledWith({ showWidgetWhenIdle: false })
  })

  it.each(['win32', 'darwin'] as const)('never reads the shell pill on %s', async (platform) => {
    render(<SettingsView {...baseProps({ platform, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, shellPillInUse: true } })} />)
    await selectCategory('Dictation')

    const toggle = screen.getByRole('switch', { name: 'Show floating widget when idle' })
    expect(toggle).toBeEnabled()
    expect(toggle).toHaveAccessibleDescription(WIDGET_DESCRIPTION)
  })

  it('offers the three Omarchy pieces and asks main to set them up only on a press', async () => {
    const f = setupBridgeFixture()
    vi.stubGlobal('sotto', { omarchySetup: f.bridge })
    render(<SettingsView {...baseProps({ platform: 'linux', settings: { ...defaultSettings(defaultHotkey('linux'), defaultHoldShortcuts('linux')), onboardingComplete: true } })} />)

    expect(await screen.findByRole('button', { name: 'Set up all three' })).toBeVisible()
    expect(screen.getByText('F9 and Super+Ctrl+X')).toBeVisible()
    expect(screen.getByText('The owl in the bar')).toBeVisible()
    expect(screen.getByText('The Omarchy theme')).toBeVisible()
    // The setup asks for nothing typed; Typing speed elsewhere on the page is a field of its own.
    expect(within(screen.getByLabelText('Omarchy setup')).queryByRole('textbox')).not.toBeInTheDocument()
    expect(f.calls).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'Set up all three' }))
    expect(f.calls).toEqual([{ type: 'setup', pieces: ['keys', 'owl', 'theme'], keys: 'unconfirmed' }])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('explains an unavailable setup bridge without offering a write', async () => {
    vi.stubGlobal('sotto', {})
    render(<SettingsView {...baseProps({ platform: 'linux' })} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Your files were left alone')
    expect(screen.queryByRole('button', { name: 'Set up all three' })).not.toBeInTheDocument()
  })

  it.each(['win32', 'darwin'] as const)('keeps the %s dictation shortcut recorder and offers no setup steps', async (platform) => {
    render(<SettingsView {...baseProps({ platform })} />)

    expect(screen.getByRole('group', { name: 'Press to start and stop' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /setup steps/u })).not.toBeInTheDocument()
    expect(screen.queryByText('Compositor bindings')).not.toBeInTheDocument()
  })
})
