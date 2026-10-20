import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LinuxDictationShortcuts } from '../../../../../src/renderer/src/features/settings/LinuxDictationShortcuts'
import type { DictationShortcutsResult, HotkeyChangeResult } from '../../../../../src/shared/contracts'
import { setupBridgeFixture, setupState } from '../../../../fixtures/renderer/omarchySetup'

const owl = vi.hoisted(() => ({ on: false }))
vi.mock('../../../../../src/renderer/src/state/owlFeature', () => ({
  useOwlFeature: (id: string) => id === 'dictation-hold-shortcuts' && owl.on,
}))

afterEach(() => {
  cleanup()
  owl.on = false
  delete (window as { sotto?: unknown }).sotto
})

const LINUX = { hotkey: 'Super+CommandOrControl+X', pressShortcuts: [], holdShortcuts: ['F9'] }

function setup(options: { owl?: boolean; keys?: Parameters<typeof setupState>[0]; hotkeyResult?: HotkeyChangeResult; shortcutsResult?: DictationShortcutsResult } = {}) {
  owl.on = options.owl ?? false
  const omarchy = setupBridgeFixture(setupState(options.keys ?? 'done'))
  let taken: ((role: 'press' | 'hold') => void) | undefined
  const bridge = {
    omarchySetup: omarchy.bridge,
    suspendDictationShortcuts: vi.fn(async () => ({ ok: true as const })),
    onDictationKeysTaken: vi.fn((listener: (role: 'press' | 'hold') => void) => { taken = listener; return () => { taken = undefined } }),
  }
  ;(window as { sotto?: unknown }).sotto = bridge
  const onReplaceHotkey = vi.fn(async () => options.hotkeyResult ?? { ok: true as const })
  const onReplaceDictationShortcuts = vi.fn(async () => options.shortcutsResult ?? { ok: true as const })
  render(<LinuxDictationShortcuts settings={LINUX} visible onReplaceHotkey={onReplaceHotkey} onReplaceDictationShortcuts={onReplaceDictationShortcuts} />)
  return { omarchy, bridge, onReplaceHotkey, onReplaceDictationShortcuts, taken: (role: 'press' | 'hold') => taken?.(role) }
}

const pressRow = (): HTMLElement => screen.getByRole('group', { name: 'Press to start and stop' })
const keyDown = (...codes: string[]): void => { for (const code of codes) fireEvent.keyDown(window, { code, key: code }) }
const keyUp = (code: string): void => { fireEvent.keyUp(window, { code, key: code }) }

