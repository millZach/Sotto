import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
async function mount(opencode: boolean) {
  const state = fixture()
  const command = vi.fn<(command: AgentCommand) => Promise<AgentState | null>>().mockResolvedValue(state)
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, command))
  render(<AppProvider bridge={createBridge({ getUpdateStatus: async () => ({ currentVersion: '0.1.37-owl.20261016.1', releaseTrack: 'owl', owlFeatures: { watcher: false, opencode }, phase: { phase: 'unsupported' }, checkedAt: null }) as never })} createController={createController}><ProvidersSettings /></AppProvider>)
  await screen.findByRole('button', { name: 'Codex' })
}
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('OpenCode in provider settings', () => {
  it('offers OpenCode under its own mark in Owl, says its folder is Sotto’s own and that no model source is signed in yet', async () => {
    await mount(true)
    const button = await screen.findByRole('button', { name: 'OpenCode' })
    expect(button.querySelector('svg.provider-mark[data-provider="opencode"] path')?.getAttribute('d')).toBe('M24 8H8V32H24V8ZM32 40H0V0H32V40Z')
    fireEvent.click(button)
    expect(screen.getByText(/in a folder of Sotto’s own, apart from your own OpenCode/)).toBeVisible()
    expect(screen.getByText('No model source signed in yet; OpenCode Zen’s free models only.')).toBeVisible()
  })

  it('offers nothing of OpenCode while its Owl feature is off', async () => {
    await mount(false)
    expect(screen.queryByRole('button', { name: 'OpenCode' })).toBeNull()
  })
})
