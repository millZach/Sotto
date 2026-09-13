import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { SettingsView, type SettingsViewProps } from '../../../src/renderer/src/features/settings/SettingsView'
import { appearancePreview } from '../../../src/renderer/src/state/appearance'
import { platformCopy } from '../../../src/renderer/src/platformCopy'
import { defaultAgentConfiguration, type AgentState } from '../../../src/shared/agents'
import {
  TRANSCRIPTION_PRIVACY_NOTICE,
  UPDATE_CHECK_PRIVACY_NOTICE,
  type HotkeyChangeResult,
  type TranscriptionKeyCheck,
} from '../../../src/shared/contracts'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(),
  useOptionalAgents: vi.fn(),
}))

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.reducedMotion
  appearancePreview.reset()
  vi.mocked(useOptionalAgents).mockReset()
})

function createMediaDevices(devices: MediaDeviceInfo[] = []): Pick<MediaDevices, 'enumerateDevices' | 'addEventListener' | 'removeEventListener'> {
  return {
    enumerateDevices: vi.fn(async () => devices),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

function device(deviceId: string, label: string): MediaDeviceInfo {
  return { deviceId, groupId: 'group', kind: 'audioinput', label, toJSON: () => ({}) }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve }
}

function baseProps(overrides: Partial<SettingsViewProps> = {}): SettingsViewProps {
  return {
    settings: { ...DEFAULT_SETTINGS, onboardingComplete: true },
    platform: 'win32',
    mediaDevices: createMediaDevices([device('default', 'Studio microphone')]),
    onUpdateSettings: vi.fn(async () => true),
    onReplaceHotkey: vi.fn(async () => ({ ok: true } as const)),
    onSetStartup: vi.fn(async (enabled) => ({ enabled })),
    onResetSettings: vi.fn(async () => true),
    onClearHistory: vi.fn(async () => true),
    onCheckTranscriptionKey: vi.fn(async () => ({ ok: true } as const)),
    updateStatus: { currentVersion: '3.4.0', phase: { phase: 'up-to-date' } },
    onCheckForUpdates: vi.fn(async () => null),
    onDownloadUpdate: vi.fn(async () => true),
    onInstallUpdate: vi.fn(async () => true),
    ...overrides,
  }
}

const copy = platformCopy('win32')

describe('SettingsView', () => {
  it('renders the complete field matrix', async () => {
    render(<div><SettingsView {...baseProps()} /></div>)
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    for (const name of [
      'Reduced motion', 'Show floating widget when idle', 'Microphone', 'Global shortcut',
      'Sound cues', 'Language', 'Whitespace formatting',
      'Automatic clipboard copy', 'Automatic paste', 'Paste delay', 'Success message duration',
      copy.settingsLaunchAtStartupLabel, 'Start minimized', 'Keep local history', 'History retention',
    ]) expect(screen.getByRole(name === 'Show floating widget when idle' || name === 'Sound cues' || name === 'Whitespace formatting' || name === 'Automatic clipboard copy' || name === 'Automatic paste' || name === copy.settingsLaunchAtStartupLabel || name === 'Start minimized' || name === 'Keep local history' ? 'switch' : name === 'Global shortcut' || name === 'Paste delay' || name === 'Success message duration' ? 'textbox' : 'combobox', { name })).toBeVisible()
    expect(screen.getByRole('switch', { name: 'Show floating widget when idle' })).toBeChecked()
    expect(screen.getByRole('radiogroup', { name: 'Maximum recording time' })).toBeVisible()
    expect(screen.getByRole('switch', { name: 'Automatic clipboard copy' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Automatic clipboard copy' })).toBeDisabled()
  })

  it('saves the widget idle-visibility preference through the ordinary patch flow', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)

    await user.click(screen.getByRole('switch', { name: 'Show floating widget when idle' }))

    expect(update).toHaveBeenCalledWith({ showWidgetWhenIdle: false })
  })

  it('resynchronizes numeric drafts from authoritative settings', async () => {
    const user = userEvent.setup()
    const props = baseProps()
    const rendered = render(<SettingsView {...props} />)
    const delay = screen.getByRole('textbox', { name: 'Paste delay' })
    await user.clear(delay)
    await user.type(delay, '999')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, pasteDelayMs: 275 }} />)
    expect(delay).toHaveValue('275')
  })

  it('offers no widget theme choice and still saves reduced motion', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)

    expect(screen.queryByRole('combobox', { name: 'Theme' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Reduced motion' }), 'on')
    expect(update).toHaveBeenCalledWith({ reducedMotion: 'on' })
    expect(document.documentElement.dataset.reducedMotion).toBe('on')
  })

  it('shows the persisted mode and accent and saves each choice as its own patch', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'light', accent: 'blue' } })} />)
    const section = document.querySelector('#settings-appearance') as HTMLElement

    expect(within(section).getByRole('heading', { level: 2, name: 'Appearance' })).toBeVisible()
    expect(within(section).getByText(/Sotto is/u)).toHaveTextContent('Sotto is light with a blue accent.')
    expect(within(section).getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true')
    const accents = within(section).getByRole('radiogroup', { name: 'Accent' })
    expect(within(accents).getAllByRole('radio').map(radio => radio.getAttribute('aria-label'))).toEqual(['Teal', 'Blue', 'Violet', 'Rose', 'Amber', 'Green'])
    expect(within(accents).getByRole('radio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true')

    await user.click(within(section).getByRole('radio', { name: 'System' }))
    expect(update).toHaveBeenLastCalledWith({ appearance: 'system' })
    await user.click(within(accents).getByRole('radio', { name: 'Rose' }))
    expect(update).toHaveBeenLastCalledWith({ accent: 'rose' })
    expect(update).toHaveBeenCalledTimes(2)
  })

  it('moves through accents with the arrow keys as one tab stop', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    const accents = screen.getByRole('radiogroup', { name: 'Accent' })
    const radios = within(accents).getAllByRole('radio')
    expect(radios.map(radio => radio.tabIndex)).toEqual([0, -1, -1, -1, -1, -1])

    radios[0]!.focus()
    await user.keyboard('{ArrowLeft}')
    expect(update).toHaveBeenLastCalledWith({ accent: 'green' })
    expect(within(accents).getByRole('radio', { name: 'Green' })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(update).toHaveBeenLastCalledWith({ accent: 'teal' })
    expect(within(accents).getByRole('radio', { name: 'Teal' })).toHaveFocus()
  })

  it('enumerates microphones, preserves an unknown persisted choice, and refreshes on devicechange', async () => {
    const mediaDevices = createMediaDevices([device('new', 'Desk microphone')])
    render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, microphoneId: 'missing' }, mediaDevices })} />)
    expect(screen.getByRole('option', { name: /previous microphone \(unavailable\)/i })).toHaveValue('missing')
    expect(await screen.findByRole('option', { name: 'Desk microphone' })).toBeVisible()
    const listener = vi.mocked(mediaDevices.addEventListener).mock.calls.find(([name]) => name === 'devicechange')?.[1]
    expect(listener).toBeTypeOf('function')
    await act(async () => { (listener as EventListener)(new Event('devicechange')) })
    expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2)
  })

  it('removes the devicechange listener on unmount', async () => {
    const mediaDevices = createMediaDevices()
    const mounted = render(<SettingsView {...baseProps({ mediaDevices })} />)
    await waitFor(() => expect(mediaDevices.addEventListener).toHaveBeenCalled())
    const listener = vi.mocked(mediaDevices.addEventListener).mock.calls[0]?.[1]
    mounted.unmount()
    expect(mediaDevices.removeEventListener).toHaveBeenCalledWith('devicechange', listener)
  })

  it('keeps the newest microphone enumeration when overlapping refreshes settle out of order', async () => {
    const first = deferred<MediaDeviceInfo[]>()
    const second = deferred<MediaDeviceInfo[]>()
    const mediaDevices = createMediaDevices()
    vi.mocked(mediaDevices.enumerateDevices)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    render(<SettingsView {...baseProps({ mediaDevices })} />)
    await waitFor(() => expect(mediaDevices.addEventListener).toHaveBeenCalled())
    const listener = vi.mocked(mediaDevices.addEventListener).mock.calls[0]?.[1] as EventListener
    act(() => listener(new Event('devicechange')))
    second.resolve([device('newest', 'Newest microphone')])
    expect(await screen.findByRole('option', { name: 'Newest microphone' })).toBeVisible()
    first.resolve([device('stale', 'Stale microphone')])
    await act(async () => undefined)
    expect(screen.getByRole('option', { name: 'Newest microphone' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'Stale microphone' })).not.toBeInTheDocument()
  })

  it('ignores a microphone enumeration that settles after unmount', async () => {
    const pending = deferred<MediaDeviceInfo[]>()
    const mediaDevices = createMediaDevices()
    vi.mocked(mediaDevices.enumerateDevices).mockImplementationOnce(() => pending.promise)
    const rendered = render(<SettingsView {...baseProps({ mediaDevices })} />)
    rendered.unmount()
    pending.resolve([device('late', 'Late microphone')])
    await act(async () => undefined)
    expect(mediaDevices.removeEventListener).toHaveBeenCalled()
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

  it('preserves an unknown persisted language and labels auto honestly', () => {
    render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, language: 'cy' } })} />)
    expect(screen.getByRole('option', { name: 'Saved language (cy)' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'Automatic (detect language)' })).toBeVisible()
    expect(screen.queryByText(/auto-detect/i)).not.toBeInTheDocument()
  })

  it.each([
    ['clear', 'History could not be cleared.'],
    ['reset', 'Settings could not be reset.'],
  ] as const)('shows a finite %s failure inside the active dialog', async (operation, message) => {
    const user = userEvent.setup()
    render(<SettingsView {...baseProps({
      onClearHistory: vi.fn(async () => false),
      onResetSettings: vi.fn(async () => false),
    })} />)
    if (operation === 'clear') {
      await user.click(screen.getByRole('button', { name: /clear history/i }))
      await user.click(screen.getByRole('button', { name: /clear all transcripts/i }))
    } else {
      await user.click(screen.getByRole('button', { name: /reset settings/i }))
      await user.click(screen.getByRole('button', { name: /reset all settings/i }))
    }
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent(message)
  })

  it('wires startup, auto-paste, retention, reset, and clear-history controls', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    const startup = vi.fn(async (enabled) => ({ enabled }))
    const reset = vi.fn(async () => true)
    const clear = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update, onSetStartup: startup, onResetSettings: reset, onClearHistory: clear })} />)
    await user.click(screen.getByRole('switch', { name: 'Automatic paste' }))
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
    await user.selectOptions(screen.getByRole('combobox', { name: 'Reduced motion' }), 'on')
    await user.click(screen.getByRole('radio', { name: '2 min' }))
    await user.click(screen.getByRole('switch', { name: 'Sound cues' }))
    await user.click(screen.getByRole('switch', { name: 'Whitespace formatting' }))
    await user.click(screen.getByRole('switch', { name: 'Start minimized' }))
    await user.click(screen.getByRole('switch', { name: 'Keep local history' }))
    expect(update).toHaveBeenCalledWith({ reducedMotion: 'on' })
    expect(update).toHaveBeenCalledWith({ maxRecordingSeconds: 120 })
    expect(update).toHaveBeenCalledWith({ soundCues: false })
    expect(update).toHaveBeenCalledWith({ formatWhitespace: false })
    expect(update).toHaveBeenCalledWith({ startMinimized: true })
    expect(update).toHaveBeenCalledWith({ historyEnabled: false })
  })

  it('shows only MAI and puts its shared key and verification in Transcription', () => {
    const { container } = render(<SettingsView {...baseProps()} />)
    const section = container.querySelector('#settings-transcription') as HTMLElement
    expect(within(section).getByLabelText('OpenRouter API key')).toHaveAttribute('type', 'password')
    expect(within(section).getByRole('button', { name: 'Verify key' })).toBeVisible()
    expect(within(section).getByText(/cannot transcribe until you add your OpenRouter API key/i)).toBeVisible()
    expect(container.querySelectorAll('.settings-model-statement')).toHaveLength(1)
    expect(container.querySelectorAll('.settings-model-card')).toHaveLength(0)
    expect(within(section).getByRole('heading', { name: 'MAI-Transcribe-2' })).toBeVisible()
    expect(within(section).getByText(TRANSCRIPTION_PRIVACY_NOTICE)).toBeVisible()
    expect(within(container.querySelector('#settings-formatting') as HTMLElement).queryByLabelText('OpenRouter API key')).toBeNull()
    expect(screen.queryByRole('button', { name: /install.*model|test connection/i })).toBeNull()
    expect(screen.queryByLabelText('Transcription server')).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Use the transcription server' })).toBeNull()
  })

  it.each([
    [{ ok: true }, 'Key verified.'],
    [{ ok: false, reason: 'unauthorized' }, 'OpenRouter rejected this key.'],
    [{ ok: false, reason: 'unconfigured' }, 'Enter your OpenRouter API key first.'],
    [{ ok: false, reason: 'network' }, 'Could not reach OpenRouter.'],
    [{ ok: false, reason: 'timeout' }, 'Could not reach OpenRouter.'],
    [{ ok: false, reason: 'http' }, 'OpenRouter returned an error.'],
  ] as const)('shows the verification result %j', async (result, message) => {
    const user = userEvent.setup()
    render(<SettingsView {...baseProps({ onCheckTranscriptionKey: vi.fn(async (): Promise<TranscriptionKeyCheck> => result) })} />)
    await user.click(screen.getByRole('button', { name: 'Verify key' }))
    expect(await screen.findByText(message)).toBeVisible()
  })

  it('awaits draft persistence before checking', async () => {
    const user = userEvent.setup()
    const pending = deferred<boolean>()
    const update = vi.fn(() => pending.promise)
    const check = vi.fn(async () => ({ ok: true as const }))
    render(<SettingsView {...baseProps({ onUpdateSettings: update, onCheckTranscriptionKey: check })} />)
    // A generated inert value exercises credential plumbing without storing any key in a fixture.
    await user.type(screen.getByLabelText('OpenRouter API key'), crypto.randomUUID())
    await user.click(screen.getByRole('button', { name: 'Verify key' }))
    expect(update).toHaveBeenCalledOnce()
    expect(check).not.toHaveBeenCalled()
    pending.resolve(true)
    expect(await screen.findByText('Key verified.')).toBeVisible()
    expect(check).toHaveBeenCalledOnce()
  })

  it('keeps the saved placeholder through verification and credential replacement', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    const stored = 'Saved in your operating system credential store'
    render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, llmApiKey: stored }, onUpdateSettings: update })} />)
    // The saved key shows as a state, never as the placeholder sentence itself.
    expect(screen.getByLabelText('OpenRouter API key')).toHaveValue('')
    expect(screen.getByLabelText('OpenRouter API key')).toHaveAttribute('placeholder', 'Key saved')
    await user.click(screen.getByRole('button', { name: 'Verify key' }))
    expect(await screen.findByText('Key verified.')).toBeVisible()
    expect(update).not.toHaveBeenCalled()
    await user.clear(screen.getByLabelText('OpenRouter API key'))
    await user.type(screen.getByLabelText('OpenRouter API key'), crypto.randomUUID())
    await user.click(screen.getByRole('button', { name: 'Verify key' }))
    expect(await screen.findByText('Key verified.')).toBeVisible()
    expect(screen.getByLabelText('OpenRouter API key')).toHaveAttribute('placeholder', 'Key saved')
  })

  it('preserves newer typing and suppresses a stale verification result during a save', async () => {
    const user = userEvent.setup()
    const pending = deferred<boolean>()
    const check = vi.fn(async () => ({ ok: true as const }))
    const props = baseProps({ onUpdateSettings: vi.fn(() => pending.promise), onCheckTranscriptionKey: check })
    const rendered = render(<SettingsView {...props} />)
    const input = screen.getByLabelText('OpenRouter API key')
    await user.type(input, crypto.randomUUID())
    await user.click(screen.getByRole('button', { name: 'Verify key' }))
    await user.clear(input)
    const newer = crypto.randomUUID()
    await user.type(input, newer)
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, llmApiKey: 'Saved in your operating system credential store' }} />)
    pending.resolve(true)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verify key' })).toBeEnabled())
    expect((input as HTMLInputElement).value === newer).toBe(true)
    expect(check).not.toHaveBeenCalled()
  })

  it('does not verify a draft that failed to save', async () => {
    const user = userEvent.setup()
    const check = vi.fn(async () => ({ ok: true as const }))
    render(<SettingsView {...baseProps({ onUpdateSettings: vi.fn(async () => false), onCheckTranscriptionKey: check })} />)
    await user.type(screen.getByLabelText('OpenRouter API key'), crypto.randomUUID())
    await user.click(screen.getByRole('button', { name: 'Verify key' }))
    expect(await screen.findByText('The API key could not be saved.')).toBeVisible()
    expect(check).not.toHaveBeenCalled()
  })

  it('discloses what an update check sends and saves the choice through the ordinary patch flow', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)

    const toggle = screen.getByRole('switch', { name: 'Check for updates automatically' })
    expect(toggle).toBeChecked()
    expect(screen.getByText(UPDATE_CHECK_PRIVACY_NOTICE)).toBeVisible()
    expect(screen.getByText('Sotto 3.4.0')).toBeVisible()
    expect(screen.getByText('You are on the newest release.')).toBeVisible()

    await user.click(toggle)

    expect(update).toHaveBeenCalledWith({ autoUpdateCheck: false })
  })

  it('checks on demand and offers the matching action for each update phase', async () => {
    const user = userEvent.setup()
    const check = vi.fn(async () => null)
    const download = vi.fn(async () => true)
    const install = vi.fn(async () => true)

    const { unmount } = render(<SettingsView {...baseProps({ onCheckForUpdates: check })} />)
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(check).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument()
    unmount()

    render(<SettingsView {...baseProps({
      updateStatus: { currentVersion: '3.4.0', phase: { phase: 'available', version: '3.5.0' } },
      onDownloadUpdate: download,
    })} />)
    expect(screen.getByText('Sotto 3.5.0 is available.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(download).toHaveBeenCalledOnce()
    cleanup()

    render(<SettingsView {...baseProps({
      updateStatus: { currentVersion: '3.4.0', phase: { phase: 'downloaded', version: '3.5.0' } },
      onInstallUpdate: install,
    })} />)
    await user.click(screen.getByRole('button', { name: 'Restart to update' }))
    expect(install).toHaveBeenCalledOnce()
  })

  it('says plainly when this build has no update feed at all', () => {
    render(<SettingsView {...baseProps({
      updateStatus: { currentVersion: '3.4.0', phase: { phase: 'unsupported' } },
    })} />)

    expect(screen.getByText('Update checks run only in the installed Windows app.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled()
  })

  it('renders the macOS copy row and canonicalizes shortcuts through the darwin aliases', async () => {
    const user = userEvent.setup()
    const macCopy = platformCopy('darwin')
    const replace = vi.fn(async () => ({ ok: true as const }))
    render(<SettingsView {...baseProps({ platform: 'darwin', onReplaceHotkey: replace })} />)

    expect(screen.getByRole('switch', { name: macCopy.settingsLaunchAtStartupLabel })).toBeVisible()
    expect(screen.getByRole('option', { name: macCopy.settingsMicrophoneDefaultOption })).toBeVisible()
    expect(screen.getByText(macCopy.settingsGlobalShortcutDescription)).toBeVisible()
    expect(screen.getByText(macCopy.settingsAutoPasteDescription)).toBeVisible()
    expect(screen.getByText(macCopy.settingsReducedMotionDescription)).toBeVisible()
    expect(screen.queryByRole('switch', { name: copy.settingsLaunchAtStartupLabel })).not.toBeInTheDocument()

    const input = screen.getByRole('textbox', { name: 'Global shortcut' })
    expect(input).toHaveValue('Command+Shift+Space')
    await user.clear(input)
    await user.type(input, 'Control+Shift+Space')
    await user.tab()

    expect(replace).toHaveBeenCalledWith('Control+Shift+Space')
  })

  it('places Agents immediately after Providers and exposes Reasoning account inline', () => {
    const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
    const state: AgentState = {
      configuration: { ...defaultAgentConfiguration(), reasoning: 'claude' }, connection: 'disconnected',
      host: { connected: false, name: 'Providers', version: '', capabilities, projects: [], models: [], threads: [] },
      assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
      draftRequestId: null, pendingRequest: '', busy: false, notice: '', error: null, speech: { id: 0, text: '' },
      voice: { status: 'off', error: null, action: 'none', revision: 0 },
      credentials: { reasoning: false, grokSpeech: false, secure: true }, reasoningAccounts: [],
      membership: { status: 'beta', label: 'Test', expiresAt: null },
    }
    vi.mocked(useOptionalAgents).mockReturnValue({
      state, command: vi.fn(async () => state), error: null, voice: { status: 'off' }, muteVoice: vi.fn(), stopSpeech: vi.fn(), retryVoice: vi.fn(),
      attention: { items: [], show: false, dismiss: vi.fn(), reopen: vi.fn(), next: vi.fn(async () => undefined) },
    })
    const { container } = render(<SettingsView {...baseProps()} />)
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Dictation', 'Transcription', 'Cleanup', 'Providers', 'Agents', 'Output', 'Appearance', 'Application',
    ])
    expect([...container.querySelectorAll('.settings-scroll > .settings-section')].map((section) => section.id)).toEqual([
      'settings-capture', 'settings-transcription', 'settings-formatting', 'settings-providers', 'settings-agents', 'settings-output', 'settings-appearance', 'settings-privacy',
    ])
    const agents = container.querySelector('#settings-agents') as HTMLElement
    expect(within(agents).queryByRole('button', { name: 'Configure agents' })).toBeNull()
    expect(within(agents).getByRole('combobox', { name: 'Reasoning account' })).toHaveValue('claude')
    expect(screen.queryByRole('dialog', { name: 'Agent configuration' })).toBeNull()
  })
})
