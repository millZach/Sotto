import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { UpdateControl } from '../../../src/renderer/src/features/updates/UpdateControl'
import {
  installConfirmation,
  updateAction,
  updateProblem,
  updateTooltip,
} from '../../../src/renderer/src/features/updates/updateControlLogic'
import type { UpdatePhase, UpdateStatus } from '../../../src/shared/contracts'
import { releaseUrl } from '../../../src/shared/releases'

afterEach(cleanup)

function status(phase: UpdatePhase): UpdateStatus {
  return { currentVersion: '3.4.0', phase, checkedAt: null }
}

describe('updateAction', () => {
  it('offers a check when nothing is known, nothing is newer, or the last check failed', () => {
    expect(updateAction(status({ phase: 'idle' }))).toBe('check')
    expect(updateAction(status({ phase: 'up-to-date' }))).toBe('check')
    expect(updateAction(status({ phase: 'failed', problem: null }))).toBe('check')
  })

  it('offers the download while a release is on offer, and again after a failed download', () => {
    expect(updateAction(status({ phase: 'available', version: '3.5.0', problem: null }))).toBe('download')
    expect(updateAction(status({ phase: 'available', version: '3.5.0', problem: 'ECONNRESET' }))).toBe('download')
  })

  it('offers the restart once the installer is on disk, and again after a refused install', () => {
    expect(updateAction(status({ phase: 'downloaded', version: '3.5.0', problem: null }))).toBe('install')
    expect(updateAction(status({ phase: 'downloaded', version: '3.5.0', problem: 'refused' }))).toBe('install')
  })

  it('offers nothing while busy, before the first answer, or without a feed', () => {
    expect(updateAction(null)).toBe('none')
    expect(updateAction(status({ phase: 'checking' }))).toBe('none')
    expect(updateAction(status({ phase: 'downloading', version: '3.5.0', percent: 4 }))).toBe('none')
    expect(updateAction(status({ phase: 'unsupported' }))).toBe('none')
  })
})

describe('updateTooltip', () => {
  it('names the version and the press for every phase', () => {
    expect(updateTooltip(null)).toBe('Check for updates')
    expect(updateTooltip(status({ phase: 'up-to-date' }))).toBe('Check for updates')
    expect(updateTooltip(status({ phase: 'checking' }))).toBe('Checking for updates…')
    expect(updateTooltip(status({ phase: 'available', version: '3.5.0', problem: null }))).toBe('Update 3.5.0 ready to download')
    expect(updateTooltip(status({ phase: 'available', version: '3.5.0', problem: 'x' }))).toBe('Download failed for 3.5.0. Click to retry.')
    expect(updateTooltip(status({ phase: 'downloading', version: '3.5.0', percent: 42 }))).toBe('Downloading update (42%)')
    expect(updateTooltip(status({ phase: 'downloaded', version: '3.5.0', problem: null }))).toBe('Update 3.5.0 downloaded. Click to restart and install.')
    expect(updateTooltip(status({ phase: 'downloaded', version: '3.5.0', problem: 'x' }))).toBe('Install failed for 3.5.0. Click to retry.')
    expect(updateTooltip(status({ phase: 'unsupported' }))).toBe('Update checks run only in the installed Windows app.')
  })
})

describe('installConfirmation and updateProblem', () => {
  it('asks about the exact version and warns about interrupted work', () => {
    const confirmation = installConfirmation('3.5.0')
    expect(confirmation.title).toBe('Install update 3.5.0 and restart Sotto?')
    expect(confirmation.description).toMatch(/interrupted/)
  })

  it('lifts the problem sentence from the phases that carry one', () => {
    expect(updateProblem(status({ phase: 'available', version: '3.5.0', problem: 'ECONNRESET' }))).toBe('ECONNRESET')
    expect(updateProblem(status({ phase: 'failed', problem: null }))).toBeNull()
    expect(updateProblem(status({ phase: 'checking' }))).toBeNull()
    expect(updateProblem(null)).toBeNull()
  })

  it('points at the release page for a version and nowhere without one', () => {
    expect(releaseUrl('3.5.0')).toBe('https://github.com/millZach/Sotto-releases/releases/tag/v3.5.0')
    expect(releaseUrl(' ')).toBeNull()
    expect(releaseUrl(null)).toBeNull()
  })
})

describe('UpdateControl', () => {
  it('wears the phase as its state and its meaning as its name', () => {
    const { rerender } = render(<UpdateControl status={status({ phase: 'idle' })} busy={false} onActivate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Check for updates' })).toHaveAttribute('data-state', 'idle')

    rerender(<UpdateControl status={status({ phase: 'checking' })} busy={false} onActivate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Checking for updates…' })).toHaveAttribute('data-state', 'checking')

    rerender(<UpdateControl status={status({ phase: 'downloading', version: '3.5.0', percent: 25 })} busy={false} onActivate={vi.fn()} />)
    const downloading = screen.getByRole('button', { name: 'Downloading update (25%)' })
    expect(downloading).toHaveAttribute('data-state', 'downloading')
    expect(downloading).toHaveAttribute('aria-disabled', 'true')
    expect(downloading.querySelector('.update-control__ring-value')).not.toBeNull()

    rerender(<UpdateControl status={status({ phase: 'downloaded', version: '3.5.0', problem: null })} busy={false} onActivate={vi.fn()} />)
    expect(screen.getByRole('button', { name: /downloaded/ })).toHaveAttribute('data-state', 'downloaded')
  })

  it('hands the press to its owner with the action it means, and never while busy', async () => {
    const user = userEvent.setup()
    const onActivate = vi.fn()
    const { rerender } = render(<UpdateControl status={status({ phase: 'available', version: '3.5.0', problem: null })} busy={false} onActivate={onActivate} />)
    await user.click(screen.getByRole('button'))
    expect(onActivate).toHaveBeenCalledWith('download')

    rerender(<UpdateControl status={status({ phase: 'available', version: '3.5.0', problem: null })} busy onActivate={onActivate} />)
    await user.click(screen.getByRole('button'))
    expect(onActivate).toHaveBeenCalledTimes(1)

    rerender(<UpdateControl status={status({ phase: 'downloaded', version: '3.5.0', problem: null })} busy={false} onActivate={onActivate} />)
    await user.click(screen.getByRole('button'))
    expect(onActivate).toHaveBeenLastCalledWith('install')
  })
})
