import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ThreadShortcutsSettings } from '../../../../../src/renderer/src/features/settings/ThreadShortcutsSettings'
import type { ThreadShortcutChoices } from '../../../../../src/shared/threadShortcuts'

// Watcher and Usage are Owl features (ADR-0072); each test says whether this build has them.
const owl = vi.hoisted(() => ({ on: false }))
vi.mock('../../../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => owl.on && (id === 'watcher' || id === 'usage'),
}))

afterEach(() => {
  cleanup()
  owl.on = false
  delete (window as { sotto?: unknown }).sotto
})

function setup(options: { choices?: ThreadShortcutChoices; saved?: boolean; hotkey?: string } = {}) {
  ;(window as { sotto?: unknown }).sotto = { suspendDictationShortcuts: vi.fn(async () => ({ ok: true as const })) }
  const onUpdateSettings = vi.fn(async () => options.saved ?? true)
  const settings = {
    hotkey: options.hotkey ?? 'CommandOrControl+Shift+Space',
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
    expect(within(row('Restore settled thread')).getByRole('button', { name: 'Change shortcut, Ctrl Alt R' })).toBeVisible()
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
    expect(await within(row('New thread')).findByRole('alert')).toHaveTextContent('This shortcut needs Ctrl, so plain typing can never set it off.')
    expect(onUpdateSettings).not.toHaveBeenCalled()
  })

  it('refuses keys the application menu takes before the window, such as Force Reload’s', async () => {
    const { onUpdateSettings, user } = setup()
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Alt R' }))
    press('ControlLeft', 'ShiftLeft', 'KeyR')
    release('KeyR')
    expect(await within(row('Restore settled thread')).findByRole('alert')).toHaveTextContent('Force reload the window already uses Ctrl + Shift + R. Pick other keys.')
    expect(onUpdateSettings).not.toHaveBeenCalled()
  })

  it('names Changes for the fallback keys it answers to while dictation holds its plain ones', async () => {
    const { onUpdateSettings, user } = setup({ hotkey: 'CommandOrControl+D' })
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift N' }))
    press('ControlLeft', 'ShiftLeft', 'KeyD')
    release('KeyD')
    expect(await within(row('New thread')).findByRole('alert')).toHaveTextContent('Changes already uses Ctrl + Shift + D. Pick other keys.')
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

  it('lists the page shortcuts first, Ctrl+1 to Ctrl+5, leaving out pages this build does not have (ADR-0158)', () => {
    setup()
    expect(within(row('Dictate')).getByRole('button', { name: 'Change shortcut, Ctrl 1' })).toBeVisible()
    expect(within(row('Threads')).getByRole('button', { name: 'Change shortcut, Ctrl 3' })).toBeVisible()
    expect(within(row('Settings')).getByRole('button', { name: 'Change shortcut, Ctrl 5' })).toBeVisible()
    expect(row('Threads')).toHaveAttribute('data-setting', 'shortcut-page-threads')
    expect(screen.queryByRole('group', { name: 'Watcher' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Usage' })).not.toBeInTheDocument()
    const headings = screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)
    expect(headings.slice(0, 2)).toEqual(['Switch pages', 'Threads'])
    cleanup()
    owl.on = true
    setup()
    expect(screen.getAllByRole('group').map(group => group.getAttribute('data-setting')).slice(0, 5))
      .toEqual(['shortcut-page-dictate', 'shortcut-page-watcher', 'shortcut-page-threads', 'shortcut-page-usage', 'shortcut-page-settings'])
    expect(within(row('Watcher')).getByRole('button', { name: 'Change shortcut, Ctrl 2' })).toBeVisible()
    expect(within(row('Usage')).getByRole('button', { name: 'Change shortcut, Ctrl 4' })).toBeVisible()
  })

  it('records a page shortcut like any other, and refuses keys a page or thread shortcut holds', async () => {
    const { onUpdateSettings, user } = setup()
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl 3' }))
    press('ControlLeft', 'KeyL')
    release('KeyL')
    expect(await within(row('Threads')).findByRole('alert')).toHaveTextContent('Focus the prompt already uses Ctrl + L. Pick other keys.')
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift N' }))
    press('ControlLeft', 'Digit5')
    release('Digit5')
    expect(await within(row('New thread')).findByRole('alert')).toHaveTextContent('Settings already uses Ctrl + 5. Pick other keys.')
    expect(onUpdateSettings).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl 3' }))
    press('ControlLeft', 'Digit7')
    release('Digit7')
    await waitFor(() => expect(onUpdateSettings).toHaveBeenCalledWith({ threadShortcuts: { 'page-threads': 'mod+7' } }))
  })

  it('leaves the keys of a page this build hides free for another row', async () => {
    const { onUpdateSettings, user } = setup()
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift N' }))
    press('ControlLeft', 'Digit2')
    release('Digit2')
    await waitFor(() => expect(onUpdateSettings).toHaveBeenCalledWith({ threadShortcuts: { 'new-thread': 'mod+2' } }))
  })

  it('says which thread shortcut saved before holds a page shortcut’s default keys, and refuses them to others still', async () => {
    const { onUpdateSettings, user } = setup({ choices: { 'new-thread': 'mod+1' } })
    expect(within(row('Dictate')).getByRole('status')).toHaveTextContent('New thread already uses Ctrl + 1, so these keys do nothing here until one of the two changes.')
    expect(within(row('Threads')).queryByRole('status')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift E' }))
    press('ControlLeft', 'Digit1')
    release('Digit1')
    expect(await within(row('Settle thread')).findByRole('alert')).toHaveTextContent('New thread already uses Ctrl + 1. Pick other keys.')
    expect(onUpdateSettings).not.toHaveBeenCalled()
  })

  it('says which page shortcut saved while a page was hidden holds that page’s default keys', () => {
    setup({ choices: { 'page-threads': 'mod+1' } })
    expect(within(row('Dictate')).getByRole('status')).toHaveTextContent('Threads already uses Ctrl + 1, so these keys do nothing here until one of the two changes.')
  })

  it('names each other on two page shortcuts saved on the same keys', () => {
    setup({ choices: { 'page-dictate': 'mod+6', 'page-threads': 'mod+6' } })
    expect(within(row('Dictate')).getByRole('status')).toHaveTextContent('Threads already uses Ctrl + 6')
    expect(within(row('Threads')).getByRole('status')).toHaveTextContent('Dictate already uses Ctrl + 6')
  })

  it('refuses the same keys again on a page shortcut that stands down on them, naming who holds them', async () => {
    const { onUpdateSettings, user } = setup({ choices: { 'new-thread': 'mod+1' } })
    await user.click(within(row('Dictate')).getByRole('button', { name: 'Change shortcut, Ctrl 1' }))
    press('ControlLeft', 'Digit1')
    release('Digit1')
    expect(await within(row('Dictate')).findByRole('alert')).toHaveTextContent('New thread already uses Ctrl + 1. Pick other keys.')
    expect(within(row('Dictate')).queryByText('Shortcut saved.')).not.toBeInTheDocument()
    expect(onUpdateSettings).not.toHaveBeenCalled()
  })

  it('still refuses a third row the keys two saved page shortcuts meet on', async () => {
    const { onUpdateSettings, user } = setup({ choices: { 'page-dictate': 'mod+6', 'page-threads': 'mod+6' } })
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl 5' }))
    press('ControlLeft', 'Digit6')
    release('Digit6')
    expect(await within(row('Settings')).findByRole('alert')).toHaveTextContent('Dictate already uses Ctrl + 6. Pick other keys.')
    expect(onUpdateSettings).not.toHaveBeenCalled()
  })
})
