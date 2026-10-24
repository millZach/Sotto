import { deferred } from '../../fixtures/deferred'
import { threadsStateFixture } from '../../fixtures/agentState'
import React from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, PROVIDER_LABELS, providerIdSchema, type AgentBridge, type AgentState, type ProviderId } from '../../../src/shared/agents'
import { HELD_PROVIDER_ENTRIES } from '../../../src/shared/heldProviders'
import { useAgentConnection, useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ProvidersSettings } from '../../../src/renderer/src/agents/ProvidersSettings'
import { ThreadOptions } from '../../../src/renderer/src/agents/ThreadOptions'
import { AgentSetupFields } from '../../../src/renderer/src/agents/AgentAccountSettings'
import { agentContextFixture } from '../../fixtures/agentContext'
import { AppProvider } from '../../../src/renderer/src/state/AppContext'
import { createBridge, createController } from '../../fixtures/renderer/appHarness'

/** The providers an Owl feature holds; a run with no Owl answers shows none of them. */
const HELD: ReadonlySet<ProviderId> = new Set(HELD_PROVIDER_ENTRIES.map(entry => entry.provider))

vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))
const caps = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
function fixture(): AgentState {
  return threadsStateFixture({ cloneOverrides: false,
    configuration: { ...defaultAgentConfiguration(), enabledProviders: ['codex', 'claude', 'grok'], reasoning: 'claude', reasoningModel: 'coordinator-model' },
    host: { connected: true, name: 'Providers', version: '', capabilities: caps, projects: [],
      providers: providerIdSchema.options.map(id => ({ id, name: PROVIDER_LABELS[id], version: '1.2.3', connection: 'connected', capabilities: caps })),
      models: providerIdSchema.options.map(id => ({ id: `${id}:same-native-model`, name: `${id} model`, provider: PROVIDER_LABELS[id], providerId: id, ready: true })),
      threads: [{ id: 'thread', providerId: 'codex', projectId: 'project', title: 'Codex work', modelId: 'codex:same-native-model', status: 'idle', messages: [], requests: [] }],
    },
    topLevel: { activeThreadId: 'thread', activeProjectId: null } })
}
function provide(state = fixture()) {
  const command = vi.fn(async () => state)
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, command))
  return { state, command }
}
afterEach(() => { cleanup(); vi.clearAllMocks() })
/** Opens a provider's row, leaving it open if it already is, and returns what it shows. */
function openRow(provider: string): HTMLElement {
  const header = screen.getByRole('button', { name: provider })
  if (header.getAttribute('aria-expanded') !== 'true') fireEvent.click(header)
  return screen.getByRole('region', { name: `${provider} details` })
}

