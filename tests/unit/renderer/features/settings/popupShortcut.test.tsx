import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PopupShortcutSetting } from '../../../../../src/renderer/src/features/settings/PopupShortcutSetting'
import type { PopupShortcutBridge, PopupShortcutResult, PopupShortcutState } from '../../../../../src/shared/popup'

const owl = vi.hoisted(() => ({ on: true }))
vi.mock('../../../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => owl.on && id === 'popup',
}))

afterEach(() => {
  cleanup()
  owl.on = true
  delete (window as { sotto?: unknown }).sotto
})

function setup(options: { state?: PopupShortcutState; result?: PopupShortcutResult; chord?: string | null } = {}) {
  const popup: PopupShortcutBridge = {
    state: vi.fn(async () => options.state ?? { status: 'on' as const, chord: 'Alt+Shift+Space' }),
    onState: () => () => undefined,
    replace: vi.fn(async () => options.result ?? { ok: true as const }),
    onOpened: () => () => undefined,
  }
  ;(window as { sotto?: unknown }).sotto = { popup, suspendDictationShortcuts: vi.fn(async () => ({ ok: true as const })) }
  const settings = { popupShortcut: options.chord === undefined ? 'Alt+Shift+Space' : options.chord, hotkey: 'CommandOrControl+Shift+Space', pressShortcuts: [] as string[], holdShortcuts: [] as string[] }
  render(<PopupShortcutSetting settings={settings} platform="win32" />)
  return { popup, user: userEvent.setup() }
}

const row = (): HTMLElement => screen.getByRole('group', { name: 'Show the popup' })
const press = (...codes: string[]): void => { for (const code of codes) fireEvent.keyDown(window, { code, key: code }) }
const release = (code: string): void => { fireEvent.keyUp(window, { code, key: code }) }

describe('Settings › Keyboard › Popup (ADR-0181)', () => {
  it('is not there while the Owl feature is off', () => {
    owl.on = false
    setup()
    expect(screen.queryByRole('group', { name: 'Show the popup' })).toBeNull()
  })

  it('records new keys with the popup\'s own shortcut stood aside, and has main take them', async () => {
    const { popup, user } = setup()
    await user.click(within(row()).getByRole('button', { name: 'Change shortcut, Alt Shift Space' }))
    press('ControlLeft', 'AltLeft', 'KeyP')
    release('KeyP')
    await waitFor(() => expect(popup.replace).toHaveBeenCalledWith('CommandOrControl+Alt+P'))
    expect(await within(row()).findByText('Shortcut saved.')).toBeVisible()
  })

  it('refuses keys dictation holds without asking main', async () => {
    const { popup, user } = setup()
    await user.click(within(row()).getByRole('button', { name: 'Change shortcut, Alt Shift Space' }))
    press('ControlLeft', 'ShiftLeft', 'Space')
    release('Space')
    expect(await within(row()).findByRole('alert')).toHaveTextContent('start-and-stop dictation shortcut already uses')
    expect(popup.replace).not.toHaveBeenCalled()
  })

  it('says another app holds the keys and the old ones still work when main cannot take them', async () => {
    const { user } = setup({ result: { ok: false, reason: 'taken' } })
    await user.click(within(row()).getByRole('button', { name: 'Change shortcut, Alt Shift Space' }))
    press('ControlLeft', 'AltLeft', 'KeyP')
    release('KeyP')
    expect(await within(row()).findByRole('alert')).toHaveTextContent(/Another app already uses .* still works\./u)
  })

  it('says when the saved keys could not be taken, and removes or restores them', async () => {
    const { popup, user } = setup({ state: { status: 'taken', chord: 'Alt+Shift+Space' }, chord: 'Alt+Shift+Space' })
    expect(await within(row()).findByRole('alert')).toHaveTextContent('so the popup has no shortcut')
    await user.click(within(row()).getByRole('button', { name: 'Remove shortcut, Alt Shift Space' }))
    expect(popup.replace).toHaveBeenCalledWith(null)
  })

  it('offers the default back once the keys changed', async () => {
    const { popup, user } = setup({ chord: null, state: { status: 'off', chord: null } })
    expect(within(row()).getByRole('button', { name: 'Change shortcut, No shortcut' })).toBeVisible()
    await user.click(within(row()).getByRole('button', { name: 'Reset Show the popup to its default' }))
    expect(popup.replace).toHaveBeenCalledWith('Alt+Shift+Space')
  })
})
