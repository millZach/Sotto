// #1042: each provider's own sub-agents follow the worker roles. The table and the instructions every thread carries.
import { describe, expect, it } from 'vitest'
import { publicProviderEntityId, type AgentModel, type AgentRuntimeMode, type ProviderId } from '../../../src/shared/agents'
import { subagentName, subagentRoleInstructions, subagentRoleTable, WORKER_KINDS, type SubagentReach } from '../../../src/shared/workerRoles'

const ALL: readonly AgentRuntimeMode[] = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
const FIVE = ['low', 'medium', 'high', 'xhigh', 'max']
function model(provider: ProviderId, native: string, name: string, efforts: readonly string[]): AgentModel {
  return { id: publicProviderEntityId(provider, 'model', native), provider, providerId: provider, name, ready: true,
    reasoningEfforts: [...efforts], ...(efforts.length ? { defaultReasoningEffort: efforts[0]! } : {}), runtimeModes: [...ALL] }
}
const CLAUDE = [model('claude', 'opus', 'Opus 5.5', FIVE), model('claude', 'sonnet', 'Sonnet 5.5', FIVE), model('claude', 'haiku', 'Haiku 5.5', [])]
const CODEX = [model('codex', 'gpt-6.1-sol', 'GPT-6.1 Sol', FIVE), model('codex', 'gpt-6-astra', 'GPT-6 Astra', FIVE), model('codex', 'gpt-6-luna', 'GPT-6 Luna', ['low', 'medium', 'high'])]
const MUSE = [model('muse', 'muse-wonder-full-1.0', 'Muse Wonder Full', ['low', 'xhigh'])]
const GROK = [model('grok', 'grok-4.7-build', 'Grok 4.7', ['low', 'medium', 'high']), model('grok', 'grok-4.6-build', 'Grok 4.6', ['low', 'medium', 'high'])]
const EVERYONE = [...CLAUDE, ...CODEX, ...MUSE, ...GROK]

describe('the sub-agent role table', () => {
  it('names each kind of work with Sotto\'s prefix, never a built-in or a user\'s name', () => {
    expect(WORKER_KINDS.map(subagentName)).toEqual(['sotto_building', 'sotto_ui', 'sotto_code_review', 'sotto_research', 'sotto_computer_use'])
  })

  it('gives every kind of work its model in the provider\'s own words, with no row for Orchestrating', () => {
    expect(subagentRoleTable({}, EVERYONE).map(role => [role.kind, role.provider, role.model, role.reasoningEffort, role.runtimeMode])).toEqual([
      ['building', 'claude', 'opus', 'xhigh', 'auto-accept-edits'],
      ['ui', 'claude', 'opus', 'xhigh', 'auto-accept-edits'],
      ['code-review', 'muse', 'muse-wonder-full-1.0', 'xhigh', 'approval-required'],
      ['research', 'claude', 'haiku', null, 'approval-required'],
      ['computer-use', 'codex', 'gpt-6-astra', 'medium', 'full-access'],
    ])
  })

  it('follows the user\'s choice and leaves out a kind nothing ready can do', () => {
    const table = subagentRoleTable({ research: { modelId: publicProviderEntityId('codex', 'model', 'gpt-6-luna'), reasoningEffort: 'low', runtimeMode: 'auto' } }, CODEX)
    expect(table.find(role => role.kind === 'research')).toMatchObject({ provider: 'codex', model: 'gpt-6-luna', modelName: 'GPT-6 Luna', reasoningEffort: 'low', runtimeMode: 'auto' })
    expect(subagentRoleTable({}, [])).toEqual([])
    expect(subagentRoleInstructions([], { provider: 'claude', agents: new Set(), canDelegate: true })).toBeUndefined()
  })
})

describe('the instructions a thread carries', () => {
  const table = subagentRoleTable({}, EVERYONE)
  const lines = (reach: SubagentReach) => subagentRoleInstructions(table, reach)!.split('\n')

  it('tells a Claude Code thread which of its agents to use, and to delegate the rest', () => {
    const text = lines({ provider: 'claude', agents: new Set(['building', 'ui', 'research']), agentTool: 'claude', canDelegate: true })
    expect(text).toEqual([
      'The user\'s Settings give each kind of work a worker role and the model it runs on. When you hand part of your work to a sub-agent or another thread, follow them:',
      '- Building (writing and changing code): use the Agent tool with subagent_type "sotto_building" (Opus 5.5 at xhigh effort).',
      '- UI (screens, styles and how they look): use the Agent tool with subagent_type "sotto_ui" (Opus 5.5 at xhigh effort).',
      '- Code review (reading a change and saying what is wrong with it): Muse Wonder Full at xhigh effort on Muse, another provider: call delegate with work "code-review".',
      '- Research (reading code, docs and the web, and reporting back): use the Agent tool with subagent_type "sotto_research" (Haiku 5.5).',
      '- Computer use (clicking and typing in apps and the browser): GPT-6 Astra at medium effort on Codex, another provider: call delegate with work "computer-use".',
      'A model, effort or permission the user names for a request wins over the role. Work you do yourself needs no role.',
    ])
  })

  it('tells a Codex thread to name its role in spawn_agent', () => {
    expect(lines({ provider: 'codex', agents: new Set(['computer-use']), agentTool: 'codex', canDelegate: true })[5])
      .toBe('- Computer use (clicking and typing in apps and the browser): call spawn_agent with agent_type "sotto_computer_use" (GPT-6 Astra at medium effort).')
  })

  it('gives a provider without role agents the model to ask for, and a thread that cannot delegate its own work back', () => {
    const grok = subagentRoleTable({ research: { modelId: publicProviderEntityId('grok', 'model', 'grok-4.6-build'), reasoningEffort: 'medium' } }, EVERYONE)
    const text = subagentRoleInstructions(grok, { provider: 'grok', agents: new Set(), canDelegate: false })!.split('\n')
    expect(text[4]).toBe('- Research (reading code, docs and the web, and reporting back): start your sub-agent on grok-4.6-build at medium effort when you can choose its model.')
    expect(text[1]).toBe('- Building (writing and changing code): Opus 5.5 at xhigh effort on Claude Code, which this thread cannot start: do that work yourself.')
    expect(text.join('\n')).not.toContain('delegate')
  })

  it('names no agent the launch did not get', () => {
    // A Claude model that is not ready to this adapter gets no agent, so its line falls back to the model to ask for.
    expect(lines({ provider: 'claude', agents: new Set(), agentTool: 'claude', canDelegate: true })[1])
      .toBe('- Building (writing and changing code): start your sub-agent on opus at xhigh effort when you can choose its model.')
  })
})
