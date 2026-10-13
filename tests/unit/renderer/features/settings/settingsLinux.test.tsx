import { baseProps, selectCategory } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import { LINUX_BINDINGS_GUIDE_URL, platformCopy } from '../../../../../src/renderer/src/platformCopy'
import { UPDATE_CHECK_PRIVACY_NOTICE } from '../../../../../src/shared/contracts'
import { DEFAULT_SETTINGS } from '../../../../../src/shared/settings'

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
    expect(screen.getByText('Update checks run only in the installed Windows app.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled()
    expect(screen.getByRole('switch', { name: 'Check for updates automatically' })).toBeEnabled()
    expect(screen.queryByText(/pacman/u)).not.toBeInTheDocument()
  })

  it('explains the idle widget row while the shell pill stands in for the widget, and saves nothing', async () => {
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ platform: 'linux', settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, shellPillInUse: true }, onUpdateSettings: update })} />)
    await selectCategory('Application')

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
    await selectCategory('Application')

    const toggle = screen.getByRole('switch', { name: 'Show floating widget when idle' })
    expect(toggle).toBeEnabled()
    expect(toggle).toHaveAccessibleDescription(WIDGET_DESCRIPTION)
    await userEvent.click(toggle)
    expect(update).toHaveBeenCalledWith({ showWidgetWhenIdle: false })
  })

  it.each(['win32', 'darwin'] as const)('never reads the shell pill on %s', async (platform) => {
    render(<SettingsView {...baseProps({ platform, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, shellPillInUse: true } })} />)
    await selectCategory('Application')

    const toggle = screen.getByRole('switch', { name: 'Show floating widget when idle' })
    expect(toggle).toBeEnabled()
    expect(toggle).toHaveAccessibleDescription(WIDGET_DESCRIPTION)
  })

  it('opens the bindings setup steps in the browser and never edits Hyprland itself', async () => {
    const openExternalLink = vi.fn(async () => ({ ok: true as const }))
    vi.stubGlobal('sotto', { openExternalLink })
    render(<SettingsView {...baseProps({ platform: 'linux' })} />)

    expect(screen.getByText('Compositor bindings')).toBeVisible()
    expect(screen.getByText(platformCopy('linux').settingsGlobalShortcutDescription)).toBeVisible()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Open setup steps in your browser' }))
    expect(openExternalLink).toHaveBeenCalledExactlyOnceWith(LINUX_BINDINGS_GUIDE_URL)
    expect(LINUX_BINDINGS_GUIDE_URL).toBe('https://github.com/millZach/Sotto/blob/main/apps/omarchy/README.md#install-the-bindings')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says where the setup steps are when the browser cannot open them', async () => {
    vi.stubGlobal('sotto', { openExternalLink: vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const })) })
    render(<SettingsView {...baseProps({ platform: 'linux' })} />)

    await userEvent.click(screen.getByRole('button', { name: 'Open setup steps in your browser' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(`The setup steps could not open in your browser. They are at ${LINUX_BINDINGS_GUIDE_URL}`)
  })

  it.each(['win32', 'darwin'] as const)('keeps the %s global shortcut field and offers no setup steps', async (platform) => {
    render(<SettingsView {...baseProps({ platform })} />)

    expect(screen.getByLabelText('Global shortcut')).toBeVisible()
    expect(screen.queryByRole('button', { name: /setup steps/u })).not.toBeInTheDocument()
    expect(screen.queryByText('Compositor bindings')).not.toBeInTheDocument()
  })
})
