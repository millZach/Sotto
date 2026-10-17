import { threadsStateFixture } from '../../fixtures/agentState'
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, publicProviderEntityId, type AgentModel, type AgentState } from '../../../src/shared/agents'
import { DEFAULT_SETTINGS, type AppSettings, type SettingsPatch } from '../../../src/shared/settings'
import { useOptionalAgents } from '../../../src/renderer/src/agents/AgentContext'
import { WorkerRolesSettings } from '../../../src/renderer/src/features/settings/WorkerRolesSettings'
import { agentContextFixture } from '../../fixtures/agentContext'
import { firstMessage } from '../../../src/renderer/src/watcher/watcherFirstMessage'
import { useHeldProviders } from '../../../src/renderer/src/state/owlFeature'

vi.mock('../../../src/renderer/src/agents/AgentContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn() }))
// Muse is held to Owl unless a test says otherwise, as on a run whose Owl answer for it is off.
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>(),
  useHeldProviders: vi.fn(() => new Set(['muse'])) }))

const caps = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
const MODES = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const
const FIVE = ['low', 'medium', 'high', 'xhigh', 'max']
const model = (provider: 'claude' | 'codex', native: string, name: string, efforts: string[], ready = true): AgentModel => ({
  id: publicProviderEntityId(provider, 'model', native), name, provider: provider === 'claude' ? 'Claude Code' : 'Codex', providerId: provider, ready,
  reasoningEfforts: efforts, ...(efforts.length ? { defaultReasoningEffort: 'medium' } : {}), runtimeModes: [...MODES] })

function state(claudeReady = true, devin = false): AgentState {
  return threadsStateFixture({ cloneOverrides: false,
    configuration: { ...defaultAgentConfiguration(), enabledProviders: ['claude', 'codex'] },
    host: { connected: true, name: 'Agents', version: '', capabilities: caps, projects: [], threads: [],
      providers: [{ id: 'claude', connection: claudeReady ? 'connected' : 'disconnected', name: 'Claude Code', version: '', capabilities: caps },
        { id: 'codex', connection: 'connected', name: 'Codex', version: '', capabilities: caps }],
      models: [model('claude', 'opus', 'Opus 5.5', FIVE, claudeReady), model('claude', 'sonnet', 'Sonnet 5.5', FIVE, claudeReady), model('claude', 'haiku', 'Haiku 5.5', [], claudeReady),
        model('codex', 'gpt-6.1-sol', 'GPT-6.1 Sol', FIVE), model('codex', 'gpt-6-astra', 'GPT-6 Astra', FIVE), model('codex', 'gpt-6-luna', 'GPT-6 Luna', ['low', 'medium', 'high']),
        ...devin ? [{ ...model('codex', 'swe-1', 'Devin SWE', FIVE), id: publicProviderEntityId('devin', 'model', 'swe-1'), provider: 'Devin', providerId: 'devin' as const }] : []] },
    topLevel: { activeThreadId: null, activeProjectId: null } })
}
function show(workerRoles: AppSettings['workerRoles'] = {}, claudeReady = true, devin = false) {
  const agents = state(claudeReady, devin)
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(agents, vi.fn(async () => agents)))
  const update = vi.fn<(patch: SettingsPatch) => Promise<boolean>>(async () => true)
  const open = vi.fn()
  render(<WorkerRolesSettings settings={{ ...DEFAULT_SETTINGS, workerRoles }} platform="win32" onUpdateSettings={update} onOpenSection={open} />)
  return { update, open }
}
const card = (name: string) => screen.getByRole('article', { name })
afterEach(() => { cleanup(); vi.clearAllMocks(); firstMessage.clear(); vi.mocked(useHeldProviders).mockImplementation(() => new Set(['muse'])) })

