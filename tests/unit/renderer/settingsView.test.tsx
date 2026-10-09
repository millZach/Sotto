import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { agentContextFixture } from '../../fixtures/agentContext'
import { clientAgentState, hostEntityKey } from '../../../src/shared/clientIdentity'
import { beginNewThread } from '../../../src/renderer/src/agents/newThread'

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
  await userEvent.click(screen.getByRole('tab', { name }))
}

describe('SettingsView', () => {
  it('disables Linux startup with the package explanation and never calls native startup or shows an error', async () => {
    const props = baseProps({ platform: 'linux', onSetStartup: vi.fn(async () => { throw new Error('unsupported') }) })
    render(<SettingsView {...props} />)
    await selectCategory('Application')
    const startup = screen.getByRole('switch', { name: platformCopy('linux').settingsLaunchAtStartupLabel })
    expect(startup).toBeDisabled()
    expect(screen.getByText('Starting at sign-in comes with the installed package.')).toBeVisible()
    await userEvent.click(startup)
    expect(props.onSetStartup).not.toHaveBeenCalled()
    expect(screen.queryByText(platformCopy('linux').settingsStartupFailureNotice)).not.toBeInTheDocument()
  })

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

  it.each(['denied', 'missing', 'error'] as const)('keeps a %s test result after category changes and hiding', async outcome => {
    render(<SettingsView {...baseProps({ createMicrophoneTest: () => ({ start: vi.fn(async () => outcome), stop: vi.fn(async () => undefined) }) })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    await waitFor(() => expect(document.querySelector('.settings-microphone-test')).toHaveAttribute('data-state', outcome))
    await selectCategory('Output')
    await selectCategory('Dictation')
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    fireEvent(document, new Event('visibilitychange'))
    try { expect(document.querySelector('.settings-microphone-test')).toHaveAttribute('data-state', outcome) } finally { vi.restoreAllMocks() }
  })

  it('replaces listening with missing when the running input ends', async () => {
    let ended!: () => void
    render(<SettingsView {...baseProps({ createMicrophoneTest: () => ({
      start: vi.fn(async (_level, _id, onEnded) => { ended = () => onEnded?.('missing'); return 'ready' as const }),
      stop: vi.fn(async () => undefined),
    }) })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    await screen.findByRole('button', { name: 'Stop test' })
    act(() => ended())
    expect(document.querySelector('.settings-microphone-test')).toHaveAttribute('data-state', 'missing')
    expect(screen.queryByText('Listening. Say something.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop test' })).not.toBeInTheDocument()
    await selectCategory('Output')
    await selectCategory('Dictation')
    expect(document.querySelector('.settings-microphone-test')).toHaveAttribute('data-state', 'missing')
  })

  it.each([0, 0.01, 0.02, 0.021, 0.7])('judges the peak input level on Stop and resets it for the next test (%s)', async peak => {
    let publishLevel!: (level: number) => void
    const stop = vi.fn(async () => undefined)
    render(<SettingsView {...baseProps({ createMicrophoneTest: () => ({
      start: vi.fn(async onLevel => { publishLevel = onLevel; return 'ready' as const }), stop,
    }) })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    await screen.findByRole('button', { name: 'Stop test' })
    act(() => { publishLevel(peak); publishLevel(0) })
    await userEvent.click(screen.getByRole('button', { name: 'Stop test' }))
    expect(screen.getByText(peak > 0.02 ? 'Sotto heard you. The microphone is closed.' : 'Sotto did not hear anything. Check that the microphone is not muted.')).toBeVisible()
    expect(stop).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: 'Test again' }))
    await screen.findByRole('button', { name: 'Stop test' })
    await userEvent.click(screen.getByRole('button', { name: 'Stop test' }))
    expect(screen.getByText('Sotto did not hear anything. Check that the microphone is not muted.')).toBeVisible()
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('closes a listening microphone with the keyboard Stop test control', async () => {
    const user = userEvent.setup()
    const stop = vi.fn(async () => undefined)
    render(<SettingsView {...baseProps({ createMicrophoneTest: () => ({
      start: vi.fn(async onLevel => { onLevel(0.3); return 'ready' as const }), stop,
    }) })} />)
    await user.click(screen.getByRole('button', { name: 'Test microphone' }))
    const button = await screen.findByRole('button', { name: 'Stop test' })
    expect(screen.getByText('Listening. Say something.')).toBeVisible()
    button.focus()
    await user.keyboard('{Enter}')
    expect(stop).toHaveBeenCalledOnce()
    expect(await screen.findByText('Sotto heard you. The microphone is closed.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Test again' })).toBeEnabled()
  })

  it.each(['ready', 'requesting'] as const)('stops a %s microphone when the window becomes hidden', async state => {
    const outcome = deferred<'ready'>()
    const stop = vi.fn(async () => undefined)
    const props = baseProps({ settings: { ...DEFAULT_SETTINGS, microphoneSkipped: true },
      createMicrophoneTest: () => ({ start: vi.fn(() => state === 'ready' ? Promise.resolve('ready' as const) : outcome.promise), stop }) })
    render(<SettingsView {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    if (state === 'ready') await screen.findByRole('button', { name: 'Stop test' })
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    fireEvent(document, new Event('visibilitychange'))
    expect(stop).toHaveBeenCalledOnce()
    await act(async () => { outcome.resolve('ready') })
    expect(screen.queryByRole('button', { name: 'Stop test' })).not.toBeInTheDocument()
    if (state === 'requesting') expect(props.onUpdateSettings).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('stops the microphone when its Settings category is left', async () => {
    const stop = vi.fn(async () => undefined)
    render(<SettingsView {...baseProps({ createMicrophoneTest: () => ({ start: vi.fn(async () => 'ready' as const), stop }) })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    await selectCategory('Output')
    expect(stop).toHaveBeenCalledOnce()
    await selectCategory('Dictation')
    expect(screen.getByRole('button', { name: 'Test again' })).toBeEnabled()
  })

  it('exposes exactly one category at a time with keyboard navigation into its controls', async () => {
    const user = userEvent.setup()
    render(<SettingsView {...baseProps()} />)
    const categories = ['Dictation', 'Transcription', 'Cleanup', 'Providers', 'Hosts', 'Phones', 'Agents', 'Output', 'Appearance', 'Application', 'Git']
    for (const name of categories) {
      await selectCategory(name)
      expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
      const panel = screen.getByRole('tabpanel', { name })
      expect(panel).toBeVisible()
      expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true')
      // The sidebar foot's room switch is a tablist of its own, so the count is scoped to the sections.
      expect(within(screen.getByRole('tablist', { name: 'Settings sections' })).getAllByRole('tab', { selected: true })).toHaveLength(1)
      expect(screen.getAllByRole('tabpanel', { hidden: true })).toHaveLength(12)
    }
    screen.getByRole('tab', { name: 'Application' }).focus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: 'Dictation' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('tab', { name: 'Transcription' })).toHaveFocus()
    // The column continues into the sidebar foot (the room switch, then the page links) before the room itself.
    await user.tab()
    expect(screen.getByRole('tablist', { name: 'Page' })).toContainElement(document.activeElement as HTMLElement)
    for (const name of ['History', 'Settings', 'Help']) {
      await user.tab()
      expect(screen.getByRole('link', { name })).toHaveFocus()
    }
    await user.tab()
    expect(screen.getByRole('tabpanel', { name: 'Transcription' })).toHaveFocus()
    await user.tab()
    expect(screen.getByLabelText('OpenRouter API key')).toHaveFocus()
    expect(screen.queryByRole('textbox', { name: 'Global shortcut' })).not.toBeInTheDocument()
    screen.getByRole('tab', { name: 'Transcription' }).focus()
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'Git' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('tab', { name: 'Application' })).toHaveFocus()
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

  it('turns letting agents babysit pull requests off beside the other agent switches, saying what each value does (ADR-0061)', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    const view = render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Application')

    const toggle = screen.getByRole('switch', { name: 'Let agents babysit pull requests' })
    expect(toggle).toBeChecked()
    expect(toggle).toHaveAccessibleDescription('An agent can ask Sotto to babysit its pull request and stop checking GitHub itself. Sotto sends its thread a wake-up when the pull request needs it.')
    // It sits with the switches that let agents act on their own, after the visuals one.
    const switches = screen.getAllByRole('switch').map(item => item.getAttribute('aria-label'))
    expect(switches.indexOf('Let agents babysit pull requests')).toBe(switches.indexOf('Let agents draw visuals in threads') + 1)
    await user.click(toggle)
    expect(update).toHaveBeenCalledWith({ babysitPullRequests: false })

    view.rerender(<SettingsView {...baseProps({ onUpdateSettings: update, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, babysitPullRequests: false } })} />)
    expect(screen.getByRole('switch', { name: 'Let agents babysit pull requests' })).toHaveAccessibleDescription(
      'Agents cannot start babysitting, and Sotto stops what they started. You can still babysit a pull request from the Pull request surface.')
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

  it('chooses the Commit and pull request style, with custom instructions saved as typing pauses', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    const props = baseProps({ onUpdateSettings: update })
    const rendered = render(<SettingsView {...props} />)
    await selectCategory('Git')
    const style = screen.getByRole('combobox', { name: 'Commit and pull request style' })
    expect(style).toHaveValue('repository')
    expect(style).toHaveAccessibleDescription(/the way each repository's recent commits and AGENTS.md do/u)
    expect(screen.getByRole('group', { name: 'Example' })).toHaveTextContent('Let a thread name itself from its first exchange')
    expect(within(style).getAllByRole('option').map(option => option.textContent)).toEqual(['Repository conventions', 'Conventional Commits', 'Custom instructions'])
    expect(screen.queryByRole('textbox', { name: 'Custom instructions' })).toBeNull()
    await user.selectOptions(style, 'conventional')
    expect(update).toHaveBeenCalledWith({ gitWritingStyle: 'conventional' })
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, gitWritingStyle: 'conventional' }} />)
    expect(style).toHaveAccessibleDescription(/starts with a type and scope/u)
    expect(screen.getByRole('group', { name: 'Example' })).toHaveTextContent('feat(threads): name a thread from its first exchange')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, gitWritingStyle: 'custom' }} />)
    expect(style).toHaveAccessibleDescription(/they take precedence over the repository's style/u)
    const instructions = screen.getByRole('textbox', { name: 'Custom instructions' })
    expect(instructions).toHaveAccessibleDescription('up to 2,000 characters')
    expect(screen.getByRole('group', { name: 'Example' })).toHaveTextContent(/Nothing written yet/u)
    await user.type(instructions, 'Subjects in the past tense.')
    // The example follows the text as typed, and says the thread's own model applies the instructions.
    expect(screen.getByRole('group', { name: 'Example' })).toHaveTextContent(/An example before your instructions/u)
    // No leaving the field needed: the pause saves it.
    await waitFor(() => expect(update).toHaveBeenCalledWith({ gitWritingInstructions: 'Subjects in the past tense.' }))
  })

  it('says under the style when nothing will be drafted, because both Generated switches under Cleanup are off', async () => {
    render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, commitMessages: false, pullRequestText: false } })} />)
    await selectCategory('Git')
    expect(screen.getByRole('combobox', { name: 'Commit and pull request style' })).toHaveAccessibleDescription(/Nothing is drafted while Generated commit messages and Generated pull request text are off under Cleanup/u)
  })

  it('tries a failed save of custom instructions again when the field is next left', async () => {
    const user = userEvent.setup()
    let accept = false
    const update = vi.fn(async (patch: object) => !('gitWritingInstructions' in patch) || accept)
    render(<SettingsView {...baseProps({ onUpdateSettings: update, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, gitWritingStyle: 'custom' } })} />)
    await selectCategory('Git')
    const instructions = screen.getByRole('textbox', { name: 'Custom instructions' })
    await user.type(instructions, 'Name the issue.')
    await user.tab()
    await waitFor(() => expect(update).toHaveBeenCalledWith({ gitWritingInstructions: 'Name the issue.' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved')
    // The failed text is waiting again: leaving the field once more saves it.
    accept = true
    await user.click(instructions)
    await user.tab()
    await waitFor(() => expect(update.mock.calls.filter(([patch]) => 'gitWritingInstructions' in (patch as object))).toHaveLength(2))
    expect(update).toHaveBeenLastCalledWith({ gitWritingInstructions: 'Name the issue.' })
    expect(instructions).toHaveValue('Name the issue.')
  })

  it('never brings back older custom instructions whose save failed after a newer save was sent', async () => {
    const user = userEvent.setup()
    const answers: Array<(saved: boolean) => void> = []
    const update = vi.fn((patch: object) => 'gitWritingInstructions' in patch ? new Promise<boolean>(resolve => { answers.push(resolve) }) : Promise.resolve(true))
    render(<SettingsView {...baseProps({ onUpdateSettings: update, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, gitWritingStyle: 'custom' } })} />)
    await selectCategory('Git')
    const instructions = screen.getByRole('textbox', { name: 'Custom instructions' })
    const saves = () => update.mock.calls.filter(([patch]) => 'gitWritingInstructions' in (patch as object)).map(([patch]) => (patch as { gitWritingInstructions: string }).gitWritingInstructions)
    // "abc" is sent and still in flight when "abcd" is sent.
    await user.type(instructions, 'abc')
    await user.tab()
    await user.click(instructions)
    await user.type(instructions, 'd')
    await user.tab()
    expect(saves()).toEqual(['abc', 'abcd'])
    // The older save fails after the newer one was sent, and the newer one succeeds.
    await act(async () => { answers[0]!(false) })
    await act(async () => { answers[1]!(true) })
    // Leaving the field again sends nothing: "abc" was superseded, not left waiting.
    await user.click(instructions)
    await user.tab()
    expect(saves()).toEqual(['abc', 'abcd'])
    expect(instructions).toHaveValue('abcd')
  })

  it('keeps custom instructions typed just before the style changes away from Custom instructions', async () => {
    const user = userEvent.setup()
    const update = vi.fn<Parameters<typeof SettingsView>[0]['onUpdateSettings']>(async () => true)
    const props = baseProps({ onUpdateSettings: update, settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, gitWritingStyle: 'custom' } })
    const rendered = render(<SettingsView {...props} />)
    await selectCategory('Git')
    const instructions = screen.getByRole('textbox', { name: 'Custom instructions' })
    // Typed and, before the pause, the style switched away: the field goes, and its text is saved as it goes.
    fireEvent.change(instructions, { target: { value: 'Mention the issue number.' } })
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ gitWritingInstructions: expect.anything() }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Commit and pull request style' }), 'conventional')
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, gitWritingStyle: 'conventional' }} />)
    expect(screen.queryByRole('textbox', { name: 'Custom instructions' })).toBeNull()
    expect(update).toHaveBeenCalledWith({ gitWritingInstructions: 'Mention the issue number.' })
    expect(update.mock.calls.filter(([patch]) => 'gitWritingInstructions' in (patch as object))).toHaveLength(1)
  })

  it('groups every Git setting under the moment it acts, in one Git section', async () => {
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Git')
    const panel = screen.getByRole('tabpanel', { name: 'Git' })
    const groups = within(panel).getAllByRole('region')
    expect(groups.map(group => within(group).getByRole('heading', { level: 3 }).textContent)).toEqual(['When a thread commits', 'When a pull request is made or merged', 'When you read Changes', 'In the background'])
    // The controls of each group in the order the eye meets them.
    const names = (group: HTMLElement): string[] => [...group.querySelectorAll<HTMLElement>('select, [role="switch"], [role="radiogroup"]')]
      .map(control => control.getAttribute('aria-label') ?? (control as HTMLSelectElement).labels?.[0]?.textContent ?? '')
    expect(names(groups[0]!)).toEqual(['Commit and pull request style'])
    expect(names(groups[1]!)).toEqual(['Follow pull request templates', 'Default merge method', 'Auto-settle merged threads'])
    expect(names(groups[2]!)).toEqual(['Diff layout', 'Hide whitespace changes', 'Default diff file state', 'Proactive panels'])
    expect(names(groups[3]!)).toEqual(['Git fetch interval', 'Automatically pull'])
    // Moved, not copied: Application and Cleanup keep none of them.
    for (const section of ['Application', 'Cleanup']) {
      await selectCategory(section)
      const other = screen.getByRole('tabpanel', { name: section })
      for (const name of ['Git fetch interval', 'Default merge method', 'Commit and pull request style']) expect(within(other).queryByRole('combobox', { name })).toBeNull()
      for (const name of ['Automatically pull', 'Auto-settle merged threads', 'Proactive panels', 'Follow pull request templates', 'Hide whitespace changes']) expect(within(other).queryByRole('switch', { name })).toBeNull()
    }
  })

  it('saves each Git choice, with everything that acts on its own off to start and each description saying what the value does', async () => {
    const user = userEvent.setup()
    const update = vi.fn(async () => true)
    const props = baseProps({ onUpdateSettings: update })
    const rendered = render(<SettingsView {...props} />)
    await selectCategory('Git')
    for (const name of ['Automatically pull', 'Auto-settle merged threads', 'Proactive panels']) expect(screen.getByRole('switch', { name })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: 'Automatically pull' })).toHaveAccessibleDescription(/leaves the pull to you/u)
    await user.click(screen.getByRole('switch', { name: 'Automatically pull' }))
    expect(update).toHaveBeenCalledWith({ gitAutoPull: true })
    const merge = screen.getByRole('combobox', { name: 'Default merge method' })
    expect(within(merge).getAllByRole('option').map(option => option.textContent)).toEqual(['Last selected', 'Merge', 'Squash and merge', 'Rebase and merge'])
    expect(merge).toHaveAccessibleDescription('The merge in the pull request checklist starts on the method you used last, Merge the first time.')
    await user.selectOptions(merge, 'squash')
    expect(update).toHaveBeenCalledWith({ defaultMergeMethod: 'squash' })
    await user.click(within(screen.getByRole('radiogroup', { name: 'Diff layout' })).getByRole('radio', { name: 'Split' }))
    expect(update).toHaveBeenCalledWith({ diffLayout: 'split' })
    await user.click(screen.getByRole('switch', { name: 'Hide whitespace changes' }))
    expect(update).toHaveBeenCalledWith({ diffHideWhitespace: false })
    await user.click(within(screen.getByRole('radiogroup', { name: 'Default diff file state' })).getByRole('radio', { name: 'Expanded' }))
    expect(update).toHaveBeenCalledWith({ diffFileState: 'expanded' })
    await user.click(screen.getByRole('switch', { name: 'Auto-settle merged threads' }))
    expect(update).toHaveBeenCalledWith({ autoSettleMergedThreads: true })
    await user.click(screen.getByRole('switch', { name: 'Proactive panels' }))
    expect(update).toHaveBeenCalledWith({ proactivePanels: true })
    await user.click(screen.getByRole('switch', { name: 'Follow pull request templates' }))
    expect(update).toHaveBeenCalledWith({ followPullRequestTemplates: false })
    const fetch = screen.getByRole('combobox', { name: 'Git fetch interval' })
    expect(fetch).toHaveAccessibleDescription(/Sotto asks origin every 30 seconds/u)
    await user.selectOptions(fetch, '0')
    expect(update).toHaveBeenCalledWith({ gitFetchIntervalSeconds: 0 })
    // Each description follows the value it describes.
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, gitAutoPull: true, defaultMergeMethod: 'squash', diffLayout: 'split', diffHideWhitespace: false, diffFileState: 'expanded', autoSettleMergedThreads: true, proactivePanels: true, followPullRequestTemplates: false, gitFetchIntervalSeconds: 60 }} />)
    expect(screen.getByRole('switch', { name: 'Automatically pull' })).toHaveAccessibleDescription(/Fast-forward only/u)
    expect(merge).toHaveAccessibleDescription('The merge in the pull request checklist starts on Squash and merge.')
    expect(screen.getByRole('radiogroup', { name: 'Diff layout' }).closest('.tt-field')).toHaveTextContent(/old on the left and new on the right/u)
    // The Changes group says once that these are only where Changes starts.
    expect(screen.getByRole('region', { name: 'When you read Changes' })).toHaveAccessibleDescription('These set where Changes starts. A choice made in Changes holds until one of these settings changes or Sotto restarts.')
    expect(screen.getByRole('switch', { name: 'Hide whitespace changes' })).toHaveAccessibleDescription('Changes starts showing every edit, spacing included.')
    expect(screen.getByRole('radiogroup', { name: 'Default diff file state' }).closest('.tt-field')).toHaveTextContent('Files in Changes start expanded.')
    expect(screen.getByRole('switch', { name: 'Auto-settle merged threads' })).toHaveAccessibleDescription(/asks GitHub through gh once an hour/u)
    expect(screen.getByRole('switch', { name: 'Proactive panels' })).toHaveAccessibleDescription(/at least 3 more changed files or 50 more changed lines\. It counts only while the Threads page is open\./u)
    expect(screen.getByRole('switch', { name: 'Follow pull request templates' })).toHaveAccessibleDescription(/it skips the template and uses Sotto's own sections/u)
    expect(fetch).toHaveAccessibleDescription(/Sotto asks origin every minute/u)
    rendered.rerender(<SettingsView {...props} />)
    expect(screen.getByRole('switch', { name: 'Follow pull request templates' })).toHaveAccessibleDescription("When a Git action drafts a pull request, the thread's own model follows the repository's pull request template, if Sotto finds one.")
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

  it('runs the Settings microphone test on the selected input', async () => {
    const user = userEvent.setup()
    const start = vi.fn(async () => 'ready' as const)
    render(<SettingsView {...baseProps({
      settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, microphoneId: 'mic-c922' },
      createMicrophoneTest: () => ({ start, stop: vi.fn(async () => undefined) }),
    })} />)

    await user.click(screen.getByRole('button', { name: 'Test microphone' }))

    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.any(Function), 'mic-c922', expect.any(Function)))
  })

  it('tests the microphone just chosen before that choice is saved', async () => {
    const user = userEvent.setup()
    const pending = deferred<boolean>()
    const start = vi.fn(async () => 'ready' as const)
    render(<SettingsView {...baseProps({
      settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, microphoneId: 'mic-builtin' },
      mediaDevices: createMediaDevices([device('mic-builtin', 'MacBook Pro Microphone'), device('mic-c922', 'C922 Pro Stream Webcam')]),
      onUpdateSettings: () => pending.promise,
      createMicrophoneTest: () => ({ start, stop: vi.fn(async () => undefined) }),
    })} />)

    expect(await screen.findByRole('option', { name: 'C922 Pro Stream Webcam' })).toBeVisible()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Microphone' }), 'mic-c922')
    await user.click(screen.getByRole('button', { name: 'Test microphone' }))

    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.any(Function), 'mic-c922', expect.any(Function)))
    pending.resolve(true)
  })

  it('goes back to the saved microphone when a new choice cannot be saved', async () => {
    const user = userEvent.setup()
    render(<SettingsView {...baseProps({
      settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, microphoneId: 'mic-builtin' },
      mediaDevices: createMediaDevices([device('mic-builtin', 'MacBook Pro Microphone'), device('mic-c922', 'C922 Pro Stream Webcam')]),
      onUpdateSettings: vi.fn(async () => false),
    })} />)

    expect(await screen.findByRole('option', { name: 'C922 Pro Stream Webcam' })).toBeVisible()
    const picker = screen.getByRole('combobox', { name: 'Microphone' })
    await user.selectOptions(picker, 'mic-c922')

    expect(await screen.findByText('That setting could not be saved. Your previous setting is still active.')).toBeVisible()
    expect(picker).toHaveValue('mic-builtin')
  })

  it('keeps the test wave still while access is still being asked for', async () => {
    const user = userEvent.setup()
    render(<SettingsView {...baseProps({
      createMicrophoneTest: () => ({ start: () => new Promise<never>(() => undefined), stop: vi.fn(async () => undefined) }),
    })} />)

    await user.click(screen.getByRole('button', { name: 'Test microphone' }))

    await waitFor(() => expect(document.querySelector('.settings-microphone-test')).toHaveAttribute('data-state', 'requesting'))
    expect(screen.getByTestId('listening-bars')).not.toHaveAttribute('data-speaking')
  })

  it('tells a Mac user where to turn the microphone back on when the test is blocked', async () => {
    const user = userEvent.setup()
    render(<SettingsView {...baseProps({
      platform: 'darwin',
      createMicrophoneTest: () => ({ start: vi.fn(async () => 'denied' as const), stop: vi.fn(async () => undefined) }),
    })} />)

    await user.click(screen.getByRole('button', { name: 'Test microphone' }))

    expect(await screen.findByText(platformCopy('darwin').settingsMicrophoneDenied)).toBeVisible()
  })

  it.each(['darwin', 'win32'] as const)('offers System Settings for a blocked microphone only on macOS (%s)', async platform => {
    const user = userEvent.setup()
    const openSystemSettings = vi.fn(async () => ({ ok: true as const }))
    window.sotto = { openSystemSettings } as never
    try {
      render(<SettingsView {...baseProps({
        platform,
        createMicrophoneTest: () => ({ start: vi.fn(async () => 'denied' as const), stop: vi.fn(async () => undefined) }),
      })} />)
      await user.click(screen.getByRole('button', { name: 'Test microphone' }))
      await screen.findByText(platformCopy(platform).settingsMicrophoneDenied)

      const open = screen.queryByRole('button', { name: 'Open System Settings at Privacy & Security, Microphone' })
      if (platform === 'win32') {
        expect(open).toBeNull()
        return
      }
      await user.click(open!)
      expect(openSystemSettings).toHaveBeenCalledExactlyOnceWith('microphone')
    } finally {
      delete window.sotto
    }
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
    expect(await screen.findByText(/Listening\. Say something\./i)).toBeVisible()
  })

  it('tests the selected input and discards its late result after the selection changes', async () => {
    const outcome = deferred<'ready'>()
    const stop = vi.fn(async () => undefined)
    let publishLevel!: (level: number) => void
    const start = vi.fn((onLevel: (level: number) => void) => { publishLevel = onLevel; return outcome.promise })
    const props = baseProps({ settings: { ...DEFAULT_SETTINGS, microphoneId: 'headset', microphoneSkipped: true },
      createMicrophoneTest: () => ({ start, stop }) })
    const rendered = render(<SettingsView {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    expect(start).toHaveBeenCalledWith(expect.any(Function), 'headset', expect.any(Function))
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, microphoneId: 'desk' }} />)
    await waitFor(() => expect(stop).toHaveBeenCalledOnce())
    await act(async () => { publishLevel(0.8); outcome.resolve('ready') })
    expect(screen.queryByText(/Listening\. Say something\./i)).not.toBeInTheDocument()
    expect(props.onUpdateSettings).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Test microphone' })).toBeEnabled()
  })

  it('clears a ready meter when the selected input changes and tests the new input', async () => {
    const stop = vi.fn(async () => undefined)
    const start = vi.fn(async (onLevel: (level: number) => void) => { onLevel(0.7); return 'ready' as const })
    const props = baseProps({ createMicrophoneTest: () => ({ start, stop }) })
    const rendered = render(<SettingsView {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    expect(await screen.findByText(/Listening\. Say something\./i)).toBeVisible()
    rendered.rerender(<SettingsView {...props} settings={{ ...props.settings, microphoneId: 'desk' }} />)
    await waitFor(() => expect(stop).toHaveBeenCalledOnce())
    expect(screen.queryByText(/Listening\. Say something\./i)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    expect(start).toHaveBeenLastCalledWith(expect.any(Function), 'desk', expect.any(Function))
    rendered.unmount()
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it.each([true, false])('explains a missing selected input with other inputs available: %s', async others => {
    render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, microphoneId: 'unplugged' },
      mediaDevices: createMediaDevices(others ? [device('desk', 'Desk microphone')] : []),
      createMicrophoneTest: () => ({ start: vi.fn(async () => 'missing' as const), stop: vi.fn(async () => undefined) }),
    })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    expect(await screen.findByText(others ? 'The chosen microphone is not connected. Plug it in or choose another.' : 'No microphone was found.')).toBeVisible()
  })

  it('does not call the chosen microphone disconnected while it is still listed', async () => {
    render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, microphoneId: 'desk' },
      mediaDevices: createMediaDevices([device('desk', 'Desk microphone')]),
      createMicrophoneTest: () => ({ start: vi.fn(async () => 'missing' as const), stop: vi.fn(async () => undefined) }),
    })} />)
    await screen.findByRole('option', { name: 'Desk microphone' })
    await userEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    expect(await screen.findByText('No microphone was found.')).toBeVisible()
    expect(screen.queryByText('The chosen microphone is not connected. Plug it in or choose another.')).not.toBeInTheDocument()
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

  it('places Hosts, Phones and Agents after Providers and exposes Reasoning account inline', async () => {
    const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
    const state: AgentState = {
      configuration: { ...defaultAgentConfiguration(), reasoning: 'claude' }, connection: 'disconnected',
      host: { connected: false, name: 'Providers', version: '', capabilities, projects: [], models: [], threads: [] },
      assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
      draftRequestId: null, pendingRequest: '', globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' },
      voice: { status: 'off', error: null, action: 'none', revision: 0 },
      credentials: { reasoning: false, grokSpeech: false, secure: true }, reasoningAccounts: [],
    }
    vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, vi.fn(async () => state)))
    const { container } = render(<SettingsView {...baseProps()} />)
    await selectCategory('Agents')
    const nav = screen.getByRole('tablist', { name: 'Settings sections' })
    expect(within(nav).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Dictation', 'Transcription', 'Cleanup', 'Providers', 'Hosts', 'Phones', 'Cloud iPhone', 'Agents', 'Output', 'Appearance', 'Application', 'Git',
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
    }
    vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, vi.fn(async () => state)))
    const { container, rerender } = render(<SettingsView {...baseProps()} />)
    await selectCategory('Agents')
    const agents = container.querySelector('#settings-agents') as HTMLElement
    expect(within(agents).getByText('Reasoning, new threads & projects')).toBeInTheDocument()
    expect(within(agents).queryByText('Advanced wake settings')).toBeNull()
    expect(within(agents).queryByRole('button', { name: 'Stop speech' })).toBeNull()
    expect(within(agents).getByRole('combobox', { name: 'Reasoning account' })).toHaveValue('claude')
    // Nothing is deleted: turning the coordinator on brings the same controls back.
    vi.mocked(useVoiceCoordinatorEnabled).mockReturnValue(true)
    rerender(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, voiceCoordinatorEnabled: true } })} />)
    expect(within(agents).getByText('Reasoning, voice, new threads & projects')).toBeInTheDocument()
    expect(within(agents).getByText('Advanced wake settings')).toBeInTheDocument()
  })
})

