import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, publicProviderEntityId, type AgentCommand, type AgentModel, type AgentState } from '../../../src/shared/agents'
import { DEFAULT_SETTINGS, type SettingsPatch } from '../../../src/shared/settings'
import type { WatcherIdentity } from '../../../src/shared/watcher'
import type { WatcherBridge, WatcherRoomResult, WatcherRoomState } from '../../../src/shared/watcherRoom'
import type { AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { pendingSettingsStore } from '../../../src/renderer/src/agents/pendingSettings'
import { WorkerRolesSettings } from '../../../src/renderer/src/features/settings/WorkerRolesSettings'
import { WatcherRoomProvider } from '../../../src/renderer/src/watcher/watcherRoom'
import { agentContextFixture } from '../../fixtures/agentContext'
import { threadsStateFixture } from '../../fixtures/agentState'

vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))

const HOST = '6c0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a10'
const at = new Date('2026-10-16T12:00:00Z').toISOString()
const caps = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
const MODES = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const
const FIVE = ['low', 'medium', 'high', 'xhigh', 'max']
const model = (provider: 'claude' | 'codex', native: string, name: string): AgentModel => ({ id: publicProviderEntityId(provider, 'model', native), name,
  provider: provider === 'claude' ? 'Claude Code' : 'Codex', providerId: provider, ready: true, reasoningEfforts: FIVE, defaultReasoningEffort: 'medium', runtimeModes: [...MODES] })
const OPUS = publicProviderEntityId('claude', 'model', 'opus'), SONNET = publicProviderEntityId('claude', 'model', 'sonnet'), SOL = publicProviderEntityId('codex', 'model', 'gpt-6.1-sol')
const identity: WatcherIdentity = { target: { hostId: HOST, threadId: 'watcher' }, projectId: 'workshop', provider: 'claude', creationOperationId: '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b', createdAt: at }

function agentState(): AgentState {
  const state = threadsStateFixture({ cloneOverrides: false, configuration: { ...defaultAgentConfiguration(), enabledProviders: ['claude', 'codex'] },
    host: { connected: true, name: 'Agents', version: '', capabilities: caps, projects: [],
      models: [model('claude', 'opus', 'Opus 5.5'), model('claude', 'sonnet', 'Sonnet 5.5'), model('codex', 'gpt-6.1-sol', 'GPT-6.1 Sol')],
      threads: [{ id: 'watcher', kind: 'watcher', title: 'Watcher', projectId: 'workshop', modelId: OPUS, reasoningEffort: 'high', runtimeMode: 'approval-required', providerId: 'claude', status: 'idle', requests: [], messages: [] }] },
    topLevel: { activeThreadId: null, activeProjectId: null } })
  state.hostId = HOST
  return state
}
const room: WatcherRoomState = { current: identity, currentOptions: { modelId: OPUS, reasoningEffort: 'high', runtimeMode: 'approval-required', status: 'idle', connected: true },
  history: [], runtimeMode: 'approval-required', requests: [], watchedThreads: [], inFlight: 0, inFlightLimit: 4, receipts: [], recoveryNotice: null, observedAt: at }

function show() {
  const state = agentState()
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => state)
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, command))
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'settings', platform: 'win32', windowMaximized: false, settings: DEFAULT_SETTINGS,
    update: { owlFeatures: { watcher: true, 'worker-roles': true } }, actions: { navigate: vi.fn(), updateSettings: vi.fn() } } as unknown as AppContextValue)
  const ok = (state: WatcherRoomState): WatcherRoomResult => ({ status: 'ok', state })
  const bridge = { get: vi.fn(async () => ok(room)), open: vi.fn(async () => ok(room)), setLimit: vi.fn(), prepareStopAll: vi.fn(), stopAll: vi.fn(),
    setPermission: vi.fn(async () => ok(room)), onChanged: vi.fn(() => () => undefined) }
  const update = vi.fn<(patch: SettingsPatch) => Promise<boolean>>(async () => true)
  render(<WatcherRoomProvider bridge={bridge as unknown as WatcherBridge}>
    <WorkerRolesSettings settings={DEFAULT_SETTINGS} platform="win32" onUpdateSettings={update} onOpenSection={vi.fn()} /></WatcherRoomProvider>)
  return { command, bridge, update }
}
const orchestrating = () => screen.getByRole('article', { name: 'Orchestrating' })

beforeEach(() => { vi.mocked(useOptionalApp).mockReset(); vi.mocked(useOptionalAgents).mockReset(); pendingSettingsStore.forget('watcher') })
afterEach(() => { cleanup(); pendingSettingsStore.forget('watcher') })

describe('Orchestrating while Watcher runs: one choice in two places (#1041)', () => {
  it('shows Watcher’s own model, effort and permissions, and a model on its provider changes Watcher as its composer does', async () => {
    const { command, update } = show()
    const chip = await within(orchestrating()).findByRole('combobox', { name: /^Choose Watcher’s model\. Now Opus 5\.5/u })
    expect(within(orchestrating()).getByRole('combobox', { name: /^Choose Watcher’s reasoning effort/u })).toHaveTextContent('High')
    expect(within(orchestrating()).getByRole('combobox', { name: 'Watcher’s permissions' })).toHaveTextContent('Ask for approval')
    fireEvent.click(chip)
    fireEvent.click(screen.getByRole('option', { name: 'Sonnet 5.5' }))
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'configure-thread', threadId: 'watcher', modelId: SONNET })))
    // Saved for the next Watcher too.
    expect(update).toHaveBeenLastCalledWith({ workerRoles: { orchestrating: { modelId: SONNET, reasoningEffort: 'medium' } } })
  })

  it('starts a new Watcher for another provider’s model, as its composer does', async () => {
    const { bridge, command, update } = show()
    fireEvent.click(await within(orchestrating()).findByRole('combobox', { name: /^Choose Watcher’s model/u }))
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }))
    fireEvent.click(screen.getByRole('option', { name: 'GPT-6.1 Sol' }))
    await waitFor(() => expect(bridge.open).toHaveBeenCalledWith({ provider: 'codex', modelId: SOL, reasoningEffort: 'medium' }))
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'configure-thread' }))
    expect(update).toHaveBeenLastCalledWith({ workerRoles: { orchestrating: { modelId: SOL, reasoningEffort: 'medium' } } })
  })
})
