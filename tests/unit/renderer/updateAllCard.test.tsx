import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  it('queues this computer and every connected host in the same press', async () => {
    provideApp({ ...available, phase: { phase: 'unsupported' } })
    const mac = { ...forge, id: 'e1a50660-4f27-47bb-b4dd-1443a3f46a62', hostId: '36e5e84a-0304-4c25-b141-6915c65e31df', name: 'Mac' }
    const state = agentState({ local: [behind()], forge: [behind({ id: 'codex' }), behind({ id: 'grok' })] })
    const command = provideAgents({ ...state, host: { ...state.host, clientHosts: [
      ...state.host.clientHosts ?? [], { ...state.host.clientHosts![0]!, hostId: mac.hostId },
    ] } })
    const hosts = hostsBridge({ hosts: [forge, mac], localHostEnabled: true, localHostRunning: true })
    render(<UpdateAllCard hosts={hosts.asBridge} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Update all/u }))
    await waitFor(() => expect(hosts.bridge.updateClients).toHaveBeenCalledTimes(2))
    expect(command).toHaveBeenCalledWith({ type: 'queue-client-updates', providers: ['claude'] })
    expect(hosts.bridge.updateClients).toHaveBeenCalledWith({ id: FORGE, action: 'update', providers: ['codex', 'grok'] })
    expect(hosts.bridge.updateClients).toHaveBeenCalledWith({ id: mac.id, action: 'update', providers: ['codex', 'grok'] })
    expect(hosts.bridge.command).not.toHaveBeenCalled()
  })

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
    await screen.findByRole('listitem', { name: 'Update forge’s host, to do' })
    expect(screen.getByRole('region', { name: 'Updates' })).toBeTruthy()
    // Sotto's versions are said once, in the head; the button says what one press updates.
    expect(screen.getByText('0.1.37-owl.20261012.1 → 0.1.37-owl.20261013.1')).toBeTruthy()
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

  // The incident of October 16, 2026: forge restarted with Codex in its line, and the step spun on Starting… for good.
  it('says a host client whose line was lost did not update, and Try again puts it back in the line', async () => {
    provideApp({ ...available, phase: { phase: 'unsupported' } })
    const codex = (patch: Partial<ProviderClientUpdate> = {}) => behind({ id: 'codex', installed: '0.51.0', published: '0.52.1', ranAt: 'earlier', ...patch })
    provideAgents(agentState({ forge: [codex()] }))
    const hosts = hostsBridge({ hosts: [forge], localHostEnabled: true, localHostRunning: true })
    const view = render(<UpdateAllCard hosts={hosts.asBridge} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Update all: 1 client' }))
    await waitFor(() => expect(hosts.bridge.updateClients).toHaveBeenCalledWith({ id: FORGE, action: 'update', providers: ['codex'] }))
    expect(screen.getByRole('listitem', { name: 'Update Codex, in progress' })).toHaveTextContent('Starting…')
    provideAgents(agentState({ forge: [codex({ state: 'updating' })] }))
    view.rerender(<UpdateAllCard hosts={hosts.asBridge} />)
    // forge restarts: it is out of reach for a moment, and the step waits to hear from it.
    const away = agentState({ forge: [codex({ state: 'updating' })] })
    provideAgents({ ...away, host: { ...away.host, clientHosts: away.host.clientHosts!.map(entry => ({ ...entry, connected: false })) } })
    view.rerender(<UpdateAllCard hosts={hosts.asBridge} />)
    expect(await screen.findByRole('listitem', { name: 'Update Codex, in progress' })).toHaveTextContent('Waiting to hear from forge…')
    // The new host process has Codex idle again, with no result in memory.
    provideAgents(agentState({ forge: [codex({ ranAt: undefined })] }))
    view.rerender(<UpdateAllCard hosts={hosts.asBridge} />)
    const step = await screen.findByRole('listitem', { name: 'Update Codex, did not finish' })
    expect(step).toHaveTextContent('forge restarted before Codex updated. Nothing was changed. Try again.')
    fireEvent.click(within(step).getByRole('button', { name: 'Try again to update Codex on forge' }))
    await waitFor(() => expect(hosts.bridge.updateClients).toHaveBeenCalledTimes(2))
    expect(hosts.bridge.updateClients).toHaveBeenLastCalledWith({ id: FORGE, action: 'update', providers: ['codex'] })
    // Before forge says Codex is back in its line, the step is starting, not lost again.
    expect(await screen.findByRole('listitem', { name: 'Update Codex, in progress' })).toHaveTextContent('Starting…')
    provideAgents(agentState({ forge: [codex({ state: 'queued' })] }))
    view.rerender(<UpdateAllCard hosts={hosts.asBridge} />)
    provideAgents(agentState({ forge: [codex({ state: 'updated', installed: '0.52.1', behind: false, ranAt: 'now' })] }))
    view.rerender(<UpdateAllCard hosts={hosts.asBridge} />)
    expect(await screen.findByRole('listitem', { name: 'Update Codex, done' })).toHaveTextContent('Now 0.52.1.')
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
    expect(screen.getByRole('listitem', { name: 'Restart Sotto, ready' })).toHaveTextContent('Installs 0.1.37-owl.20261013.1. 1 working thread here stops and resumes after.')
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
    expect(screen.getByRole('listitem', { name: 'Update Claude Code, to do' })).toHaveTextContent('This computer')
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
    await screen.findByText('This computer · The download did not finish. Nothing was installed. Try again.')
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

  it('covers a host the releases page is still being asked about with one press, and offers the restart only after its update (Sol, review)', async () => {
    const actions = provideApp(available)
    provideAgents(agentState())
    const onOwl = { ...forge, version: '0.1.37-owl.20261012.1' } as HostStatus
    const base: HostsState = { hosts: [onOwl], localHostEnabled: true, localHostRunning: true }
    const hosts = hostsBridge({ ...base, updateChecks: [FORGE] })
    const view = render(<UpdateAllCard hosts={hosts.asBridge} />)
    expect(await screen.findByRole('listitem', { name: 'Update forge’s host, checking for its update' })).toHaveTextContent('Checking the releases page for its update…')
    // Pressed before the answer: Sotto downloads, and forge is not started yet, so it is aimed at what the answer says.
    fireEvent.click(screen.getByRole('button', { name: 'Update all: Sotto and forge' }))
    await waitFor(() => expect(actions.downloadUpdate).toHaveBeenCalledTimes(1))
    expect(hosts.bridge.command).not.toHaveBeenCalled()
    // Sotto's download finishes first: the press still runs, and nothing offers the restart.
    provideApp({ ...available, phase: { phase: 'downloaded', version: '0.1.37-owl.20261013.1', problem: null } })
    view.rerender(<UpdateAllCard hosts={hosts.asBridge} />)
    expect(screen.getByText('Updating')).toBeTruthy()
    expect(screen.getByText('1 of 3 done')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Restart Sotto now/u })).toBeNull()
    // The releases page has forge's host: it joins the press, and still no restart until its update is done.
    const offer = hostUpdate({ from: '0.1.37-owl.20261012.1', to: '0.1.37-owl.20261013.1' })
    hosts.change({ ...base, updates: [offer] })
    await waitFor(() => expect(hosts.bridge.command).toHaveBeenCalledWith({ type: 'host-update', id: FORGE, action: 'update' }))
    expect(hosts.bridge.command).toHaveBeenCalledTimes(1)
    hosts.change({ ...base, updates: [{ ...offer, phase: 'updating', step: 'download' }] })
    expect(screen.getByRole('listitem', { name: 'Update forge’s host, in progress' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Restart Sotto now/u })).toBeNull()
    hosts.change({ ...base, hosts: [{ ...onOwl, version: offer.to }], updates: [{ ...offer, phase: 'done', from: offer.to }] })
    expect(await screen.findByRole('button', { name: 'Restart Sotto now and install 0.1.37-owl.20261013.1' })).toBeTruthy()
    expect(screen.getByRole('listitem', { name: 'Update forge’s host, done' })).toBeTruthy()
  })

  it('starts a host once when its clients finish as its check ends, in the same change (review)', async () => {
    provideApp({ ...available, phase: { phase: 'downloaded', version: '0.1.37-owl.20261013.1', problem: null } })
    provideAgents(agentState({ forge: [behind({ id: 'codex', installed: '0.51.0', published: '0.52.1' })] }))
    const offer = hostUpdate({ from: '0.1.35', to: '0.1.37' })
    const base: HostsState = { hosts: [forge], localHostEnabled: true, localHostRunning: true, updates: [offer] }
    const hosts = hostsBridge(base)
    const view = render(<UpdateAllCard hosts={hosts.asBridge} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Update all: 1 client and forge' }))
    await waitFor(() => expect(hosts.bridge.updateClients).toHaveBeenCalledTimes(1))
    // The releases page is asked about forge again while its client updates, so the press waits for that answer too.
    hosts.change({ ...base, updateChecks: [FORGE] })
    expect(screen.getByRole('listitem', { name: 'Update forge’s host, checking for its update' })).toBeTruthy()
    provideAgents(agentState({ forge: [behind({ id: 'codex', state: 'updating' })] }))
    view.rerender(<UpdateAllCard hosts={hosts.asBridge} />)
    // The client finishes as the answer comes: forge is started once.
    provideAgents(agentState({ forge: [behind({ id: 'codex', installed: '0.52.1', behind: false, state: 'updated', ranAt: 'now' })] }))
    view.rerender(<UpdateAllCard hosts={hosts.asBridge} />)
    hosts.change(base)
    await waitFor(() => expect(hosts.bridge.command).toHaveBeenCalledWith({ type: 'host-update', id: FORGE, action: 'update' }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(hosts.bridge.command).toHaveBeenCalledTimes(1)
  })

  it('lets a host leave the press when the releases page has nothing for it, and then asks to restart', async () => {
    provideApp({ ...available, phase: { phase: 'downloaded', version: '0.1.37-owl.20261013.1', problem: null } })
    provideAgents(agentState())
    const base: HostsState = { hosts: [forge], localHostEnabled: true, localHostRunning: true }
    const hosts = hostsBridge({ ...base, updateChecks: [FORGE] })
    render(<UpdateAllCard hosts={hosts.asBridge} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Update all: forge' }))
    expect(await screen.findByText('Updating')).toBeTruthy()
    hosts.change(base)
    expect(await screen.findByRole('button', { name: 'Restart Sotto now and install 0.1.37-owl.20261013.1' })).toBeTruthy()
    expect(screen.queryByRole('listitem', { name: /forge’s host/u })).toBeNull()
    expect(hosts.bridge.command).not.toHaveBeenCalled()
  })

  it('lists the press as ordered steps, each named with how it stands, in the order the press runs them (ADR-0077, layout C)', async () => {
    provideApp(available)
    provideAgents(agentState({ local: [behind({ id: 'codex', installed: '0.47.2', published: '0.48.0' })], forge: [behind({ installed: '2.4.0', published: '2.4.1' })] }))
    const hosts = hostsBridge({ hosts: [forge], localHostEnabled: true, localHostRunning: true, updates: [hostUpdate({ from: '0.1.37-owl.20261012.1', to: '0.1.37-owl.20261013.1' })] })
    render(<UpdateAllCard hosts={hosts.asBridge} />)
    const list = await screen.findByRole('list', { name: 'Steps, in order' })
    expect(list.tagName).toBe('OL')
    const steps = within(list).getAllByRole('listitem')
    expect(steps.map(step => step.getAttribute('aria-label'))).toEqual([
      'Download Sotto Owl, to do', 'Update Codex, to do', 'Update Claude Code, to do', 'Update forge’s host, to do', 'Restart Sotto, comes last',
    ])
    expect(steps[1]).toHaveTextContent('0.47.2 → 0.48.0')
    // Its versions and sentence describe it, for a reader that announces only the name.
    expect(steps[1]).toHaveAccessibleDescription('0.47.2 → 0.48.0 This computer')
    expect(steps[3]).toHaveAccessibleDescription('Restarts forge’s host, so its threads are unavailable for a few seconds.')
    expect(steps[2]).toHaveTextContent('forge')
    // The host's sentence is its step's alone, and the rail between the marks has nothing to read.
    expect(screen.getAllByText('Restarts forge’s host, so its threads are unavailable for a few seconds.')).toHaveLength(1)
    expect(screen.queryByText(/restarts, so its threads/u)).toBeNull()
    expect(screen.getByText('Threads keep working while clients update.')).toBeTruthy()
    expect(steps.every(step => step.querySelector('.update-all__mark')!.getAttribute('aria-hidden') === 'true')).toBe(true)
  })
})

// The owner's choice, October 16, 2026: a run that ended with everything updated goes by itself 5 seconds later, and
// never while someone is pointing at it or has focus in it.
describe('a finished run going by itself', () => {
  const unsupported: UpdateStatus = { ...available, phase: { phase: 'unsupported' } }
  const settle = () => act(async () => { await Promise.resolve() })
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })
  const card = () => screen.queryByRole('region', { name: 'Updates' })
  afterEach(() => { vi.useRealTimers() })
  /** One press of Update all on this computer's Claude Code, which then ends as `ended` says. */
  async function run(ended: Partial<ProviderClientUpdate>, options: { app?: UpdateStatus; hosts?: HostsState } = {}) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    provideApp(options.app ?? unsupported)
    provideAgents(agentState({ local: [behind()] }))
    const hosts = hostsBridge(options.hosts ?? { hosts: [], localHostEnabled: true, localHostRunning: true })
    const view = render(<UpdateAllCard hosts={hosts.asBridge} doneMs={5_000} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: /^Update all/u }))
    await settle()
    provideAgents(agentState({ local: [behind({ ranAt: 'now', ...ended })] }))
    view.rerender(<UpdateAllCard hosts={hosts.asBridge} doneMs={5_000} />)
    await settle()
    return { hosts, view }
  }
  const updated = { installed: '2.1.42', behind: false, state: 'updated' } as const

  it('goes 5 seconds after everything updated, saying nothing as it goes', async () => {
    const { view } = await run(updated)
    expect(screen.getByText('Updated')).toBeTruthy()
    advance(4_999)
    expect(card()).not.toBeNull()
    advance(1)
    expect(view.container).toBeEmptyDOMElement()
    expect(document.querySelector('[role="status"], [role="alert"]')).toBeNull()
  })

  it('stays while something did not update, with its Try again', async () => {
    await run({ state: 'failed' })
    expect(screen.getByText('Not everything updated')).toBeTruthy()
    advance(60_000)
    expect(screen.getByRole('button', { name: 'Try again to update Claude Code' })).toBeTruthy()
  })

  it('stays while a host waits for its threads, and goes 5 seconds after that host has updated', async () => {
    const base: HostsState = { hosts: [forge], localHostEnabled: true, localHostRunning: true }
    const { hosts } = await run(updated, { hosts: { ...base, updates: [hostUpdate({ phase: 'waiting', working: 1 })] } })
    expect(screen.getByRole('listitem', { name: 'Update forge’s host, waiting for its threads' })).toBeTruthy()
    advance(60_000)
    expect(card()).not.toBeNull()
    // forge's thread finishes and its update runs: nothing is left waiting.
    hosts.change({ ...base, updates: [hostUpdate({ phase: 'done' })] })
    await settle()
    expect(screen.getByText('Updated')).toBeTruthy()
    advance(4_999)
    expect(card()).not.toBeNull()
    advance(1)
    expect(card()).toBeNull()
  })

  it('stays while the pointer is over it, and counts 5 whole seconds again once it leaves', async () => {
    await run(updated)
    advance(3_000)
    fireEvent.pointerEnter(card()!)
    advance(60_000)
    expect(card()).not.toBeNull()
    fireEvent.pointerLeave(card()!)
    advance(4_999)
    expect(card()).not.toBeNull()
    advance(1)
    expect(card()).toBeNull()
  })

  it('stays while focus is inside it, and counts 5 whole seconds again once it leaves', async () => {
    await run(updated)
    const dismiss = screen.getByRole('button', { name: 'Dismiss the results of Update all' })
    act(() => dismiss.focus())
    advance(60_000)
    expect(card()).not.toBeNull()
    // Another window taking focus blurs the button but leaves it focused here: it still holds the card.
    await act(async () => { fireEvent.blur(dismiss) })
    advance(60_000)
    expect(card()).not.toBeNull()
    await act(async () => { dismiss.blur() })
    advance(4_999)
    expect(card()).not.toBeNull()
    advance(1)
    expect(card()).toBeNull()
  })

  it('goes from its folded pill the same way, held while the pill has the pointer or focus', async () => {
    const { view } = await run(updated)
    fireEvent.click(screen.getByRole('button', { name: 'Fold updates into a button' }))
    const pill = screen.getByRole('button', { name: 'Updated. Show updates' })
    // Folding moved focus to the pill, which holds it.
    expect(document.activeElement).toBe(pill)
    advance(60_000)
    await act(async () => { pill.blur() })
    fireEvent.pointerEnter(pill)
    advance(60_000)
    expect(screen.getByRole('button', { name: 'Updated. Show updates' })).toBe(pill)
    fireEvent.pointerLeave(pill)
    advance(4_999)
    expect(view.container).not.toBeEmptyDOMElement()
    advance(1)
    expect(view.container).toBeEmptyDOMElement()
  })

  it('never goes by itself while it asks to restart', async () => {
    const downloaded: UpdateStatus = { ...available, phase: { phase: 'downloaded', version: '0.1.37-owl.20261013.1', problem: null } }
    await run(updated, { app: downloaded })
    expect(screen.getByText('Restart to finish')).toBeTruthy()
    advance(60_000)
    expect(screen.getByRole('button', { name: 'Restart Sotto now and install 0.1.37-owl.20261013.1' })).toBeTruthy()
  })
})
