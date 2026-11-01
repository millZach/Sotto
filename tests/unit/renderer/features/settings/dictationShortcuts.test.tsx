import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { deferred } from '../../../../fixtures/deferred'
import { DictationShortcuts } from '../../../../../src/renderer/src/features/settings/DictationShortcuts'
import type { KeyListenerPermission, KeyRecordResult, SottoBridge } from '../../../../../src/shared/contracts'
import type { SottoPlatform } from '../../../../../src/shared/platform'

const owl = vi.hoisted(() => ({ on: false }))
vi.mock('../../../../../src/renderer/src/state/owlFeature', () => ({
  useOwlFeature: (id: string) => id === 'dictation-hold-shortcuts' && owl.on,
}))

afterEach(() => {
  cleanup()
  owl.on = false
  delete (window as { sotto?: unknown }).sotto
})

interface Options {
  readonly platform?: SottoPlatform
  readonly owl?: boolean
  readonly hotkey?: string
  readonly press?: readonly string[]
  readonly hold?: readonly string[]
  readonly standby?: boolean
  readonly bridge?: Partial<SottoBridge>
  readonly hotkeyResult?: Awaited<ReturnType<SottoBridge['replaceHotkey']>>
  readonly shortcutsResult?: { ok: true } | { ok: false; reason: 'conflict' | 'invalid' | 'unavailable'; chord?: string }
}

function setup(options: Options = {}) {
  const platform = options.platform ?? 'win32'
  owl.on = options.owl ?? false
  const bridge = { suspendDictationShortcuts: vi.fn(async () => ({ ok: true as const })), ...options.bridge }
  ;(window as { sotto?: unknown }).sotto = bridge
  const onReplaceHotkey = vi.fn(async (): Promise<Awaited<ReturnType<SottoBridge['replaceHotkey']>>> => options.hotkeyResult ?? { ok: true })
  const onReplaceDictationShortcuts = vi.fn(async () => options.shortcutsResult ?? { ok: true as const })
  const settings = {
    hotkey: options.hotkey ?? (platform === 'darwin' ? 'Control+Shift+Space' : 'CommandOrControl+Shift+Space'),
    pressShortcuts: [...options.press ?? []],
    holdShortcuts: [...options.hold ?? []],
    hotkeyStandby: options.standby ?? false,
  }
  render(<div className="settings-rows"><DictationShortcuts settings={settings} platform={platform} onReplaceHotkey={onReplaceHotkey} onReplaceDictationShortcuts={onReplaceDictationShortcuts} /></div>)
  return { bridge, onReplaceHotkey, onReplaceDictationShortcuts, user: userEvent.setup() }
}

const row = (name: string): HTMLElement => screen.getByRole('group', { name })
const press = (...codes: string[]): void => { for (const code of codes) fireEvent.keyDown(window, { code, key: code }) }
const release = (code: string): void => { fireEvent.keyUp(window, { code, key: code }) }

