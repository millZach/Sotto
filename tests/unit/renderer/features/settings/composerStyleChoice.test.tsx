import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { saying } from '../../../../fixtures/renderer/laterWords'

import { AppearanceSettings } from '../../../../../src/renderer/src/features/settings/AppearanceSettings'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../../src/shared/settings'

afterEach(cleanup)

function setup({ settings = {}, saves = true }: { settings?: Partial<AppSettings>; saves?: boolean } = {}) {
  const all: AppSettings = { ...DEFAULT_SETTINGS, ...settings }
  const onSave = vi.fn(async () => saves)
  render(<AppearanceSettings settings={all} platform="win32" onSave={onSave} getSettings={() => all} />)
  return { onSave, user: userEvent.setup() }
}

const group = () => screen.getByRole('radiogroup', { name: 'Composer' })
const radio = (name: RegExp) => within(group()).getByRole('radio', { name })

describe('Settings → Appearance → Composer (ADR-0168)', () => {
  it('offers Zach’s composer, in use by default, and Drake’s, each named for what a press does, from one Tab stop', () => {
    setup()
    const radios = within(group()).getAllByRole('radio')
    expect(radios.map(item => item.getAttribute('aria-label'))).toEqual(['Use Zach’s composer, in use', 'Use Drake’s composer'])
    expect(radios.map(item => item.getAttribute('aria-checked'))).toEqual(['true', 'false'])
    expect(radios.map(item => item.tabIndex)).toEqual([0, -1])
    expect(screen.getByText('How the box you write to threads and Watcher in is laid out.')).toBeInTheDocument()
  })

  it('saves Drake’s composer when pressed, and says so', async () => {
    const { onSave, user } = setup()
    await user.click(radio(/Drake’s composer$/))
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ composerStyle: 'pill' }, saying('Composer saved.'))
    expect(radio(/Drake’s composer, in use$/)).toHaveAttribute('aria-checked', 'true')
  })

  it('goes back to the saved style when a save fails', async () => {
    const { user } = setup({ settings: { composerStyle: 'pill' }, saves: false })
    await user.click(radio(/Zach’s composer$/))
    await vi.waitFor(() => expect(radio(/Drake’s composer, in use$/)).toHaveAttribute('aria-checked', 'true'))
  })

  it('chooses with the arrows, Home and End', async () => {
    const { onSave, user } = setup()
    await user.tab()
    while (document.activeElement !== null && !group().contains(document.activeElement)) await user.tab()
    expect(radio(/Zach’s composer, in use$/)).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(radio(/Drake’s composer, in use$/)).toHaveFocus()
    await user.keyboard('{Home}')
    expect(radio(/Zach’s composer, in use$/)).toHaveFocus()
    expect(onSave).toHaveBeenLastCalledWith({ composerStyle: 'rows' }, saying('Composer saved.'))
  })
})
