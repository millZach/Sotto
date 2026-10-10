import { threadsStateFixture } from '../../../../fixtures/agentState'
import { deferred, baseProps, copy, selectCategory } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { useOptionalAgents } from '../../../../../src/renderer/src/agents/AgentContext'
import { SettingsView } from '../../../../../src/renderer/src/features/settings/SettingsView'
import { useVoiceCoordinatorEnabled } from '../../../../../src/renderer/src/state/voiceCoordinator'
import { defaultAgentConfiguration, type AgentState } from '../../../../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../../../../src/shared/settings'
import { agentContextFixture } from '../../../../fixtures/agentContext'

describe('SettingsView', () => {
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

  it('places Hosts, Phones and Agents after Providers and exposes Reasoning account inline', async () => {
    const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
    const state: AgentState = threadsStateFixture({ cloneOverrides: false,
    configuration: { ...defaultAgentConfiguration(), reasoning: 'claude' },
    host: { connected: false, name: 'Providers', version: '', capabilities, projects: [], models: [], threads: [] },
    topLevel: { connection: 'disconnected', assignments: [], queue: [], activeThreadId: null, activeProjectId: null } })
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
    const state: AgentState = threadsStateFixture({ cloneOverrides: false,
    configuration: { ...defaultAgentConfiguration(), reasoning: 'claude' },
    host: { connected: false, name: 'Providers', version: '', capabilities, projects: [], models: [], threads: [] },
    topLevel: { connection: 'disconnected', assignments: [], queue: [], activeThreadId: null, activeProjectId: null } })
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