describe('DictationShortcuts', () => {
  it('shows stable one press row with no Add, no remove and no hold row', () => {
    setup()
    expect(screen.queryByRole('group', { name: 'Hold to dictate' })).not.toBeInTheDocument()
    const pressRow = row('Press to start and stop')
    expect(pressRow).toHaveAccessibleDescription('Press Ctrl + Shift + Space to start, and again to finish.')
    expect(within(pressRow).getByRole('button', { name: 'Change shortcut, Ctrl Shift Space' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /^Add a/u })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove shortcut/u })).not.toBeInTheDocument()
    expect(screen.getByText('Press Esc in any app to cancel a recording. Nothing is transcribed.')).toBeVisible()
  })

  it('shows both Owl rows with their chips, removes and Add buttons', () => {
    setup({ owl: true, press: ['CommandOrControl+Alt+K'], hold: ['CommandOrControl+Super'] })
    const holdRow = row('Hold to dictate')
    expect(holdRow).toHaveAccessibleDescription('Hold Ctrl + Win, speak, then let go.')
    expect(within(holdRow).getByRole('button', { name: 'Change shortcut, Ctrl Win' })).toBeVisible()
    expect(within(holdRow).getByRole('button', { name: 'Remove shortcut, Ctrl Win' })).toBeVisible()
    expect(within(holdRow).getByRole('button', { name: 'Add a hold shortcut' })).toBeVisible()
    const pressRow = row('Press to start and stop')
    expect(pressRow).toHaveAccessibleDescription('Press any of these to start, and again to finish.')
    expect(within(pressRow).getAllByRole('button', { name: /^Change shortcut/u })).toHaveLength(2)
    expect(within(pressRow).getByRole('button', { name: 'Add a start-and-stop shortcut' })).toBeVisible()
    const focusOrder = within(pressRow).getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent)
    expect(focusOrder).toEqual(['Change shortcut, Ctrl Shift Space', 'Remove shortcut, Ctrl Shift Space', 'Change shortcut, Ctrl Alt K', 'Remove shortcut, Ctrl Alt K', 'Add a start-and-stop shortcut'])
  })

  it('describes an empty hold row and hides Add once a row holds four', () => {
    setup({ owl: true, press: ['CommandOrControl+Alt+K', 'CommandOrControl+Alt+L', 'CommandOrControl+Alt+J'] })
    expect(row('Hold to dictate')).toHaveAccessibleDescription('Add a shortcut to talk only while you hold it.')
    expect(within(row('Press to start and stop')).queryByRole('button', { name: 'Add a start-and-stop shortcut' })).not.toBeInTheDocument()
  })

  it('records in the window with shortcuts suspended, saves on release and returns focus', async () => {
    const { bridge, onReplaceHotkey, user } = setup()
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift Space' }))
    expect(bridge.suspendDictationShortcuts).toHaveBeenLastCalledWith(true)
    expect(screen.getByText('Press the new keys…')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Hold the keys you want, then let go. Esc cancels.')
    expect(screen.getByRole('button', { name: 'Cancel recording' })).toHaveFocus()
    press('ControlLeft', 'AltLeft', 'KeyM')
    expect(screen.getByRole('status')).toHaveTextContent('Let go to save. Esc cancels.')
    expect(screen.getByLabelText('Ctrl+Alt+M')).toBeVisible()
    release('KeyM')
    await waitFor(() => expect(onReplaceHotkey).toHaveBeenCalledWith('CommandOrControl+Alt+M'))
    expect(bridge.suspendDictationShortcuts).toHaveBeenLastCalledWith(false)
    expect(await screen.findByRole('status')).toHaveTextContent('Shortcut saved.')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift Space' })).toHaveFocus())
  })

  it.each([
    ['Escape', () => press('Escape')],
    ['window blur', () => fireEvent.blur(window)],
    ['a click away', () => fireEvent.pointerDown(document.body)],
  ])('cancels a recording on %s without saving', async (_name, cancel) => {
    const { bridge, onReplaceHotkey, user } = setup()
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift Space' }))
    act(cancel)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift Space' })).toHaveFocus())
    expect(bridge.suspendDictationShortcuts).toHaveBeenLastCalledWith(false)
    expect(onReplaceHotkey).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('records through main with live chips when the listener can, and saves the whole set', async () => {
    const pending = deferred<KeyRecordResult>()
    let held: ((tokens: readonly string[]) => void) | undefined
    const { bridge, onReplaceDictationShortcuts, user } = setup({
      platform: 'darwin',
      owl: true,
      hold: ['Fn'],
      bridge: {
        recordDictationKeys: vi.fn(() => pending.promise),
        onDictationKeysHeld: vi.fn((listener) => { held = listener; return () => undefined }),
        getKeyListenerPermission: vi.fn(async () => 'granted' as const),
      },
    })
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Fn' }))
    expect(bridge.recordDictationKeys).toHaveBeenCalledOnce()
    expect(bridge.suspendDictationShortcuts).not.toHaveBeenCalled()
    act(() => held?.(['Fn', 'Shift']))
    expect(screen.getByRole('status')).toHaveTextContent('Let go to save. Esc cancels.')
    pending.resolve({ kind: 'recorded', chord: 'Fn+Shift' })
    await waitFor(() => expect(onReplaceDictationShortcuts).toHaveBeenCalledWith({ press: ['Control+Shift+Space'], hold: ['Fn+Shift'] }))
  })

  it('does nothing when main reports a cancelled recording, and cancels main from the Cancel control', async () => {
    const answers = [deferred<KeyRecordResult>(), deferred<KeyRecordResult>()]
    const record = vi.fn(() => answers[record.mock.calls.length - 1]!.promise)
    const cancelDictationKeyRecord = vi.fn(async () => ({ ok: true as const }))
    const { onReplaceDictationShortcuts, user } = setup({ platform: 'darwin', owl: true, hold: ['Fn'], bridge: { recordDictationKeys: record, cancelDictationKeyRecord } })
    const chip = screen.getByRole('button', { name: 'Change shortcut, Fn' })
    await user.click(chip)
    answers[0]!.resolve({ kind: 'cancelled' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change shortcut, Fn' })).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Fn' }))
    await user.click(screen.getByRole('button', { name: 'Cancel recording' }))
    expect(cancelDictationKeyRecord).toHaveBeenCalledOnce()
    expect(onReplaceDictationShortcuts).not.toHaveBeenCalled()
  })

  it('falls back to recording in the window when main cannot record', async () => {
    const { bridge, onReplaceDictationShortcuts, user } = setup({
      owl: true,
      hold: ['CommandOrControl+Super'],
      bridge: { recordDictationKeys: vi.fn(async () => ({ kind: 'unavailable' as const })) },
    })
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Win' }))
    await waitFor(() => expect(bridge.suspendDictationShortcuts).toHaveBeenCalledWith(true))
    press('ControlLeft', 'AltLeft')
    release('AltLeft')
    await waitFor(() => expect(onReplaceDictationShortcuts).toHaveBeenCalledWith({ press: ['CommandOrControl+Shift+Space'], hold: ['CommandOrControl+Alt'] }))
    expect(bridge.suspendDictationShortcuts).toHaveBeenLastCalledWith(false)
  })

  it.each([
    ['escape', {}, ['ControlLeft', 'Escape'], 'Escape', 'Esc cancels a recording, so it can’t start one. Pick other keys.'],
    ['plain-key', {}, ['KeyM'], 'KeyM', 'M on its own would start dictation while you type. Add a modifier such as Ctrl.'],
    ['needs-key', {}, ['ControlLeft', 'ShiftLeft'], 'ShiftLeft', 'Your main start-and-stop shortcut needs a key besides Fn and modifiers, so it works everywhere.'],
    ['needs-key in Owl', { owl: true }, ['ControlLeft', 'ShiftLeft'], 'ShiftLeft', 'Your main start-and-stop shortcut needs a key besides Fn and modifiers, so it works everywhere. Add this one with + Add instead.'],
    ['reserved', {}, ['AltLeft', 'F4'], 'F4', 'Windows uses Alt + F4 for closing windows. Pick other keys.'],
    ['duplicate', { owl: true, hold: ['CommandOrControl+Alt+H'] }, ['ControlLeft', 'AltLeft', 'KeyH'], 'KeyH', 'Hold to dictate already uses Ctrl + Alt + H.'],
    ['overlap', { owl: true, hold: ['CommandOrControl+Super'] }, ['ControlLeft', 'MetaLeft', 'KeyK'], 'KeyK', 'Holding Ctrl + Win would start dictation every time you press Ctrl + Win + K. Pick keys that don’t overlap.'],
  ] as const)('refuses %s with its message and keeps the shortcut', async (_code, options, keys, last, message) => {
    const { onReplaceHotkey, onReplaceDictationShortcuts, user } = setup(options)
    await user.click(within(row('Press to start and stop')).getByRole('button', { name: 'Change shortcut, Ctrl Shift Space' }))
    press(...keys)
    release(last)
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(onReplaceHotkey).not.toHaveBeenCalled()
    expect(onReplaceDictationShortcuts).not.toHaveBeenCalled()
    // Focus comes back one render after the alert, once the refused save has settled.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift Space' })).toHaveFocus())
  })

  it('keeps the previous chips and names both shortcuts when another app holds the new one', async () => {
    const { user } = setup({ hotkeyResult: { ok: false, reason: 'conflict' } })
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift Space' }))
    press('ControlLeft', 'AltLeft', 'KeyM')
    release('KeyM')
    expect(await screen.findByRole('alert')).toHaveTextContent('Another app already uses Ctrl + Alt + M. Ctrl + Shift + Space still works. Pick other keys, or free that shortcut in the other app.')
    expect(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift Space' })).toBeVisible()
  })

  it('names the refused chord from main and says the old one still works when saving fails', async () => {
    const { user } = setup({ owl: true, hold: ['CommandOrControl+Super'], shortcutsResult: { ok: false, reason: 'unavailable' } })
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Win' }))
    press('ControlLeft', 'AltLeft')
    release('AltLeft')
    expect(await screen.findByRole('alert')).toHaveTextContent('The shortcut could not be changed. Ctrl + Win still works.')
  })

  it('hides remove on the last shortcut', () => {
    setup({ owl: true })
    expect(screen.queryByRole('button', { name: /^Remove shortcut/u })).not.toBeInTheDocument()
  })

  it('puts the main shortcut on standby when only shortcuts the key listener runs could replace it', async () => {
    const { onReplaceDictationShortcuts, user } = setup({ owl: true, press: ['CommandOrControl+Alt'] })
    await user.click(screen.getByRole('button', { name: 'Remove shortcut, Ctrl Shift Space' }))
    expect(onReplaceDictationShortcuts).toHaveBeenCalledWith({ press: ['CommandOrControl+Shift+Space', 'CommandOrControl+Alt'], hold: [], standby: true })
  })

  it('hides a main shortcut on standby and turns it back on', async () => {
    const { onReplaceDictationShortcuts, user } = setup({ owl: true, press: ['CommandOrControl+Alt'], standby: true })
    const pressRow = row('Press to start and stop')
    expect(within(pressRow).queryByRole('button', { name: 'Change shortcut, Ctrl Shift Space' })).not.toBeInTheDocument()
    expect(pressRow).toHaveAccessibleDescription('Press Ctrl + Alt to start, and again to finish.')
    await user.click(screen.getByRole('button', { name: 'Turn Ctrl + Shift + Space back on' }))
    expect(onReplaceDictationShortcuts).toHaveBeenCalledWith({ press: ['CommandOrControl+Shift+Space', 'CommandOrControl+Alt'], hold: [], standby: false })
  })

  it('promotes the first registerable extra when the main shortcut is removed', async () => {
    const { onReplaceDictationShortcuts, user } = setup({ owl: true, press: ['CommandOrControl+Alt', 'CommandOrControl+Alt+K'], hold: ['CommandOrControl+Super'] })
    await user.click(screen.getByRole('button', { name: 'Remove shortcut, Ctrl Shift Space' }))
    expect(onReplaceDictationShortcuts).toHaveBeenCalledWith({ press: ['CommandOrControl+Alt+K', 'CommandOrControl+Alt'], hold: ['CommandOrControl+Super'] })
    expect(await screen.findByRole('status')).toHaveTextContent('Shortcut saved.')
  })

  it('records straight away from Add on macOS too', async () => {
    const { user } = setup({ platform: 'darwin', owl: true })
    await user.click(within(row('Hold to dictate')).getByRole('button', { name: 'Add a hold shortcut' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel recording' })).toHaveFocus()
  })

  it('records straight away from Add on Windows', async () => {
    const { onReplaceDictationShortcuts, user } = setup({ owl: true })
    await user.click(within(row('Hold to dictate')).getByRole('button', { name: 'Add a hold shortcut' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel recording' })).toHaveFocus()
    press('ControlLeft', 'MetaLeft')
    release('MetaLeft')
    await waitFor(() => expect(onReplaceDictationShortcuts).toHaveBeenCalledWith({ press: ['CommandOrControl+Shift+Space'], hold: ['CommandOrControl+Super'] }))
  })

  it('asks for Input Monitoring when denied, dims listener shortcuts and follows the answer', async () => {
    let push: ((permission: KeyListenerPermission) => void) | undefined
    const requestKeyListenerPermission = vi.fn(async () => 'denied' as const)
    const { user } = setup({
      platform: 'darwin',
      owl: true,
      hold: ['Fn'],
      bridge: {
        getKeyListenerPermission: vi.fn(async () => 'denied' as const),
        requestKeyListenerPermission,
        onKeyListenerPermission: vi.fn((listener) => { push = listener; return () => undefined }),
      },
    })
    expect(await screen.findByText('Holding a shortcut, and Fn, need Input Monitoring. Sotto watches only modifier keys and your shortcuts’ keys, and keeps nothing it sees.')).toBeVisible()
    expect(screen.getByText('After an update, macOS may need you to turn Sotto off and on again in that list.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Change shortcut, Fn' }).parentElement).toHaveClass('is-dimmed')
    expect(screen.getByRole('button', { name: 'Change shortcut, Control Shift Space' }).parentElement).not.toHaveClass('is-dimmed')
    await user.click(screen.getByRole('button', { name: 'Open System Settings' }))
    expect(requestKeyListenerPermission).toHaveBeenCalledOnce()
    act(() => push?.('granted'))
    expect(screen.queryByRole('button', { name: 'Open System Settings' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change shortcut, Fn' }).parentElement).not.toHaveClass('is-dimmed')
  })

  it('never asks about the listener in stable', () => {
    const getKeyListenerPermission = vi.fn(async () => 'denied' as const)
    setup({ platform: 'darwin', hold: ['Fn'], bridge: { getKeyListenerPermission } })
    expect(getKeyListenerPermission).not.toHaveBeenCalled()
    expect(screen.queryByText(/Input Monitoring/u)).not.toBeInTheDocument()
  })

  it('shows the Fn tip on macOS only while a shortcut uses Fn', () => {
    const tip = 'If Fn opens emoji or Apple’s dictation, set System Settings › Keyboard › “Press 🌐 key to” to Do Nothing.'
    setup({ platform: 'darwin', owl: true, hold: ['Fn'] })
    expect(screen.getByText(tip)).toBeVisible()
    cleanup()
    setup({ platform: 'darwin', owl: true })
    expect(screen.queryByText(tip)).not.toBeInTheDocument()
  })

  it('treats the same keys in another spelling as saved without asking main', async () => {
    const { onReplaceHotkey, user } = setup({ hotkey: 'Shift+Ctrl+Space' })
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Shift Ctrl Space' }))
    press('ControlLeft', 'ShiftLeft', 'Space')
    release('Space')
    expect(await screen.findByRole('status')).toHaveTextContent('Shortcut saved.')
    expect(onReplaceHotkey).not.toHaveBeenCalled()
  })

  it.each([['Enter', 'Enter'], ['Space', ' ']])('cancels with %s on the focused Cancel control instead of recording it', async (code, key) => {
    const { onReplaceHotkey, user } = setup()
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift Space' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel recording' }), { code, key })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift Space' })).toHaveFocus())
    expect(onReplaceHotkey).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps Space with a modifier or Fn held as part of a chord recorded through main, and cancels on Space alone', async () => {
    const pending = deferred<KeyRecordResult>()
    let held: ((tokens: readonly string[]) => void) | undefined
    const cancelDictationKeyRecord = vi.fn(async () => ({ ok: true as const }))
    const { onReplaceDictationShortcuts, user } = setup({
      platform: 'darwin',
      owl: true,
      hold: ['Fn'],
      bridge: {
        recordDictationKeys: vi.fn(() => pending.promise),
        cancelDictationKeyRecord,
        onDictationKeysHeld: vi.fn((listener) => { held = listener; return () => undefined }),
        getKeyListenerPermission: vi.fn(async () => 'granted' as const),
      },
    })
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Fn' }))
    const cancel = screen.getByRole('button', { name: 'Cancel recording' })
    fireEvent.keyDown(cancel, { code: 'Space', key: ' ', ctrlKey: true, shiftKey: true })
    act(() => held?.(['Fn']))
    fireEvent.keyDown(cancel, { code: 'Space', key: ' ' })
    expect(cancelDictationKeyRecord).not.toHaveBeenCalled()
    pending.resolve({ kind: 'recorded', chord: 'Fn+Shift+Space' })
    await waitFor(() => expect(onReplaceDictationShortcuts).toHaveBeenCalledWith({ press: ['Control+Shift+Space'], hold: ['Fn+Shift+Space'] }))
  })

  it('cancels a recording through main on Space alone at the Cancel control', async () => {
    const cancelDictationKeyRecord = vi.fn(async () => ({ ok: true as const }))
    const { onReplaceDictationShortcuts, user } = setup({
      platform: 'darwin',
      owl: true,
      hold: ['Fn'],
      bridge: {
        recordDictationKeys: vi.fn(() => deferred<KeyRecordResult>().promise),
        cancelDictationKeyRecord,
        getKeyListenerPermission: vi.fn(async () => 'granted' as const),
      },
    })
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Fn' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel recording' }), { code: 'Space', key: ' ' })
    expect(cancelDictationKeyRecord).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change shortcut, Fn' })).toHaveFocus())
    expect(onReplaceDictationShortcuts).not.toHaveBeenCalled()
  })

  it('ignores a lock key going up mid-chord instead of saving the modifiers alone', async () => {
    const { onReplaceHotkey, user } = setup()
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift Space' }))
    press('ControlLeft', 'AltLeft', 'CapsLock')
    release('CapsLock')
    press('KeyJ')
    release('KeyJ')
    await waitFor(() => expect(onReplaceHotkey).toHaveBeenCalledWith('CommandOrControl+Alt+J'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each(['Fn', 'CapsLock', 'NumLock'])('ignores %s in the page recorder instead of refusing the chord', async (code) => {
    const { onReplaceHotkey, user } = setup()
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift Space' }))
    press(code, 'ControlLeft', 'AltLeft', 'F5')
    release('F5')
    await waitFor(() => expect(onReplaceHotkey).toHaveBeenCalledWith('CommandOrControl+Alt+F5'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps a newer recording that started without a pointerdown', async () => {
    const { onReplaceDictationShortcuts } = setup({ owl: true, hold: ['CommandOrControl+Super'] })
    fireEvent.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Win' }))
    fireEvent.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift Space' }))
    await act(async () => undefined)
    expect(within(row('Press to start and stop')).getByRole('button', { name: 'Cancel recording' })).toBeVisible()
    press('ControlLeft', 'AltLeft', 'KeyP')
    release('KeyP')
    await waitFor(() => expect(onReplaceDictationShortcuts).toHaveBeenCalledWith({ press: ['CommandOrControl+Alt+P'], hold: ['CommandOrControl+Super'] }))
  })

  it('gives up a window recording after 30 seconds', async () => {
    vi.useFakeTimers()
    try {
      const { bridge } = setup()
      fireEvent.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift Space' }))
      act(() => { vi.advanceTimersByTime(29_999) })
      expect(screen.getByRole('button', { name: 'Cancel recording' })).toBeVisible()
      await act(async () => { vi.advanceTimersByTime(1) })
      expect(screen.queryByRole('button', { name: 'Cancel recording' })).not.toBeInTheDocument()
      expect(bridge.suspendDictationShortcuts).toHaveBeenLastCalledWith(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses listener chords when main says no key listener can run', async () => {
    const { onReplaceDictationShortcuts, user } = setup({ owl: true, bridge: { getKeyListenerPermission: vi.fn(async () => 'unsupported' as const) } })
    await act(async () => undefined)
    await user.click(within(row('Hold to dictate')).getByRole('button', { name: 'Add a hold shortcut' }))
    press('ControlLeft', 'MetaLeft')
    release('MetaLeft')
    expect(await screen.findByRole('alert')).toHaveTextContent('Your main start-and-stop shortcut needs a key besides Fn and modifiers, so it works everywhere.')
    expect(onReplaceDictationShortcuts).not.toHaveBeenCalled()
  })

  it('refuses a single modifier', async () => {
    const { user } = setup({ owl: true })
    await user.click(within(row('Hold to dictate')).getByRole('button', { name: 'Add a hold shortcut' }))
    press('ShiftLeft')
    release('ShiftLeft')
    expect(await screen.findByRole('alert')).toHaveTextContent('Shift on its own is part of too many shortcuts. Use two modifiers together.')
  })

  const unsupported = 'That key can’t be part of a shortcut. Try a letter, a number, an F key, Space or an arrow key.'

  it.each(['Minus', 'Comma', 'Period', 'Slash', 'BracketLeft', 'Backquote', 'Numpad1'].flatMap((code) => [[code, false], [code, true]] as const))(
    'refuses Ctrl+Shift+%s in the window recorder (Owl %s) and saves nothing', async (code, owlOn) => {
      const { onReplaceHotkey, onReplaceDictationShortcuts, user } = setup({ owl: owlOn })
      await user.click(within(row('Press to start and stop')).getByRole('button', { name: 'Change shortcut, Ctrl Shift Space' }))
      press('ControlLeft', 'ShiftLeft', code)
      release(code)
      expect(await screen.findByRole('alert')).toHaveTextContent(unsupported)
      expect(screen.queryByRole('button', { name: 'Cancel recording' })).not.toBeInTheDocument()
      expect(onReplaceHotkey).not.toHaveBeenCalled()
      expect(onReplaceDictationShortcuts).not.toHaveBeenCalled()
    })

  it('shows the unsupported-key refusal when main reports one', async () => {
    const { onReplaceDictationShortcuts, user } = setup({
      platform: 'darwin',
      owl: true,
      hold: ['Fn'],
      bridge: { recordDictationKeys: vi.fn(async () => ({ kind: 'unsupported-key' as const })) },
    })
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Fn' }))
    expect(await within(row('Hold to dictate')).findByRole('alert')).toHaveTextContent(unsupported)
    expect(onReplaceDictationShortcuts).not.toHaveBeenCalled()
  })

  it('keeps an older save’s slow conflict from overwriting a newer save’s answer', async () => {
    const { onReplaceHotkey, user } = setup()
    const slow = deferred<Awaited<ReturnType<SottoBridge['replaceHotkey']>>>()
    onReplaceHotkey.mockImplementationOnce(() => slow.promise)
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift Space' }))
    press('ControlLeft', 'AltLeft', 'KeyM')
    release('KeyM')
    await waitFor(() => expect(onReplaceHotkey).toHaveBeenCalledWith('CommandOrControl+Alt+M'))
    await user.click(screen.getByRole('button', { name: 'Change shortcut, Ctrl Shift Space' }))
    press('ControlLeft', 'AltLeft', 'KeyN')
    release('KeyN')
    expect(await screen.findByRole('status')).toHaveTextContent('Shortcut saved.')
    await act(async () => slow.resolve({ ok: false, reason: 'conflict' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Shortcut saved.')
  })
})
