import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ThreadShortcutsSettings } from '../../../../../src/renderer/src/features/settings/ThreadShortcutsSettings'
import type { ThreadShortcutChoices } from '../../../../../src/shared/threadShortcuts'

afterEach(() => {
  cleanup()
  delete (window as { sotto?: unknown }).sotto
})

function setup(options: { choices?: ThreadShortcutChoices; saved?: boolean } = {}) {
  ;(window as { sotto?: unknown }).sotto = { suspendDictationShortcuts: vi.fn(async () => ({ ok: true as const })) }
  const onUpdateSettings = vi.fn(async () => options.saved ?? true)
  const settings = {
    hotkey: 'CommandOrControl+Shift+Space',
    pressShortcuts: [] as string[],
    holdShortcuts: [] as string[],
    threadShortcuts: options.choices ?? {},
  }
  render(<ThreadShortcutsSettings settings={settings} platform="win32" onUpdateSettings={onUpdateSettings} />)
  return { onUpdateSettings, user: userEvent.setup() }
}

const row = (name: string): HTMLElement => screen.getByRole('group', { name })
const press = (...codes: string[]): void => { for (const code of codes) fireEvent.keyDown(window, { code, key: code }) }
const release = (code: string): void => { fireEvent.keyUp(window, { code, key: code }) }

describe('Settings › Keyboard (ADR-0133)', () => {
  it('shows every thread shortcut at its default, the fixed keys, and dictation pointed to', () => {
    setup()
    expect(within(row('New thread')).getByRole('button', { name: 'Change shortcut, Ctrl Shift N' })).toBeVisible()
    expect(within(row('Settle thread')).getByRole('button', { name: 'Change shortcut, Ctrl Shift E' })).toBeVisible()
    expect(within(row('Zoom pane')).getByRole('button', { name: 'Change shortcut, Ctrl Shift M' })).toBeVisible()
    expect(row('New thread')).toHaveAttribute('data-setting', 'shortcut-new-thread')
    expect(screen.getByText('Every shortcut is at its default.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Restore defaults' })).toBeDisabled()
    expect(screen.getByText('Dictation (press & hold)')).toBeVisible()
    expect(screen.getByText('Send the prompt')).toBeVisible()
  })

  it('records in the window, saves the T3 chord on release and returns focus', async () => {
    const { onUpdateSettings, user } = setup()
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift N' }))
    expect(screen.getByText('Press the new keys…')).toBeVisible()
    press('ControlLeft', 'ShiftLeft', 'KeyB')
    expect(screen.getByLabelText('Ctrl+Shift+B')).toBeVisible()
    release('KeyB')
    await waitFor(() => expect(onUpdateSettings).toHaveBeenCalledWith({ threadShortcuts: { 'new-thread': 'mod+shift+b' } }))
    expect(await within(row('New thread')).findByRole('status')).toHaveTextContent('Shortcut saved.')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift N' })).toHaveFocus())
  })

  it('refuses keys another row or dictation already holds, and plain typing', async () => {
    const { onUpdateSettings, user } = setup()
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift N' }))
    press('ControlLeft', 'ShiftLeft', 'KeyE')
    release('KeyE')
    expect(await within(row('New thread')).findByRole('alert')).toHaveTextContent('Settle thread already uses Ctrl + Shift + E. Pick other keys.')
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift E' }))
    press('ControlLeft', 'ShiftLeft', 'Space')
    release('Space')
    expect(await within(row('Settle thread')).findByRole('alert')).toHaveTextContent('Sotto’s start-and-stop dictation shortcut already uses Ctrl + Shift + Space. Pick other keys.')
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift N' }))
    press('KeyB')
    release('KeyB')
    expect(await within(row('New thread')).findByRole('alert')).toHaveTextContent('A thread shortcut needs Ctrl, so plain typing can never set it off.')
    expect(onUpdateSettings).not.toHaveBeenCalled()
  })

  it('removes a shortcut, resets one, and restores them all', async () => {
    const { onUpdateSettings, user } = setup({ choices: { 'new-thread': 'mod+shift+b' } })
    expect(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift B' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Reset New thread to its default' }))
    await waitFor(() => expect(onUpdateSettings).toHaveBeenLastCalledWith({ threadShortcuts: {} }))
    await user.click(screen.getByRole('button', { name: 'Remove shortcut, Ctrl Shift B' }))
    await waitFor(() => expect(onUpdateSettings).toHaveBeenLastCalledWith({ threadShortcuts: { 'new-thread': null } }))
    await user.click(screen.getByRole('button', { name: 'Restore defaults' }))
    await waitFor(() => expect(onUpdateSettings).toHaveBeenLastCalledWith({ threadShortcuts: {} }))
    expect(await screen.findByText('All shortcuts are back to their defaults.')).toBeVisible()
  })

  it('filters by action and by keys', async () => {
    const { user } = setup()
    await user.type(screen.getByRole('searchbox', { name: 'Filter shortcuts' }), 'settle')
    expect(row('Settle thread')).toBeVisible()
    expect(screen.queryByRole('group', { name: 'New thread' })).not.toBeInTheDocument()
  })
})
