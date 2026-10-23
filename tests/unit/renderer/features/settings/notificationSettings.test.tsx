import { baseProps } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import type { NotificationsBridge, NotificationTestResult } from '../../../../../src/shared/desktopNotifications'
import { DEFAULT_SETTINGS } from '../../../../../src/shared/settings'

const owl = vi.hoisted(() => ({ on: false }))
vi.mock('../../../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'desktop-notifications' && owl.on,
}))

afterEach(() => {
  cleanup()
  owl.on = false
  vi.unstubAllGlobals()
})

const HELP = 'If nothing appears, allow Sotto in System Settings → Notifications.'

function bridge(test: NotificationsBridge['test'] = async () => 'shown'): NotificationsBridge {
  const value: NotificationsBridge = { test: vi.fn(test), onOpened: vi.fn(() => () => undefined) }
  vi.stubGlobal('sotto', { notifications: value })
  return value
}

function group(): HTMLElement {
  return screen.getByRole('region', { name: 'Notifications', hidden: true })
}

describe('Settings → Application → Notifications (Owl desktop-notifications)', () => {
  it('is absent without the Owl feature', () => {
    bridge()
    render(<SettingsView {...baseProps()} />)
    expect(screen.queryByRole('region', { name: 'Notifications', hidden: true })).toBeNull()
    expect(screen.queryByText(HELP)).toBeNull()
  })

  it('is absent with the Owl feature but no bridge', () => {
    owl.on = true
    render(<SettingsView {...baseProps()} />)
    expect(screen.queryByRole('region', { name: 'Notifications', hidden: true })).toBeNull()
  })

  it('shows both switches with their saved values, the help line and the test button', () => {
    owl.on = true
    bridge()
    render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, notifyNeedsYou: true, notifyFinished: false } })} />)
    const notifications = within(group())
    expect(notifications.getByRole('switch', { name: 'When a thread needs you', hidden: true })).toBeChecked()
    expect(notifications.getByRole('switch', { name: 'When a thread has finished everything', hidden: true })).not.toBeChecked()
    expect(notifications.getByText(HELP)).toBeInTheDocument()
    expect(notifications.getByRole('button', { name: 'Send a test notification', hidden: true })).toBeEnabled()
  })

  it.each([
    ['notifyNeedsYou', 'When a thread needs you'],
    ['notifyFinished', 'When a thread has finished everything'],
  ] as const)('a press sends exactly %s, both ways', async (key, name) => {
    owl.on = true
    bridge()
    const update = vi.fn(async () => true)
    const user = userEvent.setup()
    const { rerender } = render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await user.click(within(group()).getByRole('switch', { name, hidden: true }))
    expect(update).toHaveBeenLastCalledWith({ [key]: false })
    rerender(<SettingsView {...baseProps({ onUpdateSettings: update, settings: { ...DEFAULT_SETTINGS, [key]: false } })} />)
    await user.click(within(group()).getByRole('switch', { name, hidden: true }))
    expect(update).toHaveBeenLastCalledWith({ [key]: true })
    expect(update).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['shown', 'Sent. If you did not see it, allow Sotto in System Settings → Notifications.'],
    ['failed', 'macOS did not show it. Allow Sotto in System Settings → Notifications, then try again.'],
    ['unsupported', 'This computer cannot show notifications.'],
    ['rejected', 'macOS did not show it. Allow Sotto in System Settings → Notifications, then try again.'],
  ] as const)('the test button calls test once, waits, and says %s in plain words', async (answer, copy) => {
    owl.on = true
    let settle!: () => void
    const notifications = bridge(() => new Promise<NotificationTestResult>((resolve, reject) => {
      settle = () => answer === 'rejected' ? reject(new Error('gone')) : resolve(answer)
    }))
    render(<SettingsView {...baseProps()} />)
    const button = within(group()).getByRole('button', { name: 'Send a test notification', hidden: true })
    await userEvent.setup().click(button)
    expect(notifications.test).toHaveBeenCalledTimes(1)
    expect(button).toBeDisabled()
    await act(async () => { settle() })
    expect(button).toBeEnabled()
    const status = within(group()).getByText(copy)
    expect(status).toHaveAttribute('role', 'status')
    expect(status).toHaveAttribute('aria-live', 'polite')
  })

  it('has an empty live region before any press', () => {
    owl.on = true
    bridge()
    render(<SettingsView {...baseProps()} />)
    const status = within(group()).getByRole('status', { hidden: true })
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toBeEmptyDOMElement()
  })

  it('clears the last answer while a new test is pending, and ignores a second press meanwhile', async () => {
    owl.on = true
    let settle!: () => void
    const notifications = bridge(() => new Promise<NotificationTestResult>(resolve => { settle = () => resolve('shown') }))
    render(<SettingsView {...baseProps()} />)
    const user = userEvent.setup()
    const button = within(group()).getByRole('button', { name: 'Send a test notification', hidden: true })
    const status = within(group()).getByRole('status', { hidden: true })
    await user.click(button)
    await act(async () => { settle() })
    expect(status).toHaveTextContent(/^Sent\./u)
    await user.click(button)
    expect(status).toBeEmptyDOMElement()
    await user.click(button)
    expect(notifications.test).toHaveBeenCalledTimes(2)
    await act(async () => { settle() })
    expect(status).toHaveTextContent(/^Sent\./u)
  })

  it('takes an answer that arrives after unmounting without throwing or warning', async () => {
    owl.on = true
    let settle!: () => void
    bridge(() => new Promise<NotificationTestResult>(resolve => { settle = () => resolve('shown') }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const { unmount } = render(<SettingsView {...baseProps()} />)
      await userEvent.setup().click(within(group()).getByRole('button', { name: 'Send a test notification', hidden: true }))
      unmount()
      await act(async () => { settle() })
      expect(errors).not.toHaveBeenCalled()
      expect(warnings).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
      warnings.mockRestore()
    }
  })
})
