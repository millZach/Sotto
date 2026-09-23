import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { SettingsView, type SettingsViewProps } from '../../../src/renderer/src/features/settings/SettingsView'
import { appearancePreview } from '../../../src/renderer/src/state/appearance'
import { useVoiceCoordinatorEnabled } from '../../../src/renderer/src/state/voiceCoordinator'
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

// Settings is rendered without the app provider the real hook reads, so the
// beta's voice gate is stated here rather than inferred from a context.
vi.mock('../../../src/renderer/src/state/voiceCoordinator', () => ({
  useVoiceCoordinatorEnabled: vi.fn(() => false),
}))

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.reducedMotion
  appearancePreview.reset()
  vi.mocked(useOptionalAgents).mockReset()
  vi.mocked(useVoiceCoordinatorEnabled).mockReturnValue(false)
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
    updateStatus: { currentVersion: '3.4.0', phase: { phase: 'up-to-date' }, checkedAt: null },
    onCheckForUpdates: vi.fn(async () => null),
    onDownloadUpdate: vi.fn(async () => true),
    onInstallUpdate: vi.fn(async () => true),
    ...overrides,
  }
}

const copy = platformCopy('win32')

async function selectCategory(name: string): Promise<void> {
  await userEvent.click(screen.getByRole('tab', { name, exact: true }))
}