describe('Settings, under Watcher: worker roles (#1041)', () => {
  it('shows each role on its default with its defaults in order', () => {
    show()
    expect(within(card('Building')).getByRole('combobox', { name: /^Choose Building’s model\. Now Opus 5\.5/u })).toHaveTextContent('Opus 5.5')
    expect(within(card('Building')).getByRole('combobox', { name: /^Choose Building’s reasoning effort/u })).toHaveTextContent('Extra high')
    expect(within(card('Building')).getByRole('combobox', { name: /^Choose what Building workers may do without asking/u })).toHaveTextContent('Allow edits')
    expect(within(card('Research')).getByText('Haiku 5.5 has none')).toBeInTheDocument()
    expect(within(card('Code review')).getByRole('combobox', { name: /model/u })).toHaveTextContent('GPT-6.1 Sol')
    const defaults = within(card('Code review')).getAllByRole('listitem')
    expect(defaults[0]).toHaveTextContent('Muse Wonder Full, Extra highNot set up')
    expect(defaults[1]).toHaveTextContent('GPT-6.1 Sol, Extra highIn use')
    // No new-thread default means Ask for approval, so Building's Allow edits is held back, and the card says so.
    expect(within(card('Building')).getByText(/^Workers never start wider than your new-thread default, so these start on “Ask for approval”\./u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Reset all roles to their defaults/u })).toBeDisabled()
  })

  it('saves the whole row as the user’s choice once one setting changes, and nothing once it is back on the default', () => {
    const { update } = show()
    fireEvent.click(within(card('Building')).getByRole('combobox', { name: /model/u }))
    fireEvent.click(screen.getByRole('option', { name: 'Sonnet 5.5' }))
    expect(update).toHaveBeenLastCalledWith({ workerRoles: { building: { modelId: publicProviderEntityId('claude', 'model', 'sonnet'), reasoningEffort: 'xhigh', runtimeMode: 'auto-accept-edits' } } })
    cleanup()
    const chosen = show({ building: { modelId: publicProviderEntityId('claude', 'model', 'sonnet'), reasoningEffort: 'xhigh', runtimeMode: 'auto-accept-edits' } })
    expect(within(card('Building')).getByText('Your choice')).toBeInTheDocument()
    fireEvent.click(within(card('Building')).getByRole('combobox', { name: /model/u }))
    fireEvent.click(screen.getByRole('option', { name: 'Opus 5.5' }))
    expect(chosen.update).toHaveBeenLastCalledWith({ workerRoles: {} })
  })

  it('keeps a choice whose provider is away and says what starts meanwhile, and Reset puts the default back', () => {
    const { update } = show({ building: { modelId: publicProviderEntityId('claude', 'model', 'sonnet'), reasoningEffort: 'xhigh', runtimeMode: 'auto-accept-edits' } }, false)
    expect(within(card('Building')).getByText('Your choice, not available')).toBeInTheDocument()
    expect(within(card('Building')).getByText('Your choice, Sonnet 5.5, stays. Claude Code is not connected, so until it is, workers start on GPT-6.1 Sol, the next default.')).toBeInTheDocument()
    expect(within(card('UI')).getByText('Next default')).toBeInTheDocument()
    expect(screen.getByText(/^Claude Code is not connected, so \d roles start new work on their next default until it connects\. Nothing you chose has changed\.$/u)).toBeInTheDocument()
    fireEvent.click(within(card('Building')).getByRole('button', { name: 'Reset Building to its default, GPT-6.1 Sol at Extra high with Allow edits' }))
    expect(update).toHaveBeenLastCalledWith({ workerRoles: {} })
    expect(screen.getByRole('status')).toHaveTextContent('Building is back on its default, GPT-6.1 Sol at Extra high.')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(update).toHaveBeenLastCalledWith({ workerRoles: { building: { modelId: publicProviderEntityId('claude', 'model', 'sonnet'), reasoningEffort: 'xhigh', runtimeMode: 'auto-accept-edits' } } })
  })

  it('resets every role at once, and opens Agents from a held permission', () => {
    const { update, open } = show({ ui: { modelId: publicProviderEntityId('codex', 'model', 'gpt-6.1-sol'), reasoningEffort: 'high', runtimeMode: 'approval-required' },
      research: { modelId: publicProviderEntityId('codex', 'model', 'gpt-6-luna'), reasoningEffort: 'low', runtimeMode: 'approval-required' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reset all roles to their defaults. 2 roles are your choice' }))
    expect(update).toHaveBeenLastCalledWith({ workerRoles: {} })
    fireEvent.click(within(card('Building')).getByRole('button', { name: 'Change it in Agents' }))
    expect(open).toHaveBeenCalledWith('settings-agents')
  })

  it('lists every provider for Orchestrating, saying why Watcher cannot run on one yet, beside a drawing of its composer', () => {
    show({}, true, true)
    const orchestrating = card('Orchestrating')
    fireEvent.click(within(orchestrating).getByRole('combobox', { name: /^Choose Watcher’s model/u }))
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }))
    expect(screen.getByRole('option', { name: 'GPT-6.1 Sol' })).toBeEnabled()
    fireEvent.click(screen.getByRole('tab', { name: 'Devin' }))
    expect(screen.queryByRole('option', { name: /^Devin SWE/u })).toBeNull()
    expect(screen.getByRole('note')).toHaveTextContent('Watcher can’t run on Devin yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Close model picker' }))
    expect(within(orchestrating).getByRole('combobox', { name: /^Choose Watcher’s model\. Now Opus 5\.5/u })).toBeInTheDocument()
    expect(within(orchestrating).getByText('Permissions, Watcher’s own')).toBeInTheDocument()
    expect(orchestrating.querySelector('.worker-role__composer')).toHaveAttribute('aria-hidden', 'true')
    expect(within(orchestrating).getByText(/Watcher’s composer shows these three\. A change in either place changes both\./u)).toBeInTheDocument()
  })

  it('names Muse among Watcher’s providers only while Muse is not held to Owl on this run', () => {
    show()
    fireEvent.click(within(card('Orchestrating')).getByRole('combobox', { name: /^Choose Watcher’s model/u }))
    expect(screen.getByText(/Watcher runs on Codex, Claude Code or Grok Build\.$/u)).toBeInTheDocument()
    cleanup()
    vi.mocked(useHeldProviders).mockReturnValue(new Set())
    show()
    fireEvent.click(within(card('Orchestrating')).getByRole('combobox', { name: /^Choose Watcher’s model/u }))
    expect(screen.getByText(/Watcher runs on Codex, Claude Code, Grok Build or Muse\.$/u)).toBeInTheDocument()
  })

  it('lets a change to Orchestrating replace the first message’s own pick before Watcher exists', () => {
    firstMessage.update({ modelId: publicProviderEntityId('codex', 'model', 'gpt-6-astra'), effort: 'xhigh' })
    const { update } = show()
    fireEvent.click(within(card('Orchestrating')).getByRole('combobox', { name: /^Choose Watcher’s model/u }))
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }))
    fireEvent.click(screen.getByRole('option', { name: 'GPT-6.1 Sol' }))
    expect(update).toHaveBeenLastCalledWith({ workerRoles: { orchestrating: { modelId: publicProviderEntityId('codex', 'model', 'gpt-6.1-sol'), reasoningEffort: 'medium' } } })
    expect(firstMessage.get()).toMatchObject({ modelId: '', effort: null })
  })
})
