import { deferred, baseProps, copy, selectCategory } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import { platformCopy } from '../../../../../src/renderer/src/platformCopy'
import { type HotkeyChangeResult } from '../../../../../src/shared/contracts'
import { DEFAULT_SETTINGS } from '../../../../../src/shared/settings'

describe('SettingsView', () => {
  it('does not save or announce unchanged shortcut and numeric fields on blur', async () => {
    const props = baseProps()
    render(<SettingsView {...props} />)
    const hotkey = screen.getByRole('textbox', { name: 'Global shortcut' })
    fireEvent.blur(hotkey)
    fireEvent.change(hotkey, { target: { value: 'Control+Shift+Space' } })
    fireEvent.blur(hotkey)
    await selectCategory('Output')
    for (const name of ['Paste delay', 'Success message duration']) {
      const input = screen.getByRole('textbox', { name })
      fireEvent.blur(input)
      fireEvent.change(input, { target: { value: ` ${String((input as HTMLInputElement).value)} ` } })
      fireEvent.blur(input)
    }
    expect(props.onReplaceHotkey).not.toHaveBeenCalled()
    expect(props.onUpdateSettings).not.toHaveBeenCalled()
    expect(document.querySelector('.settings-notice')).not.toBeInTheDocument()
  })

  it('preserves quick cleanup changes before their settings publications arrive', async () => {
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Application')
    await userEvent.click(screen.getByRole('switch', { name: 'Remove a worktree when its thread is settled' }))
    await userEvent.click(screen.getByRole('switch', { name: 'Remove a worktree when its pull request is merged' }))
    expect(update.mock.calls).toEqual([
      [{ worktreeCleanup: { onSettle: true } }],
      [{ worktreeCleanup: { merged: true } }],
    ])
  })

  it('saves the widget idle-visibility preference through the ordinary patch flow', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Application')

    await user.click(screen.getByRole('switch', { name: 'Show floating widget when idle' }))

    expect(update).toHaveBeenCalledWith({ showWidgetWhenIdle: false })
  })

  it('turns showing the browser when an agent opens a page off through the ordinary patch flow', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Application')

    const toggle = screen.getByRole('switch', { name: 'Show the browser when an agent opens a page' })
    expect(toggle).toBeChecked()
    await user.click(toggle)

    expect(update).toHaveBeenCalledWith({ showBrowserPreviews: false })
  })

  it('turns letting agents use the browser without asking off through the ordinary patch flow (ADR-0029)', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Application')

    const toggle = screen.getByRole('switch', { name: 'Let agents use the browser without asking' })
    expect(toggle).toBeChecked()
    await user.click(toggle)

    expect(update).toHaveBeenCalledWith({ browserWithoutAsking: false })
  })

  it('turns letting agents draw visuals in threads off through the ordinary patch flow (ADR-0056)', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Application')

    const toggle = screen.getByRole('switch', { name: 'Let agents draw visuals in threads' })
    expect(toggle).toBeChecked()
    await user.click(toggle)

    expect(update).toHaveBeenCalledWith({ visualsInThreads: false })
  })

  it('resynchronizes numeric drafts from authoritative settings', async () => {
    const user = userEvent.setup()
    const props = baseProps()
    const rendered = render(<SettingsView {...props} />)
    await selectCategory('Output')
    const delay = screen.getByRole('textbox', { name: 'Paste delay' })
    await user.clear(delay)
    await user.type(delay, '999')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, pasteDelayMs: 275 }} />)
    expect(delay).toHaveValue('275')
  })

  it('rolls back a conflicting hotkey with a specialized finite message', async () => {
    const user = userEvent.setup()
    const replace = vi.fn(async () => ({ ok: false as const, reason: 'conflict' as const }))
    render(<SettingsView {...baseProps({ onReplaceHotkey: replace })} />)
    const input = screen.getByRole('textbox', { name: 'Global shortcut' })
    await user.clear(input)
    await user.type(input, 'Ctrl+Alt+Space')
    await user.tab()
    expect(replace).toHaveBeenCalledWith('CommandOrControl+Alt+Space')
    expect(input).toHaveValue('Ctrl+Shift+Space')
    expect(screen.getByRole('alert')).toHaveTextContent(/another application is already using/i)
  })

  it('shows Windows-friendly shortcut text and translates edits to Electron canonical form', async () => {
    const user = userEvent.setup()
    const replace = vi.fn(async () => ({ ok: true as const }))
    render(<SettingsView {...baseProps({ onReplaceHotkey: replace })} />)
    const input = screen.getByRole('textbox', { name: 'Global shortcut' })

    expect(input).toHaveValue('Ctrl+Shift+Space')
    expect(input).not.toHaveValue(expect.stringContaining('CommandOrControl'))
    await user.clear(input)
    await user.type(input, 'Ctrl+Alt+M')
    await user.tab()

    expect(replace).toHaveBeenCalledWith('CommandOrControl+Alt+M')
  })

  it('rolls a delayed hotkey conflict back to the newest authoritative shortcut', async () => {
    const user = userEvent.setup()
    let resolve!: (result: HotkeyChangeResult) => void
    const replace = vi.fn(() => new Promise<HotkeyChangeResult>((done) => { resolve = done }))
    const props = baseProps({ onReplaceHotkey: replace })
    const rendered = render(<SettingsView {...props} />)
    const input = screen.getByRole('textbox', { name: 'Global shortcut' })
    await user.clear(input)
    await user.type(input, 'Ctrl+Alt+Space')
    await user.tab()
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, hotkey: 'Ctrl+Shift+M' }} />)
    resolve({ ok: false, reason: 'conflict' })
    await waitFor(() => expect(input).toHaveValue('Ctrl+Shift+M'))
  })

  it('does not let an older hotkey result clobber a newer draft, but accepts newer external authority', async () => {
    const user = userEvent.setup()
    const pending = deferred<HotkeyChangeResult>()
    const props = baseProps({ onReplaceHotkey: vi.fn(() => pending.promise) })
    const rendered = render(<SettingsView {...props} />)
    const input = screen.getByRole('textbox', { name: 'Global shortcut' })
    await user.clear(input)
    await user.type(input, 'Ctrl+Alt+Space')
    await user.tab()
    await user.clear(input)
    await user.type(input, 'Ctrl+Shift+N')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, hotkey: 'Ctrl+Alt+Space' }} />)
    pending.resolve({ ok: false, reason: 'conflict' })
    await act(async () => undefined)
    expect(input).toHaveValue('Ctrl+Shift+N')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, hotkey: 'Alt+M' }} />)
    expect(input).toHaveValue('Alt+M')
  })

  it('rejects invalid numeric drafts before IPC and enforces documented bounds', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Output')
    const delay = screen.getByRole('textbox', { name: 'Paste delay' })
    await user.clear(delay)
    await user.type(delay, '49')
    await user.tab()
    expect(update).not.toHaveBeenCalledWith({ pasteDelayMs: 49 })
    expect(screen.getByText(/between 50 and 1000/i)).toBeVisible()
    const duration = screen.getByRole('textbox', { name: 'Success message duration' })
    await user.clear(duration)
    await user.type(duration, 'not a number')
    await user.tab()
    expect(update).not.toHaveBeenCalled()
  })

  it('does not let an older numeric save clobber a newer draft, but accepts newer external authority', async () => {
    const user = userEvent.setup()
    const pending = deferred<boolean>()
    const update = vi.fn(() => pending.promise)
    const props = baseProps({ onUpdateSettings: update })
    const rendered = render(<SettingsView {...props} />)
    await selectCategory('Output')
    const delay = screen.getByRole('textbox', { name: 'Paste delay' })
    await user.clear(delay)
    await user.type(delay, '300')
    await user.tab()
    await user.clear(delay)
    await user.type(delay, '450')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, pasteDelayMs: 300 }} />)
    pending.resolve(false)
    await act(async () => undefined)
    expect(delay).toHaveValue('450')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, pasteDelayMs: 625 }} />)
    expect(delay).toHaveValue('625')
  })

  it('applies the same response ordering to the success-duration draft', async () => {
    const user = userEvent.setup()
    const pending = deferred<boolean>()
    const update = vi.fn(() => pending.promise)
    const props = baseProps({ onUpdateSettings: update })
    const rendered = render(<SettingsView {...props} />)
    await selectCategory('Output')
    const duration = screen.getByRole('textbox', { name: 'Success message duration' })
    await user.clear(duration)
    await user.type(duration, '1500')
    await user.tab()
    await user.clear(duration)
    await user.type(duration, '2200')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, successDisplayMs: 1500 }} />)
    pending.resolve(false)
    await act(async () => undefined)
    expect(duration).toHaveValue('2200')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, successDisplayMs: 3100 }} />)
    expect(duration).toHaveValue('3100')
  })

  it('preserves an unknown persisted language and labels auto honestly', async () => {
    render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, language: 'cy' } })} />)
    await selectCategory('Transcription')
    expect(screen.getByRole('option', { name: 'Saved language (cy)' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'Automatic (detect language)' })).toBeVisible()
    expect(screen.queryByText(/auto-detect/i)).not.toBeInTheDocument()
  })

  it('says where to allow the login item when macOS waits for approval', async () => {
    const user = userEvent.setup()
    const startup = vi.fn(async (enabled: boolean) => ({ enabled, approvalRequired: true }))
    render(<SettingsView {...baseProps({ onSetStartup: startup })} />)
    await selectCategory('Application')
    await user.click(screen.getByRole('switch', { name: copy.settingsLaunchAtStartupLabel }))
    expect(await screen.findByText('Sotto starts at login once you allow it in System Settings > General > Login Items.')).toBeVisible()
  })

  it('wires startup, auto-paste, retention, reset, and clear-history controls', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    const startup = vi.fn(async (enabled) => ({ enabled }))
    const reset = vi.fn(async () => true)
    const clear = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update, onSetStartup: startup, onResetSettings: reset, onClearHistory: clear })} />)
    await selectCategory('Output')
    await user.click(screen.getByRole('switch', { name: 'Automatic paste' }))
    await selectCategory('Application')
    await user.selectOptions(screen.getByRole('combobox', { name: 'History retention' }), '500')
    await user.click(screen.getByRole('switch', { name: copy.settingsLaunchAtStartupLabel }))
    expect(update).toHaveBeenCalledWith({ autoPaste: false })
    expect(update).toHaveBeenCalledWith({ historyRetention: 500 })
    expect(startup).toHaveBeenCalledWith(true)

    await user.click(screen.getByRole('button', { name: /reset settings/i }))
    await user.click(screen.getByRole('button', { name: /reset all settings/i }))
    expect(reset).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: /clear history/i }))
    await user.click(screen.getByRole('button', { name: /clear all transcripts/i }))
    expect(clear).toHaveBeenCalledOnce()
  })

  it('wires the remaining capture, transcription, motion, minimized, and privacy fields', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Application')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Reduced motion' }), 'on')
    await selectCategory('Dictation')
    await user.click(screen.getByRole('radio', { name: '2 min' }))
    await user.click(screen.getByRole('switch', { name: 'Sound cues' }))
    await selectCategory('Transcription')
    await user.click(screen.getByRole('switch', { name: 'Whitespace formatting' }))
    await selectCategory('Application')
    await user.click(screen.getByRole('switch', { name: 'Start minimized' }))
    expect(screen.getByText('Store transcript text locally for search and reuse. Turning this off also deletes saved checkpoints at once.')).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Keep local history' }))
    expect(update).toHaveBeenCalledWith({ reducedMotion: 'on' })
    expect(update).toHaveBeenCalledWith({ maxRecordingSeconds: 120 })
    expect(update).toHaveBeenCalledWith({ soundCues: false })
    expect(update).toHaveBeenCalledWith({ formatWhitespace: false })
    expect(update).toHaveBeenCalledWith({ startMinimized: true })
    expect(update).toHaveBeenCalledWith({ historyEnabled: false })
  })

  it('renders the macOS copy row and canonicalizes shortcuts through the darwin aliases', async () => {
    const user = userEvent.setup()
    const macCopy = platformCopy('darwin')
    const replace = vi.fn(async () => ({ ok: true as const }))
    render(<SettingsView {...baseProps({ platform: 'darwin', onReplaceHotkey: replace })} />)
    await selectCategory('Application')

    expect(screen.getByRole('switch', { name: macCopy.settingsLaunchAtStartupLabel })).toBeVisible()
    expect(screen.getByText(macCopy.settingsReducedMotionDescription)).toBeVisible()
    expect(screen.queryByRole('switch', { name: copy.settingsLaunchAtStartupLabel })).not.toBeInTheDocument()
    await selectCategory('Output')
    expect(screen.getByText(macCopy.settingsAutoPasteDescription)).toBeVisible()
    await selectCategory('Dictation')
    expect(screen.getByRole('option', { name: macCopy.settingsMicrophoneDefaultOption })).toBeVisible()
    expect(screen.getByText(macCopy.settingsGlobalShortcutDescription)).toBeVisible()

    const input = screen.getByRole('textbox', { name: 'Global shortcut' })
    expect(input).toHaveValue('Command+Shift+Space')
    await user.clear(input)
    await user.type(input, 'Control+Shift+Space')
    await user.tab()

    expect(replace).toHaveBeenCalledWith('Control+Shift+Space')
  })
})