describe('SettingsView', () => {
  it('exposes exactly one category at a time with keyboard navigation into its controls', async () => {
    const user = userEvent.setup()
    render(<SettingsView {...baseProps()} />)
    const categories = ['Dictation', 'Transcription', 'Cleanup', 'Providers', 'Hosts', 'Agents', 'Output', 'Appearance', 'Application']
    for (const name of categories) {
      await selectCategory(name)
      expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
      const panel = screen.getByRole('tabpanel', { name, exact: true })
      expect(panel).toBeVisible()
      expect(screen.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
      // The sidebar foot's room switch is a tablist of its own, so the count is scoped to the sections.
      expect(within(screen.getByRole('tablist', { name: 'Settings sections' })).getAllByRole('tab', { selected: true })).toHaveLength(1)
      expect(screen.getAllByRole('tabpanel', { hidden: true })).toHaveLength(9)
    }
    screen.getByRole('tab', { name: 'Application', exact: true }).focus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: 'Dictation', exact: true })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('tab', { name: 'Transcription', exact: true })).toHaveFocus()
    // The column continues into the sidebar foot (the room switch, then the page links) before the room itself.
    await user.tab()
    expect(screen.getByRole('tablist', { name: 'Page' })).toContainElement(document.activeElement as HTMLElement)
    for (const name of ['Chats', 'History', 'Settings', 'Help']) {
      await user.tab()
      expect(screen.getByRole('link', { name, exact: true })).toHaveFocus()
    }
    await user.tab()
    expect(screen.getByRole('tabpanel', { name: 'Transcription', exact: true })).toHaveFocus()
    await user.tab()
    expect(screen.getByLabelText('OpenRouter API key')).toHaveFocus()
    expect(screen.queryByRole('textbox', { name: 'Global shortcut' })).not.toBeInTheDocument()
    screen.getByRole('tab', { name: 'Transcription', exact: true }).focus()
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'Application', exact: true })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('tab', { name: 'Appearance', exact: true })).toHaveFocus()
  })

  it('preserves invalid numeric drafts and their validation when returning to a category', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Output')
    await user.clear(screen.getByRole('textbox', { name: 'Paste delay' }))
    await user.type(screen.getByRole('textbox', { name: 'Paste delay' }), '49')
    await selectCategory('Dictation')
    expect(screen.queryByRole('textbox', { name: 'Paste delay' })).not.toBeInTheDocument()
    await selectCategory('Output')
    expect(screen.getByRole('textbox', { name: 'Paste delay' })).toHaveValue('49')
    expect(screen.getByText('Enter a whole number between 50 and 1000.')).toBeVisible()
    expect(update).not.toHaveBeenCalled()
  })

  it('reports a pending save failure after navigation and restores the authoritative value on return', async () => {
    const user = userEvent.setup()
    const pending = deferred<boolean>()
    const props = baseProps({ onUpdateSettings: vi.fn(() => pending.promise) })
    render(<SettingsView {...props} />)
    await selectCategory('Output')
    await user.clear(screen.getByRole('textbox', { name: 'Paste delay' }))
    await user.type(screen.getByRole('textbox', { name: 'Paste delay' }), '300')
    await selectCategory('Dictation')
    expect(props.onUpdateSettings).toHaveBeenCalledWith({ pasteDelayMs: 300 })
    pending.resolve(false)
    expect(await screen.findByRole('alert')).toHaveTextContent('That setting could not be saved. Your previous setting is still active.')
    expect(screen.getByRole('alert')).toBeVisible()
    expect(screen.getByRole('tabpanel', { name: 'Dictation' })).toBeVisible()
    await selectCategory('Output')
    expect(screen.getByRole('textbox', { name: 'Paste delay' })).toHaveValue(String(props.settings.pasteDelayMs))
  })

  it('retains the credential draft and in-flight verification across category navigation', async () => {
    const user = userEvent.setup()
    const pending = deferred<boolean>()
    const check = vi.fn(async () => ({ ok: true as const }))
    const update = vi.fn(() => pending.promise)
    render(<SettingsView {...baseProps({ onUpdateSettings: update, onCheckTranscriptionKey: check })} />)
    await selectCategory('Transcription')
    const draft = crypto.randomUUID()
    await user.type(screen.getByLabelText('OpenRouter API key'), draft)
    await user.click(screen.getByRole('button', { name: 'Verify key' }))
    await selectCategory('Output')
    await selectCategory('Transcription')
    expect(screen.getByLabelText('OpenRouter API key')).toHaveValue(draft)
    expect(screen.getByRole('button', { name: 'Verifying...' })).toBeDisabled()
    expect(update).toHaveBeenCalledOnce()
    expect(check).not.toHaveBeenCalled()
    await selectCategory('Output')
    pending.resolve(true)
    await waitFor(() => expect(check).toHaveBeenCalledOnce())
    await selectCategory('Transcription')
    expect(screen.getByText('Key verified.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Verify key' })).toBeEnabled()
  })

  it('keeps update actions busy through category navigation until the pending check settles', async () => {
    const pending = deferred<null>()
    const check = vi.fn(() => pending.promise)
    render(<SettingsView {...baseProps({ onCheckForUpdates: check })} />)
    await selectCategory('Application')
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }))
    await selectCategory('Dictation')
    await selectCategory('Application')
    expect(screen.getByRole('button', { name: 'Working...' })).toBeDisabled()
    expect(check).toHaveBeenCalledOnce()
    pending.resolve(null)
    expect(await screen.findByRole('button', { name: 'Check now' })).toBeEnabled()
  })

  it('makes the complete field matrix available through its categories', async () => {
    render(<div><SettingsView {...baseProps()} /></div>)
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'Microphone' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Global shortcut' })).toBeVisible()
    expect(screen.getByRole('switch', { name: 'Sound cues' })).toBeVisible()
    expect(screen.getByRole('radiogroup', { name: 'Maximum recording time' })).toBeVisible()
    await selectCategory('Transcription')
    expect(screen.getByRole('combobox', { name: 'Language' })).toBeVisible()
    expect(screen.getByRole('switch', { name: 'Whitespace formatting' })).toBeVisible()
    await selectCategory('Output')
    expect(screen.getByRole('switch', { name: 'Automatic clipboard copy' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'Automatic clipboard copy' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Automatic paste' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Paste delay' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Success message duration' })).toBeVisible()
    await selectCategory('Application')
    expect(screen.getByRole('combobox', { name: 'Reduced motion' })).toBeVisible()
    expect(screen.getByRole('switch', { name: 'Show floating widget when idle' })).toBeChecked()
    for (const name of [copy.settingsLaunchAtStartupLabel, 'Start minimized', 'Keep local history']) {
      expect(screen.getByRole('switch', { name })).toBeVisible()
    }
    expect(screen.getByRole('combobox', { name: 'History retention' })).toBeVisible()
  })

  it('saves the widget idle-visibility preference through the ordinary patch flow', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Application')

    await user.click(screen.getByRole('switch', { name: 'Show floating widget when idle' }))

    expect(update).toHaveBeenCalledWith({ showWidgetWhenIdle: false })
  })

  it('turns browser previews off through the ordinary patch flow', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Application')

    const toggle = screen.getByRole('switch', { name: 'Show browser previews' })
    expect(toggle).toBeChecked()
    await user.click(toggle)

    expect(update).toHaveBeenCalledWith({ showBrowserPreviews: false })
  })

  it("offers the off switches for generated text and no writing model, since each thread's own model writes", async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Cleanup')

    expect(screen.queryByRole('combobox', { name: 'Writing model' })).toBeNull()
    expect(screen.getByRole('switch', { name: 'Generated thread titles' })).toHaveAccessibleDescription(/thread's own model/u)
    await user.click(screen.getByRole('switch', { name: 'Generated thread titles' }))
    expect(update).toHaveBeenCalledWith({ threadTitles: false })
    await user.click(screen.getByRole('switch', { name: 'Generated commit messages' }))
    expect(update).toHaveBeenCalledWith({ commitMessages: false })
    await user.click(screen.getByRole('switch', { name: 'Generated pull request text' }))
    expect(update).toHaveBeenCalledWith({ pullRequestText: false })
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ writingModel: expect.anything() }))
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

  it('offers no widget theme choice and still saves reduced motion', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Application')

    expect(screen.queryByRole('combobox', { name: 'Theme' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Reduced motion' }), 'on')
    expect(update).toHaveBeenCalledWith({ reducedMotion: 'on' })
    expect(document.documentElement.dataset.reducedMotion).toBe('on')
  })

  it('shows the persisted mode and both theme halves and saves each choice as its own patch', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'light', lightTheme: 'citrine', darkTheme: 'tropic' } })} />)
    await selectCategory('Appearance')
    const section = document.querySelector('#settings-appearance') as HTMLElement

    expect(within(section).getByRole('heading', { level: 2, name: 'Appearance' })).toBeVisible()
    // The scope stays short; checked choices communicate the persisted selections.
    expect(within(section).getByText('Themes & interface')).toBeVisible()
    expect(section).not.toHaveTextContent(/using Citrine/u)
    expect(within(section).queryByRole('radiogroup', { name: 'Accent' })).not.toBeInTheDocument()
    expect(within(within(section).getByRole('radiogroup', { name: 'Color scheme' })).getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true')
    const light = within(section).getByRole('radiogroup', { name: 'Light theme' })
    const dark = within(section).getByRole('radiogroup', { name: 'Dark theme' })
    for (const label of ['Sotto', 'Hush', 'Linen', 'Nocturne', 'Tropic', 'Citrine']) {
      expect(within(light).getByRole('radio', { name: label })).toBeVisible()
      expect(within(dark).getByRole('radio', { name: label })).toBeVisible()
    }
    expect(within(light).getByRole('radio', { name: 'Citrine' })).toHaveAttribute('aria-checked', 'true')
    expect(within(dark).getByRole('radio', { name: 'Tropic' })).toHaveAttribute('aria-checked', 'true')

    await user.click(within(section).getByRole('radio', { name: 'Match Windows' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ appearance: 'system' }))
    await user.click(within(dark).getByRole('radio', { name: 'Linen' }))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ darkTheme: 'linen' }))
    expect(update).toHaveBeenCalledTimes(2)
  })

  it('reaches the scheme and both halves by keyboard, one Tab stop per group, in reading order', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Appearance')
    const section = document.querySelector('#settings-appearance') as HTMLElement
    const scheme = within(section).getByRole('radiogroup', { name: 'Color scheme' })
    const light = within(section).getByRole('radiogroup', { name: 'Light theme' })
    const dark = within(section).getByRole('radiogroup', { name: 'Dark theme' })

    // Scheme, then the theme actions, then the Light column and the Dark column, each group one stop.
    within(scheme).getByRole('radio', { name: 'Dark' }).focus()
    await user.keyboard('{Tab}')
    expect(within(section).getByRole('button', { name: 'Create theme' })).toHaveFocus()
    await user.keyboard('{Tab}{Tab}')
    expect(within(light).getByRole('radio', { name: 'Sotto' })).toHaveFocus()
    await user.keyboard('{Tab}')
    expect(within(dark).getByRole('radio', { name: 'Sotto' })).toHaveFocus()

    // Arrows choose as they move, and wrap.
    await user.keyboard('{ArrowUp}')
    expect(within(dark).getByRole('radio', { name: 'Citrine' })).toHaveFocus()
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ darkTheme: 'citrine' }))

    within(scheme).getByRole('radio', { name: 'Dark' }).focus()
    await user.keyboard('{ArrowLeft}')
    expect(within(scheme).getByRole('radio', { name: 'Match Windows' })).toHaveFocus()
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ appearance: 'system' }))
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

  it('clears a skipped microphone once the Settings test reports ready', async () => {
    const user = userEvent.setup()
    const onUpdateSettings = vi.fn(async () => true)
    const start = vi.fn(async (onLevel: (level: number) => void) => { onLevel(0.5); return 'ready' as const })
    render(<SettingsView {...baseProps({
      settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, microphoneSkipped: true },
      onUpdateSettings,
      createMicrophoneTest: () => ({ start, stop: vi.fn(async () => undefined) }),
    })} />)

    expect(screen.getByText(/no microphone is set up/i)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Test microphone' }))

    expect(start).toHaveBeenCalledOnce()
    await waitFor(() => expect(onUpdateSettings).toHaveBeenCalledWith({ microphoneSkipped: false }))
    expect(await screen.findByText(/microphone ready/i)).toBeVisible()
  })

  it('keeps the skip when the Settings test cannot reach a microphone', async () => {
    const user = userEvent.setup()
    const onUpdateSettings = vi.fn(async () => true)
    render(<SettingsView {...baseProps({
      settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, microphoneSkipped: true },
      onUpdateSettings,
      createMicrophoneTest: () => ({ start: vi.fn(async () => 'missing' as const), stop: vi.fn(async () => undefined) }),
    })} />)

    await user.click(screen.getByRole('button', { name: 'Test microphone' }))

    expect(await screen.findByText(/no microphone was found/i)).toBeVisible()
    expect(onUpdateSettings).not.toHaveBeenCalled()
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

  it.each([
    ['clear', 'History could not be cleared.'],
    ['reset', 'Settings could not be reset.'],
  ] as const)('shows a finite %s failure inside the active dialog', async (operation, message) => {
    const user = userEvent.setup()
    render(<SettingsView {...baseProps({
      onClearHistory: vi.fn(async () => false),
      onResetSettings: vi.fn(async () => false),
    })} />)
    await selectCategory('Application')
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
    await user.click(screen.getByRole('switch', { name: 'Keep local history' }))
    expect(update).toHaveBeenCalledWith({ reducedMotion: 'on' })
    expect(update).toHaveBeenCalledWith({ maxRecordingSeconds: 120 })
    expect(update).toHaveBeenCalledWith({ soundCues: false })
    expect(update).toHaveBeenCalledWith({ formatWhitespace: false })
    expect(update).toHaveBeenCalledWith({ startMinimized: true })
    expect(update).toHaveBeenCalledWith({ historyEnabled: false })
  })

  it('shows only MAI and puts its shared key and verification in Transcription', async () => {
    const { container } = render(<SettingsView {...baseProps()} />)
    await selectCategory('Transcription')
    const section = container.querySelector('#settings-transcription') as HTMLElement
    expect(within(section).getByLabelText('OpenRouter API key')).toHaveAttribute('type', 'password')
    expect(within(section).getByRole('button', { name: 'Verify key' })).toBeVisible()
    expect(within(section).getByText('Language & speech to text')).toBeVisible()
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
    await selectCategory('Transcription')
    await user.click(screen.getByRole('button', { name: 'Verify key' }))
    expect(await screen.findByText(message)).toBeVisible()
  })

  it('awaits draft persistence before checking', async () => {
    const user = userEvent.setup()
    const pending = deferred<boolean>()
    const update = vi.fn(() => pending.promise)
    const check = vi.fn(async () => ({ ok: true as const }))
    render(<SettingsView {...baseProps({ onUpdateSettings: update, onCheckTranscriptionKey: check })} />)
    await selectCategory('Transcription')
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
    await selectCategory('Transcription')
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
    await selectCategory('Transcription')
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
    await selectCategory('Transcription')
    await user.type(screen.getByLabelText('OpenRouter API key'), crypto.randomUUID())
    await user.click(screen.getByRole('button', { name: 'Verify key' }))
    expect(await screen.findByText('The API key could not be saved.')).toBeVisible()
    expect(check).not.toHaveBeenCalled()
  })

  it('discloses what an update check sends and saves the choice through the ordinary patch flow', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Application')

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
    await selectCategory('Application')
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(check).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument()
    unmount()

    render(<SettingsView {...baseProps({
      updateStatus: { currentVersion: '3.4.0', phase: { phase: 'available', version: '3.5.0', problem: null }, checkedAt: 1 },
      onDownloadUpdate: download,
    })} />)
    await selectCategory('Application')
    expect(screen.getByText('Sotto 3.5.0 is available.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(download).toHaveBeenCalledOnce()
    cleanup()

    render(<SettingsView {...baseProps({
      updateStatus: { currentVersion: '3.4.0', phase: { phase: 'downloaded', version: '3.5.0', problem: null }, checkedAt: 1 },
      onInstallUpdate: install,
    })} />)
    await selectCategory('Application')
    await user.click(screen.getByRole('button', { name: 'Restart and install' }))
    expect(install).toHaveBeenCalledOnce()
  })

  it('says plainly when this build has no update feed at all', async () => {
    render(<SettingsView {...baseProps({
      updateStatus: { currentVersion: '3.4.0', phase: { phase: 'unsupported' }, checkedAt: null },
    })} />)
    await selectCategory('Application')

    expect(screen.getByText('Update checks run only in the installed Windows app.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled()
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

  it('places Hosts and Agents after Providers and exposes Reasoning account inline', async () => {
    const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
    const state: AgentState = {
      configuration: { ...defaultAgentConfiguration(), reasoning: 'claude' }, connection: 'disconnected',
      host: { connected: false, name: 'Providers', version: '', capabilities, projects: [], models: [], threads: [] },
      assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
      draftRequestId: null, pendingRequest: '', globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' },
      voice: { status: 'off', error: null, action: 'none', revision: 0 },
      credentials: { reasoning: false, grokSpeech: false, secure: true }, reasoningAccounts: [],
      membership: { status: 'beta', label: 'Test', expiresAt: null },
    }
    vi.mocked(useOptionalAgents).mockReturnValue({
      state, command: vi.fn(async () => state), error: null, voice: { status: 'off' }, muteVoice: vi.fn(), stopSpeech: vi.fn(), retryVoice: vi.fn(),
      attention: { items: [], show: false, dismiss: vi.fn(), reopen: vi.fn(), next: vi.fn(async () => undefined) },
    })
    const { container } = render(<SettingsView {...baseProps()} />)
    await selectCategory('Agents')
    const nav = screen.getByRole('tablist', { name: 'Settings sections' })
    expect(within(nav).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Dictation', 'Transcription', 'Cleanup', 'Providers', 'Hosts', 'Agents', 'Output', 'Appearance', 'Application',
    ])
    const agents = container.querySelector('#settings-agents') as HTMLElement
    expect(within(agents).queryByRole('button', { name: 'Configure agents' })).toBeNull()
    expect(within(agents).getByRole('combobox', { name: 'Reasoning account' })).toHaveValue('claude')
    expect(screen.queryByRole('dialog', { name: 'Agent configuration' })).toBeNull()
  })

  it('leaves the reasoning account in Agents but no voice or wake settings while the coordinator is hidden', async () => {
    const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
    const state: AgentState = {
      configuration: { ...defaultAgentConfiguration(), reasoning: 'claude' }, connection: 'disconnected',
      host: { connected: false, name: 'Providers', version: '', capabilities, projects: [], models: [], threads: [] },
      assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
      draftRequestId: null, pendingRequest: '', globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' },
      voice: { status: 'off', error: null, action: 'none', revision: 0 },
      credentials: { reasoning: false, grokSpeech: false, secure: true }, reasoningAccounts: [],
      membership: { status: 'beta', label: 'Test', expiresAt: null },
    }
    vi.mocked(useOptionalAgents).mockReturnValue({
      state, command: vi.fn(async () => state), error: null, voice: { status: 'off' }, muteVoice: vi.fn(), stopSpeech: vi.fn(), retryVoice: vi.fn(),
      attention: { items: [], show: false, dismiss: vi.fn(), reopen: vi.fn(), next: vi.fn(async () => undefined) },
    })
    const { container, rerender } = render(<SettingsView {...baseProps()} />)
    await selectCategory('Agents')
    const agents = container.querySelector('#settings-agents') as HTMLElement
    expect(within(agents).getByText('Reasoning & projects')).toBeInTheDocument()
    expect(within(agents).queryByText('Advanced wake settings')).toBeNull()
    expect(within(agents).queryByRole('button', { name: 'Stop speech' })).toBeNull()
    expect(within(agents).getByRole('combobox', { name: 'Reasoning account' })).toHaveValue('claude')
    // Nothing is deleted: turning the coordinator on brings the same controls back.
    vi.mocked(useVoiceCoordinatorEnabled).mockReturnValue(true)
    rerender(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, voiceCoordinatorEnabled: true } })} />)
    expect(within(agents).getByText('Reasoning, voice & projects')).toBeInTheDocument()
    expect(within(agents).getByText('Advanced wake settings')).toBeInTheDocument()
  })
})