function withProjects(hostId?: string): AgentState {
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
  }
  const clientState = hostId ? clientAgentState({ ...state, hostId }) : state
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(clientState, vi.fn(async () => clientState)))
  return clientState
}

describe('Project thread defaults in Application settings', () => {
  it('saves a local host project override that new thread creation actually uses', async () => {
    const state = withProjects('11111111-1111-4111-8111-111111111111')
    state.host.models = [{ id: 'codex:model', name: 'Model', provider: 'Codex', providerId: 'codex', ready: true }]
    let settings: SettingsViewProps['settings'] = { ...DEFAULT_SETTINGS, projectThreadWorkingCopyDefaults: { missing: 'shared' } }
    const onUpdateSettings = vi.fn<SettingsViewProps['onUpdateSettings']>(async patch => {
      const { worktreeCleanup, ...fields } = patch
      settings = { ...settings, ...fields, worktreeCleanup: { ...settings.worktreeCleanup, ...worktreeCleanup } }
      return true
    })
    vi.stubGlobal('sotto', { getSettings: async () => settings })
    try {
      const { rerender } = render(<SettingsView {...baseProps({ settings, onUpdateSettings })} />)
      await selectCategory('Application')
      await userEvent.click(screen.getByRole('button', { name: 'Project defaults' }))
      const choice = screen.getByRole('combobox', { name: 'New threads in this project work in' })
      await userEvent.selectOptions(choice, 'independent')
      const command = vi.fn(async () => state)
      await beginNewThread(state, command, state.host.projects[0]!)
      expect(command).toHaveBeenCalledWith(expect.objectContaining({ workingCopy: 'independent', startFromOrigin: true }))
      expect(settings.projectThreadWorkingCopyDefaults).toEqual({ missing: 'shared', one: 'independent' })
      rerender(<SettingsView {...baseProps({ settings, onUpdateSettings })} />)
      expect(choice).toHaveValue('independent')
      await userEvent.selectOptions(choice, 'inherit')
      expect(settings.projectThreadWorkingCopyDefaults).toEqual({ missing: 'shared' })
      await beginNewThread(state, command, state.host.projects[0]!)
      expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ workingCopy: 'shared' }))
    } finally { vi.unstubAllGlobals() }
  })

  it('keeps remote project defaults host-qualified when a local connection is present', async () => {
    const localHostId = '11111111-1111-4111-8111-111111111111'
    const remoteHostId = '22222222-2222-4222-8222-222222222222'
    const state = withProjects(remoteHostId)
    state.connections = [{ hostId: localHostId, kind: 'local', name: 'Local', connected: true }]
    const onUpdateSettings = vi.fn(async () => true)
    render(<SettingsView {...baseProps({ settings: { ...DEFAULT_SETTINGS, projectThreadWorkingCopyDefaults: { one: 'shared' } }, onUpdateSettings })} />)
    await selectCategory('Application')
    await userEvent.click(screen.getByRole('button', { name: 'Project defaults' }))
    const choice = screen.getByRole('combobox', { name: 'New threads in this project work in' })
    expect(choice).toHaveValue('inherit')
    await userEvent.selectOptions(choice, 'independent')
    expect(onUpdateSettings).toHaveBeenCalledWith({ projectThreadWorkingCopyDefaults: { one: 'shared', [hostEntityKey(remoteHostId, 'one')]: 'independent' } })
  })

  it('edits one project without losing other overrides and can restore inheritance', async () => {
    withProjects()
    const onUpdateSettings = vi.fn(async () => true)
    const props = baseProps({ settings: { ...DEFAULT_SETTINGS, projectThreadWorkingCopyDefaults: { one: 'independent', missing: 'shared' } }, onUpdateSettings })
    const { rerender } = render(<SettingsView {...props} />)
    await selectCategory('Application')
    await userEvent.click(screen.getByRole('button', { name: 'Project defaults' }))
    const choice = screen.getByRole('combobox', { name: 'New threads in this project work in' })
    expect(choice).toHaveValue('independent')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Project' }), 'two')
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
    expect(screen.getByRole('combobox', { name: 'Project' })).toBeDisabled()
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

describe('Personal dictionary draft acknowledgements', () => {
  it('keeps the paste status mounted and clears it when edits return below the limit', async () => {
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Cleanup')
    const input = screen.getByRole('textbox', { name: 'Personal dictionary' }) as HTMLTextAreaElement
    const status = screen.getByRole('status')
    expect(status).toBeEmptyDOMElement()
    fireEvent.change(input, { target: { value: 'a'.repeat(3990) } })
    input.setSelectionRange(3990, 3990)
    fireEvent.paste(input, { clipboardData: { getData: () => 'b'.repeat(20) } })
    fireEvent.change(input, { target: { value: 'a'.repeat(3990) + 'b'.repeat(10) } })
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toHaveTextContent('The pasted text was cut to fit the 4,000-character limit.')
    fireEvent.change(input, { target: { value: 'a'.repeat(3999) } })
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toBeEmptyDOMElement()
  })

  it('clears the cut-paste message after deleting text below the limit', async () => {
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Cleanup')
    const input = screen.getByRole('textbox', { name: 'Personal dictionary' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'a'.repeat(4000) } })
    input.setSelectionRange(4000, 4000)
    fireEvent.paste(input, { clipboardData: { getData: () => 'extra' } })
    expect(screen.getByText('The pasted text was cut to fit the 4,000-character limit.')).toBeVisible()
    fireEvent.change(input, { target: { value: 'a'.repeat(3999) } })
    expect(screen.queryByText('The pasted text was cut to fit the 4,000-character limit.')).not.toBeInTheDocument()
  })

  it('announces only pastes cut by the dictionary limit, accounting for the selection', async () => {
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Cleanup')
    const input = screen.getByRole('textbox', { name: 'Personal dictionary' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'a'.repeat(3990) } })
    input.setSelectionRange(3990, 3990)
    fireEvent.paste(input, { clipboardData: { getData: () => 'b'.repeat(20) } })
    expect(screen.getByRole('status')).toHaveTextContent('The pasted text was cut to fit the 4,000-character limit.')
    input.setSelectionRange(0, 20)
    fireEvent.paste(input, { clipboardData: { getData: () => 'b'.repeat(20) } })
    expect(screen.queryByText('The pasted text was cut to fit the 4,000-character limit.')).not.toBeInTheDocument()
  })

  it('limits the dictionary to 4000 characters and explains the limit when reached', async () => {
    render(<SettingsView {...baseProps()} />)
    await selectCategory('Cleanup')
    const input = screen.getByRole('textbox', { name: 'Personal dictionary' })
    expect(input).toHaveAttribute('maxlength', '4000')
    fireEvent.change(input, { target: { value: 'a'.repeat(4000) } })
    expect(input).toHaveAccessibleDescription(/4,000 characters maximum\./u)
  })

  it('flushes a changed dictionary draft on unmount without a blur', async () => {
    const update = vi.fn(async () => true)
    const view = render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Cleanup')
    fireEvent.change(screen.getByRole('textbox', { name: 'Personal dictionary' }), { target: { value: 'Sotto\nZach' } })
    view.unmount()
    expect(update).toHaveBeenCalledExactlyOnceWith({ llmDictionary: 'Sotto\nZach' })
  })

  it('keeps an older failed save quiet when a newer dictionary save is pending after close', async () => {
    const older = deferred<boolean>()
    const newer = deferred<boolean>()
    const onNotice = vi.fn()
    const update = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const view = render(<SettingsView {...baseProps({ onUpdateSettings: update, onNotice })} />)
    await selectCategory('Cleanup')
    const input = screen.getByRole('textbox', { name: 'Personal dictionary' })
    fireEvent.change(input, { target: { value: 'Older' } })
    fireEvent.blur(input)
    fireEvent.change(input, { target: { value: 'Newer' } })
    view.unmount()
    await act(async () => older.resolve(false))
    expect(onNotice).not.toHaveBeenCalled()
    await act(async () => newer.resolve(true))
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('does not duplicate an in-flight dictionary blur save on unmount', async () => {
    const pending = deferred<boolean>()
    const update = vi.fn(() => pending.promise)
    const view = render(<SettingsView {...baseProps({ onUpdateSettings: update })} />)
    await selectCategory('Cleanup')
    const input = screen.getByRole('textbox', { name: 'Personal dictionary' })
    fireEvent.change(input, { target: { value: 'Sotto' } })
    fireEvent.blur(input)
    view.unmount()
    expect(update).toHaveBeenCalledExactlyOnceWith({ llmDictionary: 'Sotto' })
    await act(async () => { pending.resolve(true) })
  })

  async function dictionary() {
    const answers: Array<ReturnType<typeof deferred<boolean>>> = []
    const update = vi.fn<SettingsViewProps['onUpdateSettings']>(() => { const answer = deferred<boolean>(); answers.push(answer); return answer.promise })
    const props = baseProps({ onUpdateSettings: update })
    const view = render(<SettingsView {...props} />)
    await selectCategory('Cleanup')
    const input = screen.getByRole('textbox', { name: 'Personal dictionary' })
    const edit = (value: string) => { input.focus(); fireEvent.change(input, { target: { value } }) }
    const publish = (value: string) => view.rerender(<SettingsView {...props} settings={{ ...props.settings, llmDictionary: value }} />)
    return { input, edit, publish, answers, update }
  }

  it.each(['before', 'after'] as const)('preserves newer typing when an older acknowledgement is published %s its save result', async order => {
    const f = await dictionary()
    f.edit('Sotto'); fireEvent.blur(f.input)
    f.edit('Sotto\nZach')
    if (order === 'before') f.publish('Sotto')
    await act(async () => f.answers[0]!.resolve(true))
    if (order === 'after') f.publish('Sotto')
    expect(f.input).toHaveValue('Sotto\nZach')
    expect(f.input).toHaveFocus()
    fireEvent.blur(f.input)
    expect(f.update).toHaveBeenLastCalledWith({ llmDictionary: 'Sotto\nZach' })
    f.publish('Sotto\nZach')
    await act(async () => f.answers[1]!.resolve(true))
    expect(f.input).toHaveValue('Sotto\nZach')
    expect(screen.getByText('Dictionary saved.')).toHaveAttribute('role', 'status')
  })

  it('retains the latest draft through repeated blur and refocus while earlier saves are queued', async () => {
    const f = await dictionary()
    f.edit('A'); fireEvent.blur(f.input)
    f.edit('B'); fireEvent.blur(f.input)
    f.edit('C')
    f.publish('A'); await act(async () => f.answers[0]!.resolve(true))
    expect(f.input).toHaveValue('C')
    f.publish('B'); await act(async () => f.answers[1]!.resolve(true))
    expect(f.input).toHaveValue('C')
    fireEvent.blur(f.input)
    expect(f.update.mock.calls.map(([patch]) => patch)).toEqual([{ llmDictionary: 'A' }, { llmDictionary: 'B' }, { llmDictionary: 'C' }])
    f.publish('C'); await act(async () => f.answers[2]!.resolve(true))
    expect(f.input).toHaveValue('C')
  })

  it('saves a return to the previous value when an older different value is still queued', async () => {
    const f = await dictionary()
    f.edit('A'); fireEvent.blur(f.input)
    f.edit(''); fireEvent.blur(f.input)
    expect(f.update.mock.calls.map(([patch]) => patch)).toEqual([{ llmDictionary: 'A' }, { llmDictionary: '' }])
    f.publish('A'); await act(async () => f.answers[0]!.resolve(true))
    expect(f.input).toHaveValue('')
    f.publish(''); await act(async () => f.answers[1]!.resolve(true))
    expect(f.input).toHaveValue('')
  })

  it('accepts an external update while saving and ignores the older acknowledgement afterward', async () => {
    const f = await dictionary()
    f.edit('A'); fireEvent.blur(f.input)
    f.publish('External')
    expect(f.input).toHaveValue('External')
    f.publish('A'); await act(async () => f.answers[0]!.resolve(true))
    expect(f.input).toHaveValue('External')
    fireEvent.blur(f.input)
    expect(f.update).toHaveBeenLastCalledWith({ llmDictionary: 'External' })
  })

  it('commits an explicit dictionary return to the value of an ignored older receipt', async () => {
    const f = await dictionary()
    f.edit('A'); fireEvent.blur(f.input)
    f.publish('External')
    f.publish('A'); await act(async () => f.answers[0]!.resolve(true))
    expect(f.input).toHaveValue('External')
    f.edit('A'); fireEvent.blur(f.input)
    expect(f.update.mock.calls).toEqual([[{ llmDictionary: 'A' }], [{ llmDictionary: 'A' }]])
  })
  it('retains the draft when the update rejects and retries it on the next blur', async () => {
    const f = await dictionary()
    f.update.mockRejectedValueOnce(new Error('Synthetic save rejection'))
    f.edit('Sotto'); fireEvent.blur(f.input)
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved')
    expect(f.input).toHaveValue('Sotto')
    f.input.focus(); fireEvent.blur(f.input)
    expect(f.update).toHaveBeenCalledTimes(2)
    f.publish('Sotto'); await act(async () => f.answers[0]!.resolve(true))
    expect(f.input).toHaveValue('Sotto')
  })

  it('keeps failed text available for another blur and never restores a superseded failed draft', async () => {
    const f = await dictionary()
    f.edit('A'); fireEvent.blur(f.input)
    f.edit('B'); fireEvent.blur(f.input)
    await act(async () => f.answers[0]!.resolve(false))
    expect(f.input).toHaveValue('B')
    await act(async () => f.answers[1]!.resolve(false))
    expect(f.input).toHaveValue('B')
    expect(screen.getByRole('alert')).toHaveTextContent('Your previous setting is still active.')
    f.input.focus(); fireEvent.blur(f.input)
    expect(f.update).toHaveBeenLastCalledWith({ llmDictionary: 'B' })
    f.publish('B'); await act(async () => f.answers[2]!.resolve(true))
    expect(f.input).toHaveValue('B')
  })

  it('accepts external settings updates and does not treat an unrelated setting publication as a dictionary acknowledgement', async () => {
    const f = await dictionary()
    f.publish('External')
    expect(f.input).toHaveValue('External')
    f.edit('A'); fireEvent.blur(f.input)
    f.edit('B')
    f.publish('External')
    expect(f.input).toHaveValue('B')
    f.publish('A'); await act(async () => f.answers[0]!.resolve(true))
    expect(f.input).toHaveValue('B')
    f.publish('New external')
    expect(f.input).toHaveValue('New external')
  })

  it('saves exact multiline text on keyboard blur and skips an unchanged field', async () => {
    const f = await dictionary()
    const user = userEvent.setup()
    await user.click(f.input)
    await user.type(f.input, '  Sotto{Enter}Zach  ')
    await user.tab()
    expect(f.update).toHaveBeenCalledOnce()
    expect(f.update).toHaveBeenCalledWith({ llmDictionary: '  Sotto\nZach  ' })
    f.publish('  Sotto\nZach  '); await act(async () => f.answers[0]!.resolve(true))
    await user.click(f.input); await user.tab()
    expect(f.update).toHaveBeenCalledOnce()
    expect(f.input).toHaveValue('  Sotto\nZach  ')
  })
})

describe('Settings draft editing work', () => {
  it.each([
    { category: 'Cleanup', label: 'Personal dictionary', field: 'llmDictionary', text: 'Sotto', saved: 'Sotto', blurCommits: 0 },
    { category: 'Output', label: 'Paste delay', field: 'pasteDelayMs', text: '300', saved: 300, blurCommits: 1 },
  ])('does no extra render or request while editing $label', async ({ category, label, field, text, saved, blurCommits }) => {
    const pending = deferred<boolean>()
    const update = vi.fn(() => pending.promise)
    const props = baseProps({ onUpdateSettings: update })
    let commits = 0
    const count = () => { commits += 1 }
    const view = render(<React.Profiler id="settings-drafts" onRender={count}><SettingsView {...props} /></React.Profiler>)
    await selectCategory(category)
    await act(async () => undefined)
    const input = screen.getByRole('textbox', { name: label })
    const before = commits
    for (let end = 1; end <= text.length; end += 1) fireEvent.change(input, { target: { value: text.slice(0, end) } })
    expect(commits - before).toBe(text.length)
    expect(update).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(update).toHaveBeenCalledExactlyOnceWith({ [field]: saved })
    expect(commits - before).toBe(text.length + blurCommits)
    await act(async () => { pending.resolve(true) })
    expect(commits - before).toBe(text.length + blurCommits + 1)
    const afterSave = commits
    view.rerender(<React.Profiler id="settings-drafts" onRender={count}><SettingsView {...props} settings={{ ...props.settings, [field]: saved }} /></React.Profiler>)
    expect(commits - afterSave).toBe(1)
    expect(input).toHaveValue(text)
    expect(update).toHaveBeenCalledTimes(1)
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

it('explains a failed secure key migration beside the Settings key field until a key is saved', () => {
  const props = baseProps({ openRouterKeyMigrationFailed: true })
  const view = render(<SettingsView {...props} />)
  expect(screen.getByText('The OpenRouter key could not be stored securely. Enter it again.')).toBeInTheDocument()
  view.rerender(<SettingsView {...props} settings={{ ...DEFAULT_SETTINGS, llmApiKey: 'Saved in your operating system credential store' }} />)
  expect(screen.queryByText('The OpenRouter key could not be stored securely. Enter it again.')).not.toBeInTheDocument()
})

it('says reset preserves the saved OpenRouter key before confirmation', async () => {
  render(<SettingsView {...baseProps()} />)
  await selectCategory('Application')
  await userEvent.click(screen.getByRole('button', { name: 'Reset settings' }))
  expect(screen.getByText('Defaults will be restored and first-run setup will reopen. Your saved OpenRouter key and history are preserved.')).toBeVisible()
})
