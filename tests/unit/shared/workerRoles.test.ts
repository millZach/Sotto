import { describe, expect, it } from 'vitest'
import { publicProviderEntityId, type AgentModel, type AgentRuntimeMode, type ProviderId } from '../../../src/shared/agents'
import { capRuntimeMode, fitEffort, isRoleDefault, parseWorkerRoleChoices, roleCanUse, roleInForce, roleStartNote, startFromRole, watcherProvidersInWords, withRoleRow, workerCounts, WORKER_COUNTS, WORKER_ROLE_IDS,
  type WorkerRoleChoices, type WorkerRoleId } from '../../../src/shared/workerRoles'

const ALL: readonly AgentRuntimeMode[] = ['approval-required', 'auto-accept-edits', 'auto', 'full-access']
const FIVE = ['low', 'medium', 'high', 'xhigh', 'max']
const LABEL: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok Build', muse: 'Muse', devin: 'Devin', opencode: 'OpenCode', cursor: 'OpenCode', deepseek: 'DeepSeek Harness' }
function model(provider: ProviderId, native: string, name: string, efforts: readonly string[], options: Partial<AgentModel> = {}): AgentModel {
  return { id: publicProviderEntityId(provider, 'model', native), provider: LABEL[provider], providerId: provider, name, ready: true,
    reasoningEfforts: [...efforts], ...(efforts.length ? { defaultReasoningEffort: efforts.includes('medium') ? 'medium' : efforts[0]! } : {}),
    runtimeModes: provider === 'grok' ? ['approval-required', 'auto', 'full-access'] : [...ALL], ...options }
}
const CLAUDE = [model('claude', 'opus', 'Opus 5.5', FIVE), model('claude', 'sonnet', 'Sonnet 5.5', FIVE), model('claude', 'haiku', 'Haiku 5.5', []),
  model('claude', 'claude-fable-5-1', 'Fable 5.1', FIVE)]
const CODEX = [model('codex', 'gpt-6.1-sol', 'GPT-6.1 Sol', FIVE), model('codex', 'gpt-6-astra', 'GPT-6 Astra', [...FIVE, 'ultra']),
  model('codex', 'gpt-6-luna', 'GPT-6 Luna', ['minimal', 'low', 'medium', 'high'])]
const MUSE = [model('muse', 'muse-wonder-full-1.0', 'Muse Wonder Full', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  model('muse', 'muse-wonder-1.0', 'Muse Wonder', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])]
const GROK = [model('grok', 'grok-4.7-build', 'Grok 4.7', ['low', 'medium', 'high']), model('grok', 'grok-4.6-build', 'Grok 4.6', ['low', 'medium', 'high'])]
const away = (models: readonly AgentModel[]): AgentModel[] => models.map(item => ({ ...item, ready: false }))
const id = (provider: ProviderId, native: string) => publicProviderEntityId(provider, 'model', native)

/** What each role starts new work on, as `[native model, effort, mode]`. */
function table(models: readonly AgentModel[], choices: WorkerRoleChoices = {}): Record<WorkerRoleId, [string, string | null, AgentRuntimeMode | undefined] | null> {
  return Object.fromEntries(WORKER_ROLE_IDS.map(role => {
    const start = roleInForce(role, choices, models).start
    return [role, start ? [start.modelId.replace(/^native:[a-z]+:model:/u, ''), start.reasoningEffort, start.runtimeMode] : null]
  })) as Record<WorkerRoleId, [string, string | null, AgentRuntimeMode | undefined] | null>
}