function withProjects(): void {
  const state: AgentState = {
    configuration: defaultAgentConfiguration(), connection: 'disconnected',
    host: {
      connected: false, name: 'Providers', version: '', models: [], threads: [],
      capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true },
      projects: [{ id: 'one', title: 'One', path: 'C:/One' }, { id: 'two', title: 'Two', path: 'C:/Two' }],
    },
    assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
    draftRequestId: null, pendingRequest: '', globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' },
    voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: true }, reasoningAccounts: [],
    membership: { status: 'beta', label: 'Test', expiresAt: null },
  }
  vi.mocked(useOptionalAgents).mockReturnValue({
    state, command: vi.fn(async () => state), error: null, voice: { status: 'off' }, muteVoice: vi.fn(), stopSpeech: vi.fn(), retryVoice: vi.fn(),
    attention: { items: [], show: false, dismiss: vi.fn(), reopen: vi.fn(), next: vi.fn(async () => undefined) },
  })
}

describe('Project thread defaults in Application settings', () => {
  it('edits one project without losing other overrides and can restore inheritance', async () => {
    withProjects()
    const onUpdateSettings = vi.fn(async () => true)
    const props = baseProps({ settings: { ...DEFAULT_SETTINGS, projectThreadWorkingCopyDefaults: { one: 'independent', missing: 'shared' } }, onUpdateSettings })
    const { rerender } = render(<SettingsView {...props} />)
    await selectCategory('Application')
    await userEvent.click(screen.getByRole('button', { name: 'Project defaults' }))
    const choice = screen.getByRole('combobox', { name: 'New threads in this project work in' })
    expect(choice).toHaveValue('independent')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Project', exact: true }), 'two')
    expect(choice).toHaveValue('inherit')
    await userEvent.selectOptions(choice, 'independent')
    expect(onUpdateSettings).toHaveBeenLastCalledWith({ projectThreadWorkingCopyDefaults: { one: 'independent', missing: 'shared', two: 'independent' } })
    rerender(<SettingsView {...props} settings={{ ...props.settings, projectThreadWorkingCopyDefaults: { one: 'independent', missing: 'shared', two: 'independent' } }} />)
    await userEvent.selectOptions(choice, 'inherit')
    expect(onUpdateSettings).toHaveBeenLastCalledWith({ projectThreadWorkingCopyDefaults: { one: 'independent', missing: 'shared' } })
    choice.focus()
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Project defaults' })).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Project defaults' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('disables edits during save and retains the previous value with a visible failure', async () => {
    withProjects()
    const pending = deferred<boolean>()
    const onUpdateSettings = vi.fn(() => pending.promise)
    render(<SettingsView {...baseProps({ onUpdateSettings })} />)
    await selectCategory('Application')
    await userEvent.click(screen.getByRole('button', { name: 'Project defaults' }))
    const choice = screen.getByRole('combobox', { name: 'New threads in this project work in' })
    await userEvent.selectOptions(choice, 'independent')
    expect(choice).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Project', exact: true })).toBeDisabled()
    await act(async () => pending.resolve(false))
    expect(choice).toBeEnabled()
    expect(choice).toHaveValue('inherit')
    expect(screen.getByText('That setting could not be saved. Your previous setting is still active.')).toBeVisible()
  })

  it('explains how to add a project when there are none', async () => {
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Application')
    await userEvent.click(screen.getByRole('button', { name: 'Project defaults' }))
    expect(screen.getByText('Add a project in Threads to set its default working copy.')).toBeVisible()
  })
})