describe('Dictation shortcuts on Linux', () => {
  it('shows stable’s one press row in Omarchy’s words, and Sotto’s keys under Omarchy', async () => {
    setup()
    expect(screen.queryByRole('group', { name: 'Hold to dictate' })).not.toBeInTheDocument()
    expect(pressRow()).toHaveAccessibleDescription('Press Super + Ctrl + X to start, and again to finish.')
    expect(await within(pressRow()).findByRole('button', { name: 'Change shortcut, Super Ctrl X' })).toBeEnabled()
    expect(screen.getByText('F9 and Super+Ctrl+X')).toBeVisible()
    expect(screen.getByText(/These shortcuts are Hyprland bindings/u)).toBeVisible()
    expect(screen.queryByText('Press Esc in any app to cancel a recording. Nothing is transcribed.')).not.toBeInTheDocument()
  })

  it('records a new press shortcut in the page and saves it through main', async () => {
    const { onReplaceHotkey, bridge } = setup()
    await userEvent.click(await within(pressRow()).findByRole('button', { name: 'Change shortcut, Super Ctrl X' }))
    expect(bridge.suspendDictationShortcuts).toHaveBeenCalledWith(true)
    keyDown('MetaLeft', 'AltLeft', 'KeyD')
    keyUp('KeyD')
    await waitFor(() => expect(onReplaceHotkey).toHaveBeenCalledWith('Super+Alt+D'))
    expect(await screen.findByText('Shortcut saved.')).toBeVisible()
    expect(bridge.suspendDictationShortcuts).toHaveBeenLastCalledWith(false)
  })

  it('shows Hyprland’s refusal in the row and names the shortcut that still works', async () => {
    setup({ hotkeyResult: { ok: false, reason: 'conflict', message: 'Hyprland already uses Super+Alt+D for “Open notes”. Pick other keys.' } })
    await userEvent.click(await within(pressRow()).findByRole('button', { name: 'Change shortcut, Super Ctrl X' }))
    keyDown('MetaLeft', 'AltLeft', 'KeyD')
    keyUp('KeyD')
    expect(await within(pressRow()).findByRole('alert')).toHaveTextContent('Hyprland already uses Super+Alt+D for “Open notes”. Pick other keys. Super + Ctrl + X still works.')
  })

  it('says a key Hyprland kept never reached the recording', async () => {
    const { onReplaceHotkey } = setup()
    await userEvent.click(await within(pressRow()).findByRole('button', { name: 'Change shortcut, Super Ctrl X' }))
    // Hyprland ran its own binding for the key, so only the modifiers arrived.
    keyDown('MetaLeft')
    keyUp('MetaLeft')
    expect(await within(pressRow()).findByRole('alert')).toHaveTextContent('If you pressed one, Hyprland already uses it')
    expect(onReplaceHotkey).not.toHaveBeenCalled()
  })

  it('ends a recording when one of Sotto’s own bindings fires, without saving', async () => {
    const { onReplaceHotkey, taken } = setup()
    await userEvent.click(await within(pressRow()).findByRole('button', { name: 'Change shortcut, Super Ctrl X' }))
    act(() => taken('hold'))
    expect(await within(pressRow()).findByRole('alert')).toHaveTextContent('Sotto’s hold-to-talk shortcut already uses those keys. Pick other keys.')
    expect(onReplaceHotkey).not.toHaveBeenCalled()
  })

  it('refuses the press row the hold shortcut’s key in stable, though the hold row is not shown', async () => {
    const { onReplaceHotkey } = setup()
    await userEvent.click(await within(pressRow()).findByRole('button', { name: 'Change shortcut, Super Ctrl X' }))
    keyDown('F9')
    keyUp('F9')
    expect(await within(pressRow()).findByRole('alert')).toHaveTextContent('Hold to dictate already uses F9.')
    expect(onReplaceHotkey).not.toHaveBeenCalled()
  })

  it('says the keys are not set up yet and offers the setup, without writing a file on its own', async () => {
    const { omarchy } = setup({ keys: 'missing' })
    expect(await screen.findByText(/Sotto’s keys aren’t set up in Hyprland yet/u)).toBeVisible()
    expect(within(pressRow()).getByRole('button', { name: 'Change shortcut, Super Ctrl X' })).toBeDisabled()
    expect(omarchy.calls).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'Set up the keys' }))
    expect(omarchy.calls).toEqual([{ type: 'setup', pieces: ['keys'], keys: 'unconfirmed' }])
    await waitFor(() => expect(within(pressRow()).getByRole('button', { name: 'Change shortcut, Super Ctrl X' })).toBeEnabled())
  })

  it('leaves keys set up by hand alone', async () => {
    setup({ keys: 'manual' })
    expect(await screen.findByText('Your bindings.lua gives Sotto its keys by hand, so Sotto leaves them alone. Change them there.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Set up the keys' })).not.toBeInTheDocument()
  })

  it('shows the hold row with F9, and saves both rows at once, with the Owl feature on', async () => {
    const { onReplaceDictationShortcuts } = setup({ owl: true })
    const holdRow = screen.getByRole('group', { name: 'Hold to dictate' })
    expect(holdRow).toHaveAccessibleDescription('Hold F9, speak, then let go.')
    await userEvent.click(await within(holdRow).findByRole('button', { name: 'Change shortcut, F9' }))
    keyDown('F10')
    keyUp('F10')
    await waitFor(() => expect(onReplaceDictationShortcuts).toHaveBeenCalledWith({ press: ['Super+CommandOrControl+X'], hold: ['F10'] }))
    // Linux has no Fn menu: + Add records straight away.
    expect(within(holdRow).getByRole('button', { name: 'Add a hold shortcut' })).not.toHaveAttribute('aria-haspopup')
  })
})
