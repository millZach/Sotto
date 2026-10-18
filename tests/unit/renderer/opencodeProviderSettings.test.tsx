import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, type AgentCommand, type AgentState } from '../../../src/shared/agents'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ProvidersSettings } from '../../../src/renderer/src/agents/ProvidersSettings'
import { AppProvider } from '../../../src/renderer/src/state/AppContext'
import { threadsStateFixture } from '../../fixtures/agentState'
import { agentContextFixture } from '../../fixtures/agentContext'
import { createBridge, createController } from '../../fixtures/renderer/appHarness'

vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))

const capabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
function fixture(): AgentState {
  return threadsStateFixture({
    configuration: { ...defaultAgentConfiguration(), enabledProviders: ['codex', 'opencode'] },
    host: { connected: true, name: 'Providers', version: '', capabilities, projects: [], threads: [],
      providers: [{ id: 'codex', name: 'Codex', version: '0.155.1', connection: 'connected', capabilities },
        { id: 'opencode', name: 'OpenCode', version: '2.0.31', connection: 'connected', capabilities, account: 'No model source signed in yet; OpenCode Zen’s free models only' }],
      models: [{ id: 'opencode:opencode/big-pickle', name: 'Big Pickle', provider: 'OpenCode', providerId: 'opencode', source: 'OpenCode Zen', ready: true }],
    },
  })
}
async function mount(opencode: boolean, change: (state: AgentState) => void = () => undefined) {
  const state = fixture()
  change(state)
  const command = vi.fn<(command: AgentCommand) => Promise<AgentState | null>>().mockResolvedValue(state)
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, command))
  render(<AppProvider bridge={createBridge({ getUpdateStatus: async () => ({ currentVersion: '0.1.37-owl.20261016.1', releaseTrack: 'owl', owlFeatures: { watcher: false, opencode }, phase: { phase: 'unsupported' }, checkedAt: null }) as never })} createController={createController}><ProvidersSettings /></AppProvider>)
  await screen.findByRole('button', { name: 'Codex' })
}
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('OpenCode in provider settings', () => {
  it('offers OpenCode under its own mark in Owl, says it runs its own OpenCode, and shows its Model sources', async () => {
    vi.stubGlobal('sotto', { ...window.sotto, opencode: { sources: vi.fn(async () => ({ status: 'ok', zenModels: 12, sources: [] })) } })
    await mount(true)
    const button = await screen.findByRole('button', { name: 'OpenCode' })
    expect(button.querySelector('svg.provider-mark[data-provider="opencode"] path')?.getAttribute('d')).toBe('M24 8H8V32H24V8ZM32 40H0V0H32V40Z')
    fireEvent.click(button)
    expect(screen.getByText('Sotto runs its own OpenCode, with its own folder and its own sign-ins. The OpenCode you run yourself stays as it is.')).toBeVisible()
    const sources = screen.getByRole('group', { name: 'Model sources' })
    expect(await within(sources).findByText('12 models')).toBeVisible()
    // Model sources sit between Local connection and Installed client.
    const connection = screen.getByRole('heading', { name: 'Local connection' }), installed = screen.getByRole('heading', { name: 'Installed client' })
    expect(connection.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(sources.compareDocumentPosition(installed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows OpenCode’s installed and published versions and its update like any other client', async () => {
    await mount(true, state => {
      state.clientUpdates = [{ id: 'opencode', installed: '2.0.31', published: '2.0.40', behind: true, channel: 'self-update', command: 'opencode upgrade', byHand: ['opencode upgrade'], canInstall: true, checkedAt: '2026-10-16T12:00:00.000Z', state: 'idle' }]
    })
    fireEvent.click(await screen.findByRole('button', { name: 'OpenCode' }))
    expect(screen.getByText('2.0.31 is installed; 2.0.40 is published. Your threads keep working while it installs.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled()
    expect(screen.queryByText(/cannot update OpenCode yet/u)).toBeNull()
  })

  it('names the command a package manager updates OpenCode with, and the OpenCode 2 guide', async () => {
    await mount(true, state => {
      state.clientUpdates = [{ id: 'opencode', installed: '2.0.31', published: '2.0.40', behind: true, channel: 'unknown', command: 'brew upgrade opencode-v2', byHand: ['brew upgrade opencode-v2'], canInstall: false, checkedAt: '2026-10-16T12:00:00.000Z', state: 'idle' }]
    })
    fireEvent.click(await screen.findByRole('button', { name: 'OpenCode' }))
    expect(screen.getByText('2.0.31 is installed; 2.0.40 is published. Sotto cannot update this copy. Update it with brew upgrade opencode-v2.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
    fireEvent.click(screen.getByText('Installation steps'))
    expect(screen.getByText('brew upgrade opencode-v2', { selector: 'code' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Open OpenCode installation guide' })).toBeVisible()
  })

  it.each([
    ['missing', { problem: 'not-installed' as const, version: '', error: 'Could not connect OpenCode. Install OpenCode 2, then connect again. Your threads and drafts are kept.' },
      'OpenCode 2 is not installed on this computer. Install it with its install script or npm’s @opencode/cli, then connect again.'],
    ['refused for its version', { problem: 'too-old' as const, version: '1.19.3', requiredVersion: '2.0.31', error: 'Could not connect OpenCode. This is OpenCode 1.19.3, and Sotto works with OpenCode 2 only.' },
      // Sotto looks in ~/.opencode/bin first, where OpenCode 1's install script put it too, so only OpenCode 2's script replaces it.
      'Sotto works with OpenCode 2.0.31 or newer. Install OpenCode 2 with its install script, which replaces an older copy in ~/.opencode/bin, where Sotto looks first, then connect again. npm’s @opencode/cli installs a second copy and leaves that one.'],
  ])('offers OpenCode 2’s install guide when OpenCode is %s, with no update to show', async (_kind, problem, words) => {
    const openExternalLink = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('sotto', { ...window.sotto, openExternalLink })
    await mount(true, state => {
      state.configuration = { ...state.configuration, checkClientUpdates: false }
      const opencode = state.host.providers!.find(provider => provider.id === 'opencode')!
      Object.assign(opencode, { connection: 'error', account: undefined, ...problem })
      state.clientUpdates = []
    })
    fireEvent.click(await screen.findByRole('button', { name: 'OpenCode' }))
    fireEvent.click(screen.getByText('Installation steps'))
    expect(screen.getByText(words)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Open OpenCode installation guide' }))
    expect(openExternalLink).toHaveBeenCalledWith('https://opencode.ai/v2/docs/')
  })

  it('offers nothing of OpenCode while its Owl feature is off', async () => {
    await mount(false)
    expect(screen.queryByRole('button', { name: 'OpenCode' })).toBeNull()
  })
})
