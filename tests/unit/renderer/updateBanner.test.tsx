import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { UpdateBanner } from '../../../src/renderer/src/features/updates/UpdateBanner'
import { updatePromptKey } from '../../../src/renderer/src/features/updates/updatePrompt'
import type { UpdatePhase, UpdateStatus } from '../../../src/shared/contracts'

afterEach(cleanup)

function status(phase: UpdatePhase): UpdateStatus {
  return { currentVersion: '3.4.0', phase }
}

function renderBanner(
  phase: UpdatePhase,
  overrides: Partial<React.ComponentProps<typeof UpdateBanner>> = {},
) {
  const props = {
    status: status(phase),
    onDownload: vi.fn(async () => true),
    onInstall: vi.fn(async () => true),
    onDismiss: vi.fn(),
    ...overrides,
  }
  return { ...render(<UpdateBanner {...props} />), props }
}

describe('updatePromptKey', () => {
  it('separates the offer from the ready-to-install note so one dismissal is not both', () => {
    expect(updatePromptKey(status({ phase: 'available', version: '3.5.0' }))).toBe('offer:3.5.0')
    expect(updatePromptKey(status({ phase: 'downloading', version: '3.5.0', percent: 40 })))
      .toBe('offer:3.5.0')
    expect(updatePromptKey(status({ phase: 'downloaded', version: '3.5.0' }))).toBe('ready:3.5.0')
  })

  it('offers no prompt for a quiet phase', () => {
    expect(updatePromptKey(null)).toBeNull()
    for (const phase of ['idle', 'checking', 'up-to-date', 'failed', 'unsupported'] as const) {
      expect(updatePromptKey(status({ phase }))).toBeNull()
    }
  })
})

describe('UpdateBanner', () => {
  it.each(['idle', 'checking', 'up-to-date', 'failed', 'unsupported'] as const)(
    'renders nothing at all in the %s phase',
    (phase) => {
      const { container } = renderBanner({ phase })
      expect(container).toBeEmptyDOMElement()
    },
  )

  it('offers the new version with the version in hand and downloads on request', async () => {
    const user = userEvent.setup()
    const onDownload = vi.fn(async () => true)
    renderBanner({ phase: 'available', version: '3.5.0' }, { onDownload })

    expect(screen.getByText('Sotto 3.5.0 is available')).toBeVisible()
    expect(screen.getByText(/You are running 3\.4\.0/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Download' }))

    expect(onDownload).toHaveBeenCalledOnce()
  })

  it('shows rounded progress as an accessible meter while downloading', () => {
    renderBanner({ phase: 'downloading', version: '3.5.0', percent: 42 })

    expect(screen.getByText('Downloading Sotto 3.5.0')).toBeVisible()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42')
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument()
  })

  it('reads as a success once the installer is on disk and restarts on request', async () => {
    const user = userEvent.setup()
    const onInstall = vi.fn(async () => true)
    const { container } = renderBanner({ phase: 'downloaded', version: '3.5.0' }, { onInstall })

    expect(container.querySelector('.update-banner')).toHaveAttribute('data-tone', 'ready')
    expect(screen.getByText('Sotto 3.5.0 is ready to install')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Restart to update' }))

    expect(onInstall).toHaveBeenCalledOnce()
  })

  it('keeps the informational tone while the update is only an offer', () => {
    const { container } = renderBanner({ phase: 'available', version: '3.5.0' })
    expect(container.querySelector('.update-banner')).toHaveAttribute('data-tone', 'offer')
  })

  it('can always be waved away', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    renderBanner({ phase: 'downloading', version: '3.5.0', percent: 10 }, { onDismiss })

    await user.click(screen.getByRole('button', { name: 'Dismiss update notice' }))

    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