describe('worker roles', () => {
  it('keeps counts with the role, and a count-only change keeps a chosen row until Reset', () => {
    expect(WORKER_COUNTS).toEqual({ research: { usual: 1, upTo: 8 }, 'code-review': { usual: 1, upTo: 4 },
      building: { usual: 1, upTo: 2 }, ui: { usual: 1, upTo: 2 }, 'computer-use': { usual: 1, upTo: 1 } })
    const row = { modelId: id('claude', 'haiku'), reasoningEffort: null, workers: { usual: 4, upTo: 12 } }
    const chosen = withRoleRow({}, 'research', row, CLAUDE)
    expect(chosen.research).toEqual(row)
    expect(workerCounts('research', chosen)).toEqual({ usual: 4, upTo: 12 })
    expect(roleInForce('research', chosen, CODEX).choice?.workers).toEqual({ usual: 4, upTo: 12 })
    expect(withRoleRow(chosen, 'research', { ...row, workers: { usual: 1, upTo: 8 } }, CLAUDE)).toEqual({})
  })

  it('drops damaged counts without dropping the row and never gives Orchestrating counts', () => {
    const row = { modelId: 'chosen', reasoningEffort: 'high', runtimeMode: 'auto' }
    for (const workers of [{ usual: 0, upTo: 8 }, { usual: 3, upTo: 2 }, { usual: 1.5, upTo: 8 }, 'damaged']) {
      const parsed = parseWorkerRoleChoices({ research: { ...row, workers } })
      expect(parsed.research).toEqual(row)
      expect(workerCounts('research', parsed)).toEqual({ usual: 1, upTo: 8 })
    }
    expect(parseWorkerRoleChoices({ orchestrating: { ...row, workers: { usual: 2, upTo: 8 } } }))
      .toEqual({ orchestrating: { modelId: 'chosen', reasoningEffort: 'high' } })
  })

  it('gives Zach his defaults with Claude Code, Codex, Muse and Grok Build connected', () => {
    expect(table([...CLAUDE, ...CODEX, ...MUSE, ...GROK])).toEqual({
      orchestrating: ['opus', 'high', undefined],
      building: ['opus', 'xhigh', 'auto-accept-edits'],
      ui: ['opus', 'xhigh', 'auto-accept-edits'],
      'code-review': ['muse-wonder-full-1.0', 'xhigh', 'approval-required'],
      research: ['haiku', null, 'approval-required'],
      'computer-use': ['gpt-6-astra', 'medium', 'full-access'],
    })
  })

  it('gives two providers each role the first of its defaults they offer', () => {
    expect(table([...CLAUDE, ...CODEX])).toEqual({
      orchestrating: ['opus', 'high', undefined],
      building: ['opus', 'xhigh', 'auto-accept-edits'],
      ui: ['opus', 'xhigh', 'auto-accept-edits'],
      'code-review': ['gpt-6.1-sol', 'xhigh', 'approval-required'],
      research: ['haiku', null, 'approval-required'],
      'computer-use': ['gpt-6-astra', 'medium', 'full-access'],
    })
  })

  it('gives one subscription its own sensible models', () => {
    expect(table(CODEX)).toEqual({
      orchestrating: ['gpt-6.1-sol', 'high', undefined],
      building: ['gpt-6.1-sol', 'xhigh', 'auto-accept-edits'],
      ui: ['gpt-6.1-sol', 'xhigh', 'auto-accept-edits'],
      'code-review': ['gpt-6.1-sol', 'xhigh', 'approval-required'],
      research: ['gpt-6-luna', 'medium', 'approval-required'],
      'computer-use': ['gpt-6-astra', 'medium', 'full-access'],
    })
    expect(table(CLAUDE)['computer-use']).toEqual(['opus', 'high', 'full-access'])
    // Grok Build offers no Extra high and no Allow edits: the nearest it offers, never wider.
    expect(table(GROK)).toMatchObject({ orchestrating: ['grok-4.7-build', 'high', undefined], building: ['grok-4.7-build', 'high', 'approval-required'],
      research: ['grok-4.6-build', 'medium', 'approval-required'] })
    // Watcher runs on Muse (ADR-0079), so Orchestrating takes Muse's own first model, as a role with no Muse default does.
    const muse = table(MUSE)
    expect(muse.orchestrating).toEqual(['muse-wonder-full-1.0', 'medium', undefined])
    expect(roleInForce('orchestrating', {}, MUSE).fallback?.index).toBe(-1)
    expect(roleCanUse('orchestrating', { providerId: 'muse' })).toBe(true)
    // Devin cannot host Watcher's tools, so Orchestrating never runs there; other roles can.
    expect(roleCanUse('orchestrating', { providerId: 'devin' })).toBe(false)
    expect(roleCanUse('research', { providerId: 'devin' })).toBe(true)
    // Watcher is refused on OpenCode too (ADR-0087), and a role with no ready default reaches OpenCode only after every
    // other provider, Devin included.
    expect(roleCanUse('orchestrating', { providerId: 'opencode' })).toBe(false)
    const zen = [model('opencode', 'big-pickle', 'Big Pickle', ['low', 'medium', 'high'], { recommended: true })]
    const devin = [model('devin', 'swe-1.5', 'SWE-1.5', [])]
    expect(table(zen)).toMatchObject({ orchestrating: null, research: ['big-pickle', 'medium', 'approval-required'] })
    expect(table([...zen, ...devin]).research?.[0]).toBe('swe-1.5')
    expect(muse).toMatchObject({ building: ['muse-wonder-full-1.0', 'xhigh', 'auto-accept-edits'], research: ['muse-wonder-1.0', 'low', 'approval-required'],
      'computer-use': ['muse-wonder-full-1.0', 'medium', 'full-access'] })
    expect(roleInForce('computer-use', {}, MUSE).fallback?.index).toBe(-1)
    expect(table([])).toEqual(Object.fromEntries(WORKER_ROLE_IDS.map(role => [role, null])))
  })

  it('moves a row on its default to the next default while its provider is away, and back when it returns', () => {
    const off = [...away(CLAUDE), ...CODEX]
    expect(table(off)).toMatchObject({ orchestrating: ['gpt-6.1-sol', 'high', undefined], building: ['gpt-6.1-sol', 'xhigh', 'auto-accept-edits'], research: ['gpt-6-luna', 'medium', 'approval-required'] })
    expect(roleInForce('building', {}, off).fallback?.index).toBe(2)
    expect(table([...CLAUDE, ...CODEX]).building).toEqual(['opus', 'xhigh', 'auto-accept-edits'])
  })

  it('keeps the user’s row through a provider disconnecting and connecting, starting on the next default meanwhile', () => {
    const choices: WorkerRoleChoices = { building: { modelId: id('claude', 'sonnet'), reasoningEffort: 'xhigh', runtimeMode: 'auto-accept-edits' } }
    const connected = roleInForce('building', choices, [...CLAUDE, ...CODEX])
    expect(connected).toMatchObject({ choiceReady: true, start: { modelId: id('claude', 'sonnet'), from: 'choice' } })
    const disconnected = roleInForce('building', choices, [...away(CLAUDE), ...CODEX])
    expect(disconnected.choice).toEqual(choices.building)
    expect(disconnected).toMatchObject({ choiceReady: false, start: { modelId: id('codex', 'gpt-6.1-sol'), from: 'default' } })
    // A provider connecting for the first time does not overwrite it either.
    expect(roleInForce('building', choices, [...CLAUDE, ...CODEX, ...MUSE, ...GROK]).start?.modelId).toBe(id('claude', 'sonnet'))
    // A choice whose provider comes back is in force again.
    expect(roleInForce('building', choices, [...CLAUDE, ...CODEX]).start?.modelId).toBe(id('claude', 'sonnet'))
  })

  it('starts on the next default no wider than the permission the user chose while the chosen provider is away', () => {
    // Computer use's own default is Full access; the user chose Opus with Ask for approval, and Claude Code is away.
    const choices: WorkerRoleChoices = { 'computer-use': { modelId: id('claude', 'opus'), reasoningEffort: 'high', runtimeMode: 'approval-required' } }
    const off = [...away(CLAUDE), ...CODEX]
    expect(roleInForce('computer-use', choices, off).start).toMatchObject({ modelId: id('codex', 'gpt-6-astra'), runtimeMode: 'approval-required', from: 'default' })
    expect(startFromRole('computer-use', choices, off)).toMatchObject({ modelId: id('codex', 'gpt-6-astra'), runtimeMode: 'approval-required' })
    // A chosen mode the next default's model does not offer starts on the nearest it offers below it.
    const grok = { building: { modelId: id('claude', 'opus'), reasoningEffort: 'high', runtimeMode: 'auto-accept-edits' as const } }
    expect(roleInForce('building', grok, [...away(CLAUDE), ...GROK]).start).toMatchObject({ modelId: id('grok', 'grok-4.7-build'), runtimeMode: 'approval-required' })
    // With no choice, the next default keeps the role's own permission.
    expect(roleInForce('computer-use', {}, off).start?.runtimeMode).toBe('full-access')
  })

  it('puts the defaults back on Reset, and treats a row set back to its default as no choice', () => {
    const models = [...CLAUDE, ...CODEX]
    const choices: WorkerRoleChoices = { ui: { modelId: id('codex', 'gpt-6.1-sol'), reasoningEffort: 'high', runtimeMode: 'approval-required' } }
    expect(roleInForce('ui', choices, models).start?.modelId).toBe(id('codex', 'gpt-6.1-sol'))
    const { ui: _reset, ...afterReset } = choices
    void _reset
    expect(roleInForce('ui', afterReset, models).start).toMatchObject({ modelId: id('claude', 'opus'), reasoningEffort: 'xhigh', runtimeMode: 'auto-accept-edits', from: 'default' })
    expect(isRoleDefault('ui', { modelId: id('claude', 'opus'), reasoningEffort: 'xhigh', runtimeMode: 'auto-accept-edits' }, models)).toBe(true)
    expect(isRoleDefault('ui', { modelId: id('claude', 'opus'), reasoningEffort: 'high', runtimeMode: 'auto-accept-edits' }, models)).toBe(false)
    expect(isRoleDefault('ui', { modelId: id('claude', 'opus'), reasoningEffort: 'xhigh', runtimeMode: 'approval-required' }, models)).toBe(false)
    expect(isRoleDefault('orchestrating', { modelId: id('claude', 'opus'), reasoningEffort: 'high' }, models)).toBe(true)
    // Saving a row keeps it as a choice, and saving it back on its default leaves it out.
    const chosen = withRoleRow({}, 'ui', { modelId: id('codex', 'gpt-6.1-sol'), reasoningEffort: 'high', runtimeMode: 'approval-required' }, models)
    expect(chosen).toEqual({ ui: { modelId: id('codex', 'gpt-6.1-sol'), reasoningEffort: 'high', runtimeMode: 'approval-required' } })
    expect(withRoleRow(chosen, 'ui', { modelId: id('claude', 'opus'), reasoningEffort: 'xhigh', runtimeMode: 'auto-accept-edits' }, models)).toEqual({})
  })

  it('reads saved rows one at a time, and never keeps a permission for Orchestrating', () => {
    expect(parseWorkerRoleChoices({ building: { modelId: 'm', reasoningEffort: null, runtimeMode: 'auto' }, ui: 'damaged', other: { modelId: 'm', reasoningEffort: null },
      orchestrating: { modelId: 'o', reasoningEffort: 'high', runtimeMode: 'full-access' } })).toEqual({
      building: { modelId: 'm', reasoningEffort: null, runtimeMode: 'auto' }, orchestrating: { modelId: 'o', reasoningEffort: 'high' } })
    expect(parseWorkerRoleChoices('nope')).toEqual({})
    expect(parseWorkerRoleChoices(null)).toEqual({})
  })

  it('fits an effort to the nearest level a model offers, and none to a model without', () => {
    expect(fitEffort('xhigh', GROK[0])).toBe('high')
    expect(fitEffort('medium', CODEX[2])).toBe('medium')
    expect(fitEffort('max', CODEX[2])).toBe('high')
    expect(fitEffort('xhigh', CLAUDE[2])).toBeNull()
    expect(fitEffort(null, CODEX[0])).toBe('medium')
    expect(capRuntimeMode('full-access', 'approval-required')).toBe('approval-required')
    expect(capRuntimeMode('approval-required', 'full-access')).toBe('approval-required')
  })

  it('starts by role, with what a request named in the role’s place, and says so', () => {
    const models = [...CLAUDE, ...CODEX]
    const plain = startFromRole('building', {}, models)
    expect(plain).toEqual({ role: 'building', modelId: id('claude', 'opus'), reasoningEffort: 'xhigh', runtimeMode: 'auto-accept-edits', named: [], roleModelId: id('claude', 'opus') })
    expect(roleStartNote(plain, models)).toBe('Started as Building, a worker role in the user\'s Settings. Its model, Opus 5.5, its effort and its permission came from that role.')
    // A named model takes the role's effort and permission as near as it offers them.
    const named = startFromRole('building', {}, models, { modelId: id('codex', 'gpt-6-luna') })
    expect(named).toMatchObject({ modelId: id('codex', 'gpt-6-luna'), reasoningEffort: 'high', runtimeMode: 'auto-accept-edits', named: ['model'] })
    expect(roleStartNote(named, models)).toBe('Started as Building, a worker role in the user\'s Settings. This request named its model (GPT-6 Luna, where Building uses Opus 5.5), which overrides Building for this start only. Its effort and permission came from the role.')
    const held = startFromRole('computer-use', {}, models)
    expect(held.runtimeMode).toBe('full-access')
    expect(roleStartNote(held, models, { wanted: 'full-access', startedOn: 'approval-required' })).toContain('Its permission, Full access, was held to the user\'s new-thread default, Ask for approval.')
    expect(roleStartNote(held, models, { wanted: 'full-access', startedOn: 'auto', by: 'delegating-thread' })).toContain('Its permission, Full access, was held to Auto, the delegating thread\'s own, since a delegated thread gets no more.')
    expect(startFromRole('research', {}, models, { reasoningEffort: 'low', runtimeMode: 'auto' })).toMatchObject({ modelId: id('claude', 'haiku'), reasoningEffort: 'low', runtimeMode: 'auto', named: ['effort', 'permission'] })
    expect(startFromRole('building', {}, [])).toMatchObject({ modelId: undefined, roleModelId: undefined })
  })
})

describe('Watcher’s providers in words', () => {
  it('names those this run does not hold, so stable never names Muse and Owl does', () => {
    expect(watcherProvidersInWords(new Set(['muse', 'opencode', 'cursor']))).toBe('Codex, Claude Code or Grok Build')
    expect(watcherProvidersInWords(new Set())).toBe('Codex, Claude Code, Grok Build, Muse or Cursor')
  })
})
