import { deferred, baseProps, selectCategory } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import { UPDATE_CHECK_PRIVACY_NOTICE } from '../../../../../src/shared/contracts'

describe('SettingsView', () => {
  it('keeps update actions busy through category navigation until the pending check settles', async () => {
    const pending = deferred<null>()
    const check = vi.fn(() => pending.promise)
    render(<SettingsView {...baseProps({ onCheckForUpdates: check })} />)
    await selectCategory('Application')
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }))
    await selectCategory('Dictation')
    await selectCategory('Application')
    expect(screen.getByRole('button', { name: 'Working...' })).toBeDisabled()
    expect(check).toHaveBeenCalledOnce()
    pending.resolve(null)
    expect(await screen.findByRole('button', { name: 'Check now' })).toBeEnabled()
  })

  it.each([
    ['clear', 'History could not be cleared.'],
    ['reset', 'Settings could not be reset.'],
  ] as const)('shows a finite %s failure inside the active dialog', async (operation, message) => {
    const user = userEvent.setup()
    render(<SettingsView {...baseProps({
      onClearHistory: vi.fn(async () => false),
      onResetSettings: vi.fn(async () => false),
    })} />)
    await selectCategory('Application')
    if (operation === 'clear') {
      await user.click(screen.getByRole('button', { name: /clear history/i }))
      await user.click(screen.getByRole('button', { name: /clear all transcripts/i }))
    } else {
      await user.click(screen.getByRole('button', { name: /reset settings/i }))
      await user.click(screen.getByRole('button', { name: /reset all settings/i }))
    }
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent(message)
  })

  it('discloses what an update check sends and saves the choice through the ordinary patch flow', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Application')

    const toggle = screen.getByRole('switch', { name: 'Check for updates automatically' })
    expect(toggle).toBeChecked()
    expect(screen.getByText(UPDATE_CHECK_PRIVACY_NOTICE)).toBeVisible()
    expect(screen.getByText('Sotto 3.4.0')).toBeVisible()
    expect(screen.getByText('You are on the newest release.')).toBeVisible()

    await user.click(toggle)

    expect(update).toHaveBeenCalledWith({ autoUpdateCheck: false })
  })

  it('checks on demand and offers the matching action for each update phase', async () => {
    const user = userEvent.setup()
    const check = vi.fn(async () => null)
    const download = vi.fn(async () => true)
    const install = vi.fn(async () => true)

    const { unmount } = render(<SettingsView {...baseProps({ onCheckForUpdates: check })} />)
    await selectCategory('Application')
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(check).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument()
    unmount()

    render(<SettingsView {...baseProps({
      updateStatus: { currentVersion: '3.4.0', phase: { phase: 'available', version: '3.5.0', problem: null }, checkedAt: 1 },
      onDownloadUpdate: download,
    })} />)
    await selectCategory('Application')
    expect(screen.getByText('Sotto 3.5.0 is available.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(download).toHaveBeenCalledOnce()
    cleanup()

    render(<SettingsView {...baseProps({
      updateStatus: { currentVersion: '3.4.0', phase: { phase: 'downloaded', version: '3.5.0', problem: null }, checkedAt: 1 },
      onInstallUpdate: install,
    })} />)
    await selectCategory('Application')
    await user.click(screen.getByRole('button', { name: 'Restart and install' }))
    expect(install).toHaveBeenCalledOnce()
  })

  it('says plainly when this build has no update feed at all', async () => {
    render(<SettingsView {...baseProps({
      updateStatus: { currentVersion: '3.4.0', phase: { phase: 'unsupported' }, checkedAt: null },
    })} />)
    await selectCategory('Application')

    expect(screen.getByText('Update checks run only in the installed Windows app.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled()
  })
})

it('says reset preserves the saved OpenRouter key before confirmation', async () => {
  render(<SettingsView {...baseProps()} />)
  await selectCategory('Application')
  await userEvent.click(screen.getByRole('button', { name: 'Reset settings' }))
  expect(screen.getByText('Defaults will be restored and first-run setup will reopen. Your saved OpenRouter key and history are preserved.')).toBeVisible()
})
