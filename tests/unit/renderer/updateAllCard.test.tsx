import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, PROVIDER_LABELS, providerIdSchema, type AgentClientHost, type AgentState, type ProviderClientUpdate } from '../../../src/shared/agents'
import type { UpdateStatus } from '../../../src/shared/contracts'
import type { HostsBridge, HostsState, HostStatus } from '../../../src/shared/hosts'
import type { HostUpdateState } from '../../../src/shared/hostUpdates'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { useOptionalApp, type AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { UpdateAllCard, requestUpdateAll } from '../../../src/renderer/src/features/updates/UpdateAllCard'
import { agentContextFixture } from '../../fixtures/agentContext'
import { threadsStateFixture } from '../../fixtures/agentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))

const FORGE = '6f0d1c5e-8c5b-4f8e-9a51-1f6f3f8d2a10'
const FORGE_HOST = '2a6c8e41-3b8f-4d4e-8a3f-7d1c2b9e5f60'
const caps = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
const behind = (patch: Partial<ProviderClientUpdate> = {}): ProviderClientUpdate => ({
  id: 'claude', installed: '2.1.40', published: '2.1.42', behind: true, channel: 'npm', canInstall: true, checkedAt: new Date().toISOString(), state: 'idle', ...patch,
})
function agentState(options: { local?: ProviderClientUpdate[]; forge?: ProviderClientUpdate[]; working?: boolean } = {}): AgentState {
  const clientHosts: AgentClientHost[] = options.forge ? [{ hostId: FORGE_HOST, connected: true, models: [], capabilities: caps, clientUpdates: options.forge }] : []
  return threadsStateFixture({ cloneOverrides: false, configuration: defaultAgentConfiguration(),
    host: { connected: true, name: 'Providers', version: '', capabilities: caps, projects: [], models: [], clientHosts,
      providers: providerIdSchema.options.map(id => ({ id, name: PROVIDER_LABELS[id], version: '1.0.0', connection: 'connected' as const, capabilities: caps })),
      threads: [{ id: 'thread', providerId: 'claude', projectId: 'project', title: 'Work', modelId: 'claude:opus', status: options.working ? 'running' : 'idle', messages: [], requests: [] }] },
    topLevel: { clientUpdates: options.local ?? [], activeThreadId: null, activeProjectId: null } })
}
const forge = { id: FORGE, name: 'forge', hostId: FORGE_HOST, phase: 'connected', enabled: true, owned: true } as unknown as HostStatus
const hostUpdate = (patch: Partial<HostUpdateState> = {}): HostUpdateState => ({ id: FORGE, name: 'forge', from: '0.1.35', to: '0.1.37', phase: 'needs', owned: true, working: 0, commands: 'update forge', ...patch })
function hostsBridge(state: HostsState) {
  let changed: ((next: HostsState) => void) | undefined
  const bridge = {
    get: vi.fn(async () => state), onChanged: vi.fn((listener: (next: HostsState) => void) => { changed = listener; return () => undefined }),
    command: vi.fn(async () => state), updateClients: vi.fn(async () => ({})),
  }
  return { bridge, asBridge: bridge as unknown as HostsBridge, change: (next: HostsState) => act(() => changed?.(next)) }
}
const available: UpdateStatus = { currentVersion: '0.1.37-owl.20261012.1', releaseTrack: 'owl', owlFeatures: { watcher: true, 'resume-after-restart': true, 'update-all': true },
  phase: { phase: 'available', version: '0.1.37-owl.20261013.1', problem: null }, checkedAt: 1 }
function provideApp(update: UpdateStatus, resume = true) {
  const actions = { downloadUpdate: vi.fn(async () => true), installUpdate: vi.fn(async () => true) }
  vi.mocked(useOptionalApp).mockReturnValue({ update, settings: { resumeThreadsAfterRestart: resume }, actions } as unknown as AppContextValue)
  return actions
}
function provideAgents(state: AgentState) {
  const command = vi.fn(async () => state)
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, command))
  return command
}
afterEach(() => { cleanup(); vi.clearAllMocks(); document.documentElement.style.removeProperty('--tt-corner-inset') })