it('keeps external numeric authority after an ignored old receipt and a later failed edit', async () => {
  const answers: ReturnType<typeof deferred<boolean>>[] = []
  const update = vi.fn(() => { const pending = deferred<boolean>(); answers.push(pending); return pending.promise })
  const props = baseProps({ onUpdateSettings: update })
  const view = render(<SettingsView {...props} />)
  await selectCategory('Output')
  const input = screen.getByRole('textbox', { name: 'Paste delay' })
  fireEvent.change(input, { target: { value: '300' } })
  fireEvent.blur(input)
  view.rerender(<SettingsView {...props} settings={{ ...props.settings, pasteDelayMs: 625 }} />)
  expect(input).toHaveValue('625')
  view.rerender(<SettingsView {...props} settings={{ ...props.settings, pasteDelayMs: 300 }} />)
  await act(async () => { answers[0]!.resolve(true) })
  expect(input).toHaveValue('625')
  fireEvent.change(input, { target: { value: '450' } })
  fireEvent.blur(input)
  await act(async () => { answers[1]!.resolve(false) })
  expect(input).toHaveValue('625')
  expect(update.mock.calls).toEqual([[{ pasteDelayMs: 300 }], [{ pasteDelayMs: 450 }]])
})

it('rolls back to a successful explicit numeric return even when its setting value did not change', async () => {
  const answers: ReturnType<typeof deferred<boolean>>[] = []
  const update = vi.fn(() => { const pending = deferred<boolean>(); answers.push(pending); return pending.promise })
  const props = baseProps({ onUpdateSettings: update })
  const view = render(<SettingsView {...props} />)
  await selectCategory('Output')
  const input = screen.getByRole('textbox', { name: 'Paste delay' })
  fireEvent.change(input, { target: { value: '300' } }); fireEvent.blur(input)
  view.rerender(<SettingsView {...props} settings={{ ...props.settings, pasteDelayMs: 625 }} />)
  view.rerender(<SettingsView {...props} settings={{ ...props.settings, pasteDelayMs: 300 }} />)
  await act(async () => { answers[0]!.resolve(true) })
  expect(input).toHaveValue('625')
  fireEvent.change(input, { target: { value: '300' } }); fireEvent.blur(input)
  await act(async () => { answers[1]!.resolve(true) })
  expect(input).toHaveValue('300')
  fireEvent.change(input, { target: { value: '450' } }); fireEvent.blur(input)
  await act(async () => { answers[2]!.resolve(false) })
  expect(input).toHaveValue('300')
  expect(update.mock.calls).toEqual([[{ pasteDelayMs: 300 }], [{ pasteDelayMs: 300 }], [{ pasteDelayMs: 450 }]])
})
