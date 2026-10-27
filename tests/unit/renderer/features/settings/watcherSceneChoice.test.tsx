import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { saying } from '../../../../fixtures/renderer/laterWords'

import { AppearanceSettings } from '../../../../../src/renderer/src/features/settings/AppearanceSettings'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../../src/shared/settings'

const gate = vi.hoisted(() => ({ watcher: true }))
vi.mock('../../../../../src/renderer/src/state/watcherFeature', () => ({ useWatcherEnabled: () => gate.watcher }))

afterEach(() => {
  cleanup()
  gate.watcher = true
})

function setup({ watcher = true, settings = {} }: { watcher?: boolean; settings?: Partial<AppSettings> } = {}) {
  gate.watcher = watcher
  const all: AppSettings = { ...DEFAULT_SETTINGS, ...settings }
  const onSave = vi.fn(async () => true)
  render(<AppearanceSettings settings={all} platform="win32" onSave={onSave} getSettings={() => all} />)
  return { onSave, user: userEvent.setup() }
}

const group = () => screen.getByRole('radiogroup', { name: 'Watcher scene' })
const radio = (name: RegExp) => within(group()).getByRole('radio', { name })

describe('Settings → Appearance → Watcher scene (ADR-0148)', () => {
  it('is absent where Watcher is off, and keeps the saved place', () => {
    const { onSave } = setup({ watcher: false, settings: { watcherScene: 'desert' } })
    expect(screen.queryByRole('heading', { name: 'Watcher scene' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Watcher scene' })).not.toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('offers the four places, each named for what a press does, the saved one checked and the only Tab stop', () => {
    setup({ settings: { watcherScene: 'harbour' } })
    const radios = within(group()).getAllByRole('radio')
    expect(radios.map(item => item.getAttribute('aria-label'))).toEqual([
      'Set Watcher’s scene in Night wood', 'Set Watcher’s scene in Harbour, in use', 'Set Watcher’s scene in Snowfield', 'Set Watcher’s scene in Desert',
    ])
    expect(radios.map(item => item.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false'])
    expect(radios.map(item => item.tabIndex)).toEqual([-1, 0, -1, -1])
    expect(within(group()).getByText('The sea, a ship at the quay and a lighthouse.')).toBeInTheDocument()
    expect(screen.getByText('Where Watcher and the owls for your threads live. Its colors come from your theme.')).toBeInTheDocument()
  })

  it('saves a place pressed, and says so', async () => {
    const { onSave, user } = setup()
    await user.click(radio(/in Snowfield$/))
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ watcherScene: 'snowfield' }, saying('Watcher scene saved.'))
    expect(radio(/in Snowfield, in use$/)).toHaveAttribute('aria-checked', 'true')
  })

  it('moves to a place and chooses it with the arrows, Home and End, from one Tab stop', async () => {
    const { onSave, user } = setup()
    await user.tab()
    while (document.activeElement !== null && !group().contains(document.activeElement)) await user.tab()
    expect(radio(/Night wood, in use$/)).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(radio(/Harbour, in use$/)).toHaveFocus()
    await user.keyboard('{End}')
    expect(radio(/Desert, in use$/)).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(radio(/Night wood, in use$/)).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(radio(/Desert, in use$/)).toHaveFocus()
    await user.keyboard('{Home}')
    expect(radio(/Night wood, in use$/)).toHaveFocus()
    expect(onSave.mock.calls.map(([patch]) => patch)).toEqual([
      { watcherScene: 'harbour' }, { watcherScene: 'desert' }, { watcherScene: 'night-wood' }, { watcherScene: 'desert' }, { watcherScene: 'night-wood' },
    ])
    // Tab leaves the group in one step.
    await user.tab()
    expect(group().contains(document.activeElement)).toBe(false)
  })
})