describe('the Update all card', () => {
  it('says nothing when everything is current', () => {
    provideApp({ ...available, phase: { phase: 'up-to-date' } })
    provideAgents(agentState())
    const { container } = render(<UpdateAllCard hosts={hostsBridge({ hosts: [], localHostEnabled: true, localHostRunning: true }).asBridge} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('updates Sotto, this computer’s clients and a host’s clients at once, and the host itself once its clients are done', async () => {
    const actions = provideApp(available)
    const command = provideAgents(agentState({ local: [behind()], forge: [behind({ id: 'codex', installed: '0.51.0', published: '0.52.1' })] }))
    const hosts = hostsBridge({ hosts: [forge], localHostEnabled: true, localHostRunning: true, updates: [hostUpdate()] })
    const view = render(<UpdateAllCard hosts={hosts.asBridge} />)
    await screen.findByText('forge')
    expect(screen.getByRole('region', { name: 'Updates' })).toBeTruthy()
    expect(screen.getByText('Sotto, 2 clients and forge')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Update all: Sotto, 2 clients and forge' }))
    await waitFor(() => expect(actions.downloadUpdate).toHaveBeenCalledTimes(1))
    expect(command).toHaveBeenCalledWith({ type: 'queue-client-updates', providers: ['claude'] })
    expect(hosts.bridge.updateClients).toHaveBeenCalledWith({ id: FORGE, action: 'update', providers: ['codex'] })
    expect(hosts.bridge.command).not.toHaveBeenCalled()
    expect(screen.getByText('Updates once forge’s clients have.')).toBeTruthy()
    // forge's client goes through its line and finishes; then, and only then, forge's own update starts.
    provideAgents(agentState({ local: [behind({ state: 'updating' })], forge: [behind({ id: 'codex', state: 'updating' })] }))
    view.rerender(<UpdateAllCard hosts={hosts.asBridge} />)
    expect(hosts.bridge.command).not.toHaveBeenCalled()
    provideAgents(agentState({ local: [behind({ state: 'updating' })], forge: [behind({ id: 'codex', installed: '0.52.1', behind: false, state: 'updated', ranAt: 'now' })] }))
    view.rerender(<UpdateAllCard hosts={hosts.asBridge} />)
    await waitFor(() => expect(hosts.bridge.command).toHaveBeenCalledWith({ type: 'host-update', id: FORGE, action: 'update' }))
  })

  it('answers a host’s busy question with Update when they finish', async () => {
    provideApp({ ...available, phase: { phase: 'unsupported' } })
    provideAgents(agentState())
    const hosts = hostsBridge({ hosts: [forge], localHostEnabled: true, localHostRunning: true, updates: [hostUpdate({ working: 1 })] })
    hosts.bridge.command.mockResolvedValueOnce({ hosts: [forge], localHostEnabled: true, localHostRunning: true, updates: [hostUpdate({ working: 1, phase: 'confirm' })] })
    render(<UpdateAllCard hosts={hosts.asBridge} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Update all/u }))
    await waitFor(() => expect(hosts.bridge.command).toHaveBeenCalledWith({ type: 'host-update', id: FORGE, action: 'when-idle' }))
  })

  it('asks to restart once Sotto is downloaded, says working threads carry on, and installs on Restart now', async () => {
    const actions = provideApp({ ...available, phase: { phase: 'downloaded', version: '0.1.37-owl.20261013.1', problem: null } })
    provideAgents(agentState({ working: true }))
    render(<UpdateAllCard hosts={hostsBridge({ hosts: [], localHostEnabled: true, localHostRunning: true }).asBridge} />)
    expect(screen.getByText('Restart to finish')).toBeTruthy()
    expect(screen.getByText('1 thread on this computer is working. It stops for the restart and carries on after it.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restart Sotto now and install 0.1.37-owl.20261013.1' }))
    await waitFor(() => expect(actions.installUpdate).toHaveBeenCalledTimes(1))
  })

  it('folds into a pill and back, keeping focus on the control that is shown', async () => {
    provideApp(available)
    provideAgents(agentState())
    render(<UpdateAllCard hosts={hostsBridge({ hosts: [], localHostEnabled: true, localHostRunning: true }).asBridge} />)
    const fold = screen.getByRole('button', { name: 'Fold updates into a button' })
    fold.focus(); fireEvent.click(fold)
    const pill = screen.getByRole('button', { name: 'Update all. Show updates' })
    await waitFor(() => expect(document.activeElement).toBe(pill))
    fireEvent.click(pill)
    expect(screen.getByRole('region', { name: 'Updates' })).toBeTruthy()
  })

  it('stays away after Not now until something new is published', () => {
    provideApp(available)
    provideAgents(agentState())
    const hosts = hostsBridge({ hosts: [], localHostEnabled: true, localHostRunning: true })
    const view = render(<UpdateAllCard hosts={hosts.asBridge} />)
    fireEvent.click(screen.getByRole('button', { name: 'Not now: hide these updates until something new is published' }))
    expect(view.container).toBeEmptyDOMElement()
    provideApp({ ...available, phase: { phase: 'available', version: '0.1.37-owl.20261014.1', problem: null } })
    view.rerender(<UpdateAllCard hosts={hosts.asBridge} />)
    expect(screen.getByRole('region', { name: 'Updates' })).toBeTruthy()
  })

  it('updates this computer’s clients by name, from its own entry, while a remote host is selected', async () => {
    const LOCAL = '9c1f4b2e-7a3d-4e5f-8b6a-0d2c4e6f8a1b'
    provideApp({ ...available, phase: { phase: 'unsupported' } })
    const state = agentState()
    const command = provideAgents({ ...state, clientUpdates: undefined, connections: [{ hostId: LOCAL, name: 'This computer', kind: 'local', connected: true }],
      host: { ...state.host, clientHosts: [{ hostId: LOCAL, connected: true, models: [], capabilities: caps, clientUpdates: [behind()] }] } })
    render(<UpdateAllCard hosts={hostsBridge({ hosts: [], localHostEnabled: true, localHostRunning: true }).asBridge} />)
    expect(screen.getByRole('region', { name: 'This computer' })).toHaveTextContent('Claude Code')
    fireEvent.click(screen.getByRole('button', { name: 'Update all: 1 client' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'queue-client-updates', providers: ['claude'], hostId: LOCAL }))
  })

  it('cancels a host’s waiting update, keeping focus in the card', async () => {
    provideApp({ ...available, phase: { phase: 'unsupported' } })
    provideAgents(agentState())
    const hosts = hostsBridge({ hosts: [forge], localHostEnabled: true, localHostRunning: true, updates: [hostUpdate({ phase: 'waiting', working: 2 })] })
    render(<UpdateAllCard hosts={hosts.asBridge} />)
    const cancel = await screen.findByRole('button', { name: 'Cancel update, and leave forge on 0.1.35' })
    cancel.focus(); fireEvent.click(cancel)
    await waitFor(() => expect(hosts.bridge.command).toHaveBeenCalledWith({ type: 'host-update', id: FORGE, action: 'cancel' }))
    expect(screen.getByRole('button', { name: 'Stop 2 threads on forge and update its host now' })).toBeTruthy()
  })

  it('tries a failed Sotto download again when Settings asks, as its Download did (Sotto Bug Bot)', async () => {
    const actions = provideApp(available)
    actions.downloadUpdate.mockResolvedValueOnce(false)
    provideAgents(agentState())
    render(<UpdateAllCard hosts={hostsBridge({ hosts: [], localHostEnabled: true, localHostRunning: true }).asBridge} />)
    fireEvent.click(screen.getByRole('button', { name: /^Update all/u }))
    await screen.findByText('The download did not finish. Nothing was installed. Try again.')
    act(() => requestUpdateAll())
    await waitFor(() => expect(actions.downloadUpdate).toHaveBeenCalledTimes(2))
  })

  it('runs the same press when Settings asks for it', async () => {
    const actions = provideApp(available)
    provideAgents(agentState())
    render(<UpdateAllCard hosts={hostsBridge({ hosts: [], localHostEnabled: true, localHostRunning: true }).asBridge} />)
    act(() => requestUpdateAll())
    await waitFor(() => expect(actions.downloadUpdate).toHaveBeenCalledTimes(1))
  })
})
