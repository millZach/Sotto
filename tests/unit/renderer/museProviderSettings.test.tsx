import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, type AgentCommand, type AgentState, type ProviderClientUpdate } from '../../../src/shared/agents'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ProvidersSettings } from '../../../src/renderer/src/agents/ProvidersSettings'
import { AppProvider } from '../../../src/renderer/src/state/AppContext'
import { threadsStateFixture } from '../../fixtures/agentState'
import { agentContextFixture } from '../../fixtures/agentContext'
import { deferred } from '../../fixtures/deferred'
import { createBridge, createController } from '../../fixtures/renderer/appHarness'

vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))

const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
function fixture(update: Partial<ProviderClientUpdate> = {}): AgentState {
  return threadsStateFixture({
    configuration: { ...defaultAgentConfiguration(), enabledProviders: ['codex', 'muse'] },
    host: { connected: true, name: 'Providers', version: '', capabilities, projects: [], threads: [],
      providers: [{ id: 'codex', name: 'Codex', version: '0.155.1', connection: 'connected', capabilities },
        { id: 'muse', name: 'Muse', version: '1.4.6', connection: 'connected', capabilities }],
      models: [{ id: 'muse:spark', name: 'Muse Spark', provider: 'Muse', providerId: 'muse', ready: true },
        { id: 'codex:other', name: 'Codex model', provider: 'Codex', providerId: 'codex', ready: true }],
    },
    topLevel: { clientUpdates: [{ id: 'muse', installed: '1.4.6', published: '1.4.7-R6101.1', behind: true,
      channel: 'self-update', canInstall: true, checkedAt: new Date().toISOString(), state: 'idle', ...update }] },
  })
}
async function mount(state = fixture()) {
  const command = vi.fn<(command: AgentCommand) => Promise<AgentState | null>>().mockResolvedValue(state)
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, command))
  const view = render(<AppProvider bridge={createBridge({ getUpdateStatus: async () => ({ currentVersion: '0.1.37-owl.20261012.1', releaseTrack: 'owl', owlFeatures: { watcher: false, muse: true }, phase: { phase: 'unsupported' }, checkedAt: null }) as never })} createController={createController}><ProvidersSettings /></AppProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Muse' }))
  return { ...view, state, command }
}
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('Muse in provider settings', () => {
  it('copies only the terminal login command and opens the maker sign-in guide', async () => {
    const deliverOutput = vi.fn(async () => 'copied' as const)
    const openExternalLink = vi.fn(async () => ({ ok: true as const }))
    vi.stubGlobal('sotto', { deliverOutput, openExternalLink })
    const { command } = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Copy Muse login command' }))
    await waitFor(() => expect(deliverOutput).toHaveBeenCalledWith({ text: 'muse login', autoPaste: false, pasteDelayMs: 50 }))
    await screen.findByText('Muse login command copied.')
    fireEvent.click(screen.getByRole('button', { name: 'Sign-in steps' }))
    await waitFor(() => expect(openExternalLink).toHaveBeenCalledWith('https://dev.meta.ai/docs/muse-code'))
    expect(command).not.toHaveBeenCalled()
  })

  it('keeps the command selectable when copying fails', async () => {
    vi.stubGlobal('sotto', { deliverOutput: vi.fn(async () => 'clipboard-unavailable' as const) })
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Copy Muse login command' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The command could not be copied. Select muse login and copy it yourself.')
    expect(screen.getByText('muse login', { selector: 'code' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Copy Muse login command' })).toBeEnabled()
  })

  it('names the native release feed and discloses the available thread features', async () => {
    await mount()
    expect(screen.getByText(/Muse uses its own release feed; the other clients use the npm registry/)).toBeVisible()
    const support = screen.getByText('Threads with Muse').closest('details')!
    fireEvent.click(within(support).getByText('Threads with Muse'))
    expect(within(support).getByText(/Muse threads get Sotto's browser, visual, pull request babysitting and delegation tools\. Watcher runs on Muse 1\.4\.7 or newer\. Skills are unavailable\./)).toBeInTheDocument()
    expect(within(support).queryByText(/browser tools, Watcher and skills are unavailable/)).toBeNull()
    expect(within(support).getByText(/Muse does not write thread titles, branch names, commit messages or pull request drafts/)).toBeInTheDocument()
    const models = screen.getByRole('tab', { name: 'Models' })
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Configuration' }), { key: 'ArrowRight' })
    expect(models).toHaveFocus()
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Muse Spark')
    expect(screen.getByRole('tabpanel')).not.toHaveTextContent('Codex model')
  })

  it('keeps the client controls pending until an update finishes, then allows a retry after rejection', async () => {
    const { state, command } = await mount()
    const update = deferred<AgentState>()
    command.mockImplementationOnce(() => update.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Update Muse' }))
    expect(screen.getByRole('button', { name: 'Update Muse' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Refresh Muse' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Enable Muse' })).toBeDisabled()
    expect(screen.getByText('Starting the update…')).toBeVisible()
    await act(async () => { update.reject(new Error('lost command')); await update.promise.catch(() => undefined) })
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not update Muse. Try again.')
    expect(screen.getByRole('button', { name: 'Update Muse' })).toBeEnabled()
    command.mockResolvedValueOnce(state)
    fireEvent.click(screen.getByRole('button', { name: 'Update Muse' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(command).toHaveBeenNthCalledWith(2, { type: 'update-client', provider: 'muse' })
  })

  it('clears a failed check on the next press and restores its controls for a missing result', async () => {
    const { command } = await mount()
    const check = deferred<AgentState | null>()
    command.mockImplementationOnce(() => check.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Update Muse' })).toBeDisabled()
    await act(async () => { check.resolve(null); await check.promise })
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check for client updates. Try again.')
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled()
    expect(command).toHaveBeenNthCalledWith(2, { type: 'check-client-updates' })
  })

  it.each([
    [{ published: undefined, behind: false, canInstall: false }, /Sotto could not read the published version/],
    [{ state: 'queued' as const }, /Waiting to update to 1.4.7-R6101.1/],
    [{ state: 'updating' as const }, /Updating to 1.4.7-R6101.1/],
    [{ state: 'updated' as const, installed: '1.4.7', behind: false, canInstall: false }, /1.4.7 is installed; 1.4.7-R6101.1 is published/],
  ])('reports native version state %j without naming the npm registry', async (update, line) => {
    const { container } = await mount(fixture(update))
    expect(within(container.querySelector('.provider-client')!).getByText(line)).toBeVisible()
    expect(container.querySelector('.provider-client')).not.toHaveTextContent('registry')
  })

  it('keeps an unknown installation manual and exposes only the commands the host supplies', async () => {
    await mount(fixture({ canInstall: false, channel: 'mise', command: 'mise upgrade muse', byHand: ['mise upgrade muse'] }))
    expect(screen.queryByRole('button', { name: 'Update Muse' })).toBeNull()
    const steps = screen.getByText('Installation steps').closest('details')!
    fireEvent.click(within(steps).getByText('Installation steps'))
    expect(within(steps).getByText('mise upgrade muse', { selector: 'code' })).toBeInTheDocument()
    expect(within(steps).getByRole('button', { name: 'Open Muse installation guide' })).toBeInTheDocument()
  })

  it('saves the shell sandbox switch through configure, starting from on', async () => {
    const { command } = await mount()
    const sandbox = screen.getByRole('switch', { name: 'Shell sandbox' })
    expect(sandbox).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(sandbox)
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure', patch: { museDisableSandbox: true } }))
  })

  it('says so when the shell sandbox switch was not saved', async () => {
    const { command, state } = await mount()
    command.mockResolvedValueOnce({ ...state, error: 'This action is not allowed from this device. Check its permission policy or complete the action on the host.' })
    fireEvent.click(screen.getByRole('switch', { name: 'Shell sandbox' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This action is not allowed from this device.')
    command.mockRejectedValueOnce(new Error('lost'))
    fireEvent.click(screen.getByRole('switch', { name: 'Shell sandbox' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The shell sandbox setting was not saved, so Muse keeps the one it had. Try again.')
  })

  it('offers reconnect only while the saved sandbox switch and the running hosts disagree', async () => {
    const state = fixture()
    state.configuration.museDisableSandbox = true
    state.host.providers = state.host.providers!.map(provider => provider.id === 'muse' ? { ...provider, sandboxDisabled: false } : provider)
    const { command } = await mount(state)
    expect(screen.getByText(/Reconnect Muse to apply the change/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect Muse to apply the shell sandbox setting' }))
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2))
    expect(command).toHaveBeenNthCalledWith(1, { type: 'disconnect', provider: 'muse' })
    expect(command).toHaveBeenNthCalledWith(2, { type: 'connect', provider: 'muse', notice: false })
  })

  it('reads and changes this computer’s shell sandbox when another host is selected for new work', async () => {
    const LOCAL = '00000000-0000-4000-8000-000000000001', FORGE = '00000000-0000-4000-8000-000000000002'
    const base = fixture()
    // The selected host's own saved switch is on and its Muse is sandboxed; this computer's is off and still running sandboxed.
    const here = base.host.providers!.map(provider => provider.id === 'muse' ? { ...provider, sandboxDisabled: false } : provider)
    const state: AgentState = { ...base, hostId: FORGE, connections: [{ hostId: LOCAL, name: 'This computer', kind: 'local', connected: true }, { hostId: FORGE, name: 'forge', kind: 'remote', connected: true }],
      host: { ...base.host, clientHosts: [
        { hostId: LOCAL, connected: true, models: base.host.models, capabilities, providers: here, enabledProviders: ['codex', 'muse'], checkClientUpdates: true, museDisableSandbox: true },
        { hostId: FORGE, connected: true, models: [], capabilities, providers: [] },
      ] } }
    const { command } = await mount(state)
    const sandbox = screen.getByRole('switch', { name: 'Shell sandbox' })
    expect(sandbox).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/Muse is still running with its sandbox on/)).toBeVisible()
    fireEvent.click(sandbox)
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'configure', patch: { museDisableSandbox: false }, hostId: LOCAL }))
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect Muse to apply the shell sandbox setting' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith({ type: 'connect', provider: 'muse', hostId: LOCAL, notice: false }))
    expect(command).toHaveBeenCalledWith({ type: 'disconnect', provider: 'muse', hostId: LOCAL })
  })

  it('offers no update when the check switch is off', async () => {
    const state = fixture()
    state.configuration.checkClientUpdates = false
    const { command } = await mount(state)
    expect(screen.getByRole('button', { name: 'Check again' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Update Muse' })).toBeNull()
    expect(screen.getByText(/Client update checks are off/)).toBeVisible()
    expect(command).not.toHaveBeenCalled()
  })
})
