import { OK, createBridge, openPage, renderApp } from '../../fixtures/renderer/appHarness'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { type UpdateStatus } from '../../../src/shared/contracts'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

describe('Sotto application onboarding integration', () => {
  it('carries a release offer through the update control: download, a toast when it lands, then a confirmed restart', async () => {
    const user = userEvent.setup()
    let publish: ((status: UpdateStatus) => void) | null = null
    const downloadUpdate = vi.fn(async () => {
      publish?.({ currentVersion: '3.4.0', phase: { phase: 'downloaded', version: '3.5.0', problem: null }, checkedAt: 1 })
      return OK
    })
    const installUpdate = vi.fn(async () => OK)
    const openExternalLink = vi.fn(async () => OK)
    const bridge = createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      getUpdateStatus: vi.fn(async () => ({
        currentVersion: '3.4.0',
        phase: { phase: 'available' as const, version: '3.5.0', problem: null },
        checkedAt: 1,
      })),
      onUpdateStatus: vi.fn((listener: (status: UpdateStatus) => void) => {
        publish = listener
        return () => undefined
      }),
      downloadUpdate,
      installUpdate,
      openExternalLink,
    })
    // The toast's "Read more" link opens through the window bridge, as every external link does.
    window.sotto = bridge
    renderApp(bridge)
    await openPage('home')

    await screen.findByRole('heading', { level: 1, name: /ready when you are/i })
    const offer = await screen.findByRole('button', { name: 'Update 3.5.0 ready to download' })
    expect(screen.getByRole('complementary', { name: 'Thread sidebar' })).toContainElement(offer)
    expect(document.querySelector('.update-banner')).toBeNull()
    await user.click(offer)
    expect(downloadUpdate).toHaveBeenCalledOnce()

    const toast = await screen.findByRole('status', { name: '' })
    expect(toast).toHaveTextContent(/Update downloaded/)
    expect(toast).toHaveAttribute('data-tone', 'success')
    await user.click(screen.getByRole('button', { name: 'Read more' }))
    expect(openExternalLink).toHaveBeenCalledWith('https://github.com/millZach/Sotto-releases/releases/tag/v3.5.0')

    // The control now offers the restart, and the restart asks first.
    await user.click(screen.getByRole('button', { name: 'Update 3.5.0 downloaded. Click to restart and install.' }))
    const dialog = screen.getByRole('dialog', { name: 'Install update 3.5.0 and restart Sotto?' })
    expect(dialog).toHaveTextContent(/will be interrupted/)
    await user.click(screen.getByRole('button', { name: 'Not now' }))
    expect(installUpdate).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Update 3.5.0 downloaded. Click to restart and install.' }))
    await user.click(screen.getByRole('button', { name: 'Restart and install' }))
    expect(installUpdate).toHaveBeenCalledOnce()
    delete window.sotto
  })

  it('says why a download or install could not be completed and offers the same action again', async () => {
    const user = userEvent.setup()
    let publish: ((status: UpdateStatus) => void) | null = null
    const downloadUpdate = vi.fn(async () => {
      publish?.({ currentVersion: '3.4.0', phase: { phase: 'available', version: '3.5.0', problem: 'net::ERR_INTERNET_DISCONNECTED' }, checkedAt: 1 })
      return { ok: false as const, reason: 'unavailable' as const }
    })
    renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      getUpdateStatus: vi.fn(async () => ({
        currentVersion: '3.4.0',
        phase: { phase: 'available' as const, version: '3.5.0', problem: null },
        checkedAt: 1,
      })),
      onUpdateStatus: vi.fn((listener: (status: UpdateStatus) => void) => {
        publish = listener
        return () => undefined
      }),
      downloadUpdate,
    }))
    await openPage('home')

    await screen.findByRole('heading', { level: 1, name: /ready when you are/i })
    await user.click(await screen.findByRole('button', { name: 'Update 3.5.0 ready to download' }))

    const toast = await screen.findByRole('alert')
    expect(toast).toHaveTextContent('Could not download update net::ERR_INTERNET_DISCONNECTED')
    expect(screen.getByRole('button', { name: 'Update check failed. Update 3.5.0 is still offered. Click to download.' })).toBeInTheDocument()

    act(() => publish?.({ currentVersion: '3.4.0', phase: { phase: 'downloaded', version: '3.5.0', problem: 'No update filepath provided, can’t quit and install' }, checkedAt: 1 }))
    expect(screen.getByRole('button', { name: 'Install failed for 3.5.0. Click to retry.' })).toBeInTheDocument()
  })

  it('runs a check from the footer control, from the application menu, and says when neither can', async () => {
    const user = userEvent.setup()
    let requestCheck: (() => void) | null = null
    const checkForUpdates = vi.fn(async () => ({
      currentVersion: '3.4.0',
      phase: { phase: 'failed' as const, problem: 'GitHub answered 503' },
      checkedAt: 2,
    }))
    renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      getUpdateStatus: vi.fn(async () => ({
        currentVersion: '3.4.0',
        phase: { phase: 'up-to-date' as const },
        checkedAt: 1,
      })),
      onUpdateCheckRequested: vi.fn((listener: () => void) => {
        requestCheck = listener
        return () => undefined
      }),
      checkForUpdates,
    }))
    await openPage('home')

    await screen.findByRole('heading', { level: 1, name: /ready when you are/i })
    await user.click(await screen.findByRole('button', { name: 'Check for updates' }))
    expect(checkForUpdates).toHaveBeenCalledOnce()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check for updates GitHub answered 503')

    act(() => requestCheck?.())
    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(2))
  })

  it('disables the footer control on a build without an update feed', async () => {
    renderApp(createBridge({
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, onboardingComplete: true })),
      getUpdateStatus: vi.fn(async () => ({
        currentVersion: '3.4.0',
        phase: { phase: 'unsupported' as const },
        checkedAt: null,
      })),
    }))
    await openPage('home')

    await screen.findByRole('heading', { level: 1, name: /ready when you are/i })
    const control = await screen.findByRole('button', { name: 'Update checks run only in the installed Windows app.' })
    expect(control).toHaveAttribute('aria-disabled', 'true')
  })
})
