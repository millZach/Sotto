import { threadsStateFixture } from '../../../../fixtures/agentState'
import { deferred, baseProps, selectCategory } from '../../../../fixtures/renderer/settingsViewHarness'
import React from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { useOptionalAgents } from '../../../../../src/renderer/src/agents/AgentContext'
import { SettingsView, type SettingsViewProps } from '../../../../../src/renderer/src/features/settings/SettingsView'
import { defaultAgentConfiguration, type AgentState } from '../../../../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../../../../src/shared/settings'
import { agentContextFixture } from '../../../../fixtures/agentContext'
import { clientAgentState, hostEntityKey } from '../../../../../src/shared/clientIdentity'
import { beginNewThread } from '../../../../../src/renderer/src/agents/newThread'

function withProjects(hostId?: string): AgentState {
  const state: AgentState = threadsStateFixture({ cloneOverrides: false,
    configuration: defaultAgentConfiguration(),
    host: {
      connected: false, name: 'Providers', version: '', models: [], threads: [],
      capabilities: { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true },
      projects: [{ id: 'one', title: 'One', path: 'C:/One' }, { id: 'two', title: 'Two', path: 'C:/Two' }],
    },
    topLevel: { connection: 'disconnected', assignments: [], queue: [], activeThreadId: null, activeProjectId: null } })
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