describe('independent provider settings', () => {
  it('shows and acts on this computer’s clients while another host is selected for new work', async () => {
    const LOCAL = '11111111-1111-4111-8111-111111111111', FORGE = '22222222-2222-4222-8222-222222222222'
    const base = fixture()
    const here = base.host.providers!.map(provider => provider.id === 'codex' ? { ...provider, version: '0.130.0' } : provider)
    // The selected host is forge, whose Codex is signed out. Its status is what the top level carries.
    const forge = base.host.providers!.map(provider => provider.id === 'codex'
      ? { ...provider, version: '0.120.0', connection: 'error' as const, problem: 'signed-out' as const, error: 'Could not connect Codex. Sign in to Codex on forge, then connect it again.' } : provider)
    const state: AgentState = { ...base, hostId: FORGE,
      configuration: { ...base.configuration, enabledProviders: ['grok'], checkClientUpdates: false },
      connections: [{ hostId: LOCAL, name: 'This computer', kind: 'local', connected: true }, { hostId: FORGE, name: 'forge', kind: 'remote', connected: true }],
      host: { ...base.host, providers: forge, clientHosts: [
        { hostId: LOCAL, connected: true, models: base.host.models, capabilities: caps, providers: here, enabledProviders: ['codex', 'claude', 'grok'], checkClientUpdates: true },
        { hostId: FORGE, connected: true, models: [], capabilities: caps, providers: forge },
      ] } }
    const { command } = provide(state)
    render(<ProvidersSettings />)
    // This computer's switches, version and status, never forge's.
    expect(screen.getByRole('switch', { name: 'Enable Codex' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('0.130.0')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(screen.getByRole('button', { name: 'Codex' })).getByText('Connected')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Check for client updates' })).toHaveAttribute('aria-checked', 'true')
    // Every press names this computer, so none reaches forge.
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Codex' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'disconnect', provider: 'codex', hostId: LOCAL }))
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'check-client-updates', hostId: LOCAL }))
    fireEvent.click(screen.getByRole('switch', { name: 'Check for client updates' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure', patch: { checkClientUpdates: false }, hostId: LOCAL }))
  })
  it('tags this computer’s agent setting in an open row’s models, never the selected host’s', () => {
    const LOCAL = '11111111-1111-4111-8111-111111111111', FORGE = '22222222-2222-4222-8222-222222222222'
    const base = fixture()
    // Forge's agent setting would start threads on Claude Code; this computer's starts them on Codex.
    const state: AgentState = { ...base, hostId: FORGE, configuration: { ...base.configuration, defaultModelId: 'claude:same-native-model' },
      connections: [{ hostId: LOCAL, name: 'This computer', kind: 'local', connected: true }, { hostId: FORGE, name: 'forge', kind: 'remote', connected: true }],
      host: { ...base.host, clientHosts: [
        { hostId: LOCAL, connected: true, models: base.host.models, capabilities: caps, providers: base.host.providers, enabledProviders: ['codex', 'claude'], agentModelId: 'codex:same-native-model' },
        { hostId: FORGE, connected: true, models: [], capabilities: caps, providers: base.host.providers },
      ] } }
    provide(state)
    render(<ProvidersSettings />)
    const models = (provider: string) => within(openRow(provider)).getByRole('list', { name: `${provider} available models` })
    expect(models('Codex')).toHaveTextContent('Agent setting')
    expect(models('Claude Code')).not.toHaveTextContent('Agent setting')
  })
  it('says this computer’s host is off, and offers nothing that would reach the selected host, when it is turned off', () => {
    const FORGE = '22222222-2222-4222-8222-222222222222'
    const base = fixture()
    const { command } = provide({ ...base, hostId: FORGE, connections: [{ hostId: FORGE, name: 'forge', kind: 'remote', connected: true }],
      host: { ...base.host, clientHosts: [{ hostId: FORGE, connected: true, models: [], capabilities: caps, providers: base.host.providers }] } })
    render(<ProvidersSettings />)
    expect(screen.getByRole('status')).toHaveTextContent('This computer’s local host is off')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(command).not.toHaveBeenCalled()
  })
  it('asks a provider that needs attention again when Check again is pressed, after someone signs in', async () => {
    const state = fixture()
    state.host.providers = state.host.providers!.map(provider => provider.id === 'codex'
      ? { ...provider, connection: 'error' as const, problem: 'signed-out' as const, error: 'Could not connect Codex. Sign in to Codex on this machine, then connect it again.' } : provider)
    const { command } = provide(state)
    render(<ProvidersSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'check-client-updates' }))
    expect(command).toHaveBeenNthCalledWith(1, { type: 'refresh', provider: 'codex' })
    // A connected provider is left alone: Check again then only reads versions.
    command.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }))
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'check-client-updates' }))
    expect(command).toHaveBeenCalledTimes(1)
  })
  it('shows three enabled connections and disconnects only the selected provider', async () => {
    const { state, command } = provide()
    render(<ProvidersSettings />)
    for (const label of ['Codex', 'Claude Code', 'Grok Build']) expect(screen.getByRole('switch', { name: `Enable ${label}` })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Grok Build' }))
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Grok Build' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'disconnect', provider: 'grok' }))
    expect(state.configuration.reasoning).toBe('claude')
    expect(command).toHaveBeenCalledTimes(1)
  })
  it('keeps the Agents choice authoritative without a competing provider thread-default control', () => {
    const state = fixture()
    state.configuration.defaultModelId = 'grok:same-native-model'
    const { command } = provide(state)
    render(<ProvidersSettings />)
    // Muse and OpenCode are Owl features: with no Owl answers neither is offered at all (ADR-0079, ADR-0087).
    expect(screen.queryByRole('button', { name: 'Muse' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'OpenCode' })).toBeNull()
    for (const provider of providerIdSchema.options.filter(id => !HELD.has(id))) {
      fireEvent.click(screen.getByRole('button', { name: PROVIDER_LABELS[provider] }))
      expect(screen.queryByRole('combobox', { name: /default thread model/i })).toBeNull()
    }
    expect(state.configuration.reasoning).toBe('claude')
    expect(command).not.toHaveBeenCalled()
  })
  it('keeps Devin disabled on upgrade and explains native setup and data handling', async () => {
    const state = fixture()
    const devin = state.host.providers!.find(provider => provider.id === 'devin')!
    devin.connection = 'disconnected'
    const { command } = provide(state)
    render(<ProvidersSettings />)
    expect(screen.getByRole('switch', { name: 'Enable Devin' })).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Devin' }))
    expect(screen.getByText(/Install Devin CLI and run devin auth login/)).toBeVisible()
    expect(screen.getByText(/Devin keeps its own history and analytics, outside Sotto.s control/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Connect Devin' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'connect', provider: 'devin', notice: false }))
    expect(state.configuration.reasoning).toBe('claude')
  })
  it('opens one row at a time in place, and closes the open row from its header or with Escape', () => {
    provide()
    render(<ProvidersSettings />)
    const codex = screen.getByRole('button', { name: 'Codex' })
    const claude = screen.getByRole('button', { name: 'Claude Code' })
    // Codex's row is open to begin with, showing its connection, client and models in place; the others are closed.
    expect(codex).toHaveAttribute('aria-expanded', 'true')
    const panel = screen.getByRole('region', { name: 'Codex details' })
    expect(codex).toHaveAttribute('aria-controls', panel.id)
    expect(within(panel).getByRole('button', { name: 'Disconnect Codex' })).toBeVisible()
    expect(within(panel).getByText('Installed client')).toBeVisible()
    expect(within(panel).getByRole('list', { name: 'Codex available models' })).toHaveTextContent('codex model')
    expect(claude).toHaveAttribute('aria-expanded', 'false')
    expect(claude).not.toHaveAttribute('aria-controls')
    expect(screen.queryByRole('tablist')).toBeNull()
    // Opening another row closes the first.
    fireEvent.click(claude)
    expect(claude).toHaveAttribute('aria-expanded', 'true')
    expect(codex).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: 'Codex details' })).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Claude Code details' })).getByText('claude model')).toBeVisible()
    // Its header closes it again, leaving none open.
    fireEvent.click(claude)
    expect(screen.queryByRole('region', { name: /details$/u })).toBeNull()
    // Escape inside an open row closes it and gives focus back to its header.
    fireEvent.click(claude)
    const disconnect = screen.getByRole('button', { name: 'Disconnect Claude Code' })
    disconnect.focus()
    fireEvent.keyDown(disconnect, { key: 'Escape' })
    expect(claude).toHaveAttribute('aria-expanded', 'false')
    expect(claude).toHaveFocus()
  })
  it('moves between the rows’ headers with Up and Down, Home and End', () => {
    provide()
    render(<ProvidersSettings />)
    const shown = providerIdSchema.options.filter(id => !HELD.has(id)).map(id => screen.getByRole('button', { name: PROVIDER_LABELS[id] }))
    shown[0]!.focus()
    fireEvent.keyDown(shown[0]!, { key: 'ArrowDown' })
    expect(shown[1]).toHaveFocus()
    fireEvent.keyDown(shown[1]!, { key: 'ArrowUp' })
    expect(shown[0]).toHaveFocus()
    // Up from the first goes round to the last, and Down from the last back to the first.
    fireEvent.keyDown(shown[0]!, { key: 'ArrowUp' })
    expect(shown.at(-1)).toHaveFocus()
    fireEvent.keyDown(shown.at(-1)!, { key: 'ArrowDown' })
    expect(shown[0]).toHaveFocus()
    fireEvent.keyDown(shown[0]!, { key: 'End' })
    expect(shown.at(-1)).toHaveFocus()
    fireEvent.keyDown(shown.at(-1)!, { key: 'Home' })
    expect(shown[0]).toHaveFocus()
    // Moving opens nothing, and the switch beside a header keeps its own keys.
    expect(screen.getAllByRole('region', { name: /details$/u })).toHaveLength(1)
    const toggle = screen.getByRole('switch', { name: 'Enable Codex' })
    toggle.focus()
    fireEvent.keyDown(toggle, { key: 'ArrowDown' })
    expect(toggle).toHaveFocus()
  })
  it("marks each provider's row with that provider's mark on its own badge", () => {
    provide()
    render(<ProvidersSettings />)
    for (const provider of providerIdSchema.options.filter(id => !HELD.has(id))) {
      // Every provider Sotto ships draws its own mark; the initial is the fallback for one it has none for.
      const drawn = screen.getByRole('button', { name: PROVIDER_LABELS[provider] }).querySelector(`.provider-badge[data-provider="${provider}"] > svg.provider-mark[data-provider="${provider}"]`)
      expect(drawn, `${provider} needs its own mark rather than its initial`).not.toBeNull()
      expect(drawn!.querySelector('path')?.getAttribute('d')).toBeTruthy()
    }
  })
  it('offers Muse in Sotto Owl with its own sign-in guidance (ADR-0079)', async () => {
    provide()
    render(<AppProvider bridge={createBridge({ getUpdateStatus: async () => ({ currentVersion: '0.1.37-owl.20261012.1', releaseTrack: 'owl', owlFeatures: { watcher: false, muse: true }, phase: { phase: 'unsupported' }, checkedAt: null }) as never })} createController={createController}><ProvidersSettings /></AppProvider>)
    const muse = await screen.findByRole('button', { name: 'Muse' })
    fireEvent.click(muse)
    expect(screen.getByText(/Uses your Muse sign-in on this computer/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Copy Muse login command' })).toBeVisible()
  })
  it('shows a provider-specific failure and retries it while others stay connected', async () => {
    const state = fixture()
    state.host.providers![1] = { ...state.host.providers![1]!, connection: 'error', error: 'Sign in to Claude Code.' }
    const { command } = provide(state)
    render(<ProvidersSettings />)
    // The error shows under Claude Code's row while it is closed, with Codex's open.
    expect(screen.getByRole('button', { name: 'Claude Code' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in to Claude Code.')
    expect(within(screen.getByRole('button', { name: 'Claude Code' })).getByText('Needs attention')).toBeInTheDocument()
    openRow('Claude Code')
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in to Claude Code.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry Claude Code' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'connect', provider: 'claude', notice: false }))
    expect(state.host.providers![0]!.connection).toBe('connected')
  })
  it('shows only the open provider catalog and keeps new-thread defaults in Agents settings', () => {
    provide()
    const view = render(<ProvidersSettings />)
    const panel = openRow('Claude Code')
    expect(within(panel).getByText('claude model')).toBeVisible()
    expect(within(panel).queryByText('codex model')).toBeNull()
    expect(screen.queryByLabelText('Reasoning account')).toBeNull()
    view.unmount()
    render(<AgentSetupFields />)
    expect(screen.queryByLabelText('Reasoning account')).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Thread model' })).toHaveTextContent('coordinator-model')
    expect(screen.queryByLabelText('Thread provider')).toBeNull()
  })
  it('keeps existing thread model choices in its provider and disables them when that provider is offline', () => {
    const state = fixture()
    const command = vi.fn(async () => state)
    const view = render(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread model' }))
    expect(screen.getByRole('option', { name: 'codex model' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'claude model' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close model picker' }))
    state.host.providers![0]!.connection = 'disconnected'
    view.rerender(<ThreadOptions thread={state.host.threads[0]!} state={state} command={command} />)
    expect(screen.getByRole('combobox', { name: 'Thread model' })).toBeDisabled()
  })
  it('offers only permissions on a started thread whose provider cannot change its model', async () => {
    const state = fixture()
    const grok = state.host.providers!.find(provider => provider.id === 'grok')!
    grok.capabilities = { ...caps, configureThreadModel: false }
    state.host.models = state.host.models.map(model => model.providerId === 'grok' ? { ...model, reasoningEfforts: ['low', 'high'], runtimeModes: ['approval-required', 'auto', 'full-access'] } : model)
    const thread = { ...state.host.threads[0]!, id: 'grok-thread', providerId: 'grok' as const, modelId: 'grok:same-native-model', runtimeMode: 'approval-required' as const }
    state.host.threads = [thread]
    const command = vi.fn(async () => state)
    render(<ThreadOptions thread={thread} state={state} command={command} />)
    expect(screen.getByRole('combobox', { name: 'Thread model' })).toBeDisabled()
    expect(screen.getByLabelText('Thread reasoning')).toBeDisabled()
    fireEvent.click(screen.getByRole('combobox', { name: 'Thread permissions' }))
    fireEvent.click(screen.getByRole('option', { name: 'Full access' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure-thread', threadId: 'grok-thread', runtimeMode: 'full-access' }))
  })
  it.each([undefined, 'grok'] as const)('does not queue a healthy send behind provider connection %s in the renderer', async provider => {
    const state = fixture()
    const { promise: gate, resolve: release } = deferred<void>()
    const bridge: AgentBridge = { get: async () => state, onState: () => () => undefined,
      command: vi.fn(async command => { if (command.type === 'connect') await gate; return state }) }
    const { result } = renderHook(() => useAgentConnection(bridge))
    await waitFor(() => expect(result.current.state).not.toBeNull())
    let connecting!: Promise<AgentState | null>
    let sending!: Promise<AgentState | null>
    try {
      act(() => { connecting = result.current.command({ type: 'connect', ...(provider ? { provider } : {}) }) })
      act(() => { sending = result.current.command({ type: 'manual-send', threadId: 'thread', text: 'Hello', draftId: '00000000-0000-4000-8000-000000000001' }) })
      await waitFor(() => expect(bridge.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'manual-send' })))
    } finally { await act(async () => { release(); await connecting; await sending }) }
  })
})

describe('the installed client, in provider settings', () => {
  it('names the installed and published versions, and updates on a press', async () => {
    const state = fixture()
    state.clientUpdates = [{ id: 'codex', installed: '0.155.1', published: '0.156.0', behind: true, channel: 'npm',
      command: 'npm install -g @openai/codex@latest', canInstall: true, checkedAt: new Date().toISOString(), state: 'idle' }]
    const { command } = provide(state)
    render(<ProvidersSettings />)
    expect(screen.getByText('0.155.1 is installed; 0.156.0 is published. Your threads keep working while it installs.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'update-client', provider: 'codex' }))
  })

  it('offers Update to the published version on a closed row, and updates from it', async () => {
    const state = fixture()
    state.clientUpdates = [{ id: 'claude', installed: '2.1.4', published: '2.1.7', behind: true, channel: 'npm',
      command: 'npm install -g @anthropic-ai/claude-code@latest', canInstall: true, checkedAt: new Date().toISOString(), state: 'idle' }]
    const { command } = provide(state)
    render(<ProvidersSettings />)
    expect(screen.getByRole('button', { name: 'Claude Code' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: /^Update Codex/u })).toBeNull()
    const chip = screen.getByRole('button', { name: 'Update Claude Code to 2.1.7' })
    expect(chip).toHaveTextContent('Update to 2.1.7')
    fireEvent.click(chip)
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'update-client', provider: 'claude' }))
  })

  it('offers no Update chip while client update checks are off', () => {
    const state = fixture()
    state.configuration.checkClientUpdates = false
    state.clientUpdates = [{ id: 'claude', installed: '2.1.4', published: '2.1.7', behind: true, channel: 'npm',
      canInstall: true, checkedAt: new Date().toISOString(), state: 'idle' }]
    provide(state)
    render(<ProvidersSettings />)
    expect(screen.queryByRole('button', { name: /^Update Claude Code/u })).toBeNull()
  })

  it('says mise does not list the published version yet, in its own words rather than main’s', () => {
    const state = fixture()
    state.clientUpdates = [{ id: 'codex', installed: '0.163.0', published: '0.164.0', behind: true, channel: 'mise', command: 'mise install codex@0.164.0',
      canInstall: true, checkedAt: new Date().toISOString(), state: 'failed', step: 1, failure: 'not-listed', error: 'mise does not list Codex 0.164.0 yet.' }]
    provide(state)
    render(<ProvidersSettings />)
    expect(screen.getByText('0.163.0 is installed. mise does not list 0.164.0 yet, even with its cache cleared, so Sotto did not install it. Try again later.')).toBeTruthy()
  })

  it('says when a client is newer than the version Sotto checked', () => {
    const state = fixture()
    state.host.providers = state.host.providers!.map(provider => provider.id === 'codex' ? { ...provider, verifiedVersion: '0.150.0' } : provider)
    state.clientUpdates = [{ id: 'codex', installed: '0.155.1', published: '0.155.1', behind: false, channel: 'npm',
      canInstall: false, checkedAt: new Date().toISOString(), state: 'idle' }]
    provide(state)
    render(<ProvidersSettings />)
    expect(screen.getByText(/newer than the 0\.150\.0 Sotto has checked/u)).toBeTruthy()
  })

  it('updates with a thread working, and says the threads keep working rather than warning', async () => {
    const state = fixture()
    state.host.threads = [{ id: 'busy', providerId: 'codex', projectId: 'project', title: 'Codex work', modelId: 'codex:same-native-model', status: 'running', messages: [], requests: [] }]
    state.clientUpdates = [{ id: 'codex', installed: '0.155.1', published: '0.156.0', behind: true, channel: 'npm',
      command: 'npm install -g @openai/codex@latest', canInstall: true, checkedAt: new Date().toISOString(), state: 'idle' }]
    const { command } = provide(state)
    render(<ProvidersSettings />)
    expect(screen.getByText(/0\.156\.0 is published\. Your threads keep working while it installs\./u)).toBeTruthy()
    expect(screen.queryByText(/stops/u)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'update-client', provider: 'codex' }))
  })

  it('turns the whole check off from one switch', async () => {
    const { command } = provide(fixture())
    render(<ProvidersSettings />)
    fireEvent.click(screen.getByRole('switch', { name: 'Check for client updates' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure', patch: { checkClientUpdates: false } }))
  })
})
