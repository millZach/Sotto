import { describe, expect, it } from 'vitest'
import type { AgentModel, AgentThread } from '../../../src/shared/agents'
import { DEFAULT_MODEL_ROUTER, isRoutedThread, parseModelRouterSettings, parseRouterAnswer, routedSettings, routerEffortFor, routerMaterial, routerModel, routerTierOf, whyNotRouted } from '../../../src/shared/modelRouter'

const model = (id: string, name: string, extra: Partial<AgentModel> = {}): AgentModel => ({ id, name, provider: 'Claude Code', providerId: 'claude', ready: true,
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'medium', ...extra }) as AgentModel
const catalog = [model('default', 'Default (recommended)', { recommended: true }), model('opus', 'Opus 5.5'), model('fable', 'Fable 5.2'), model('sonnet', 'Sonnet 5.5'),
  model('haiku', 'Haiku 5.5'), model('claude-opus-5', 'Opus 5', { legacy: true }), model('gpt', 'GPT-6.1 Sol', { providerId: 'codex', provider: 'Codex' })]
const thread = (extra: Partial<AgentThread> = {}): AgentThread => ({ providerId: 'claude', modelId: 'opus', routed: true, ...extra }) as AgentThread

describe('model routing', () => {
  it('reads the classifier\'s answer, plain or wrapped, and nothing else', () => {
    expect(parseRouterAnswer('{"model":"opus","effort":"high","reason":"Everyday debugging"}')).toEqual({ tier: 'opus', effort: 'high', reason: 'Everyday debugging' })
    expect(parseRouterAnswer('Here you go:\n```json\n{"model":"fable","effort":"xhigh","reason":"  A   proof  "}\n```')).toEqual({ tier: 'fable', effort: 'xhigh', reason: 'A proof' })
    expect(parseRouterAnswer('{"model":"sonnet","effort":"low"}')).toEqual({ tier: 'sonnet', effort: 'low', reason: '' })
    expect(parseRouterAnswer(`{"model":"haiku","effort":"low","reason":"${'x'.repeat(300)}"}`)?.reason).toHaveLength(120)
    for (const bad of [null, '', 'opus at high', '{"model":"gpt","effort":"high"}', '{"model":"opus","effort":"max"}', '{"model":"opus"', 'Summary.\n<invoke name="StructuredOutput">']) expect(parseRouterAnswer(bad)).toBeUndefined()
  })

  it('builds the classifier\'s material as the benchmark built it', () => {
    // `run_benchmark.py`'s `material()`: the same characters for a first message and for a later one.
    expect(routerMaterial('Fix the typo.')).toBe('User message:\nFix the typo.')
    expect(routerMaterial('yes', { model: 'opus', effort: 'medium', previousUser: 'Plan the rename.', lastReply: 'Want me to go ahead?' }))
      .toBe('Thread so far\nCurrent model: opus\nCurrent effort: medium\nPrevious user message: Plan the rename.\nEnd of the last reply: Want me to go ahead?\n\nUser message:\nyes')
    const cut = routerMaterial('m'.repeat(5_000), { model: 'opus', effort: 'high', previousUser: 'p'.repeat(400), lastReply: `${'a'.repeat(500)}END` })
    expect(cut).toContain(`Previous user message: ${'p'.repeat(300)}\n`)
    expect(cut).toContain(`End of the last reply: ${'a'.repeat(397)}END\n`)
    expect(cut.endsWith(`User message:\n${'m'.repeat(4_000)}`)).toBe(true)
  })

  it('finds each tier in the catalog by its line, never a legacy model, another provider\'s or Default', () => {
    expect(routerModel(catalog, 'opus')?.id).toBe('opus')
    expect(routerModel(catalog, 'haiku')?.id).toBe('haiku')
    expect(routerTierOf(catalog[0])).toBeUndefined()
    expect(routerModel(catalog.filter(item => item.id !== 'fable'), 'fable')).toBeUndefined()
    expect(routerModel([model('opus', 'Opus 5.5', { ready: false })], 'opus')).toBeUndefined()
  })

  it('puts a thread on the answer, keeps a held variant of the same model, and fits the effort to the model', () => {
    const answer = { tier: 'opus', effort: 'high', reason: '' } as const
    expect(routedSettings(catalog, answer, thread({ modelId: 'sonnet' }), false)).toEqual({ modelId: 'opus', reasoningEffort: 'high' })
    expect(routedSettings(catalog, answer, thread({ modelId: 'opus[1m]' }), false)).toEqual({ modelId: 'opus[1m]', reasoningEffort: 'high' })
    expect(routedSettings(catalog.filter(item => item.id !== 'opus'), answer, thread({ modelId: 'sonnet' }), false)).toBeUndefined()
    expect(routerEffortFor(model('haiku', 'Haiku 5.5', { reasoningEfforts: ['low', 'medium'] }), 'xhigh')).toBe('medium')
    expect(routerEffortFor(model('x', 'X', { reasoningEfforts: ['high', 'max'] }), 'low')).toBe('high')
    expect(routerEffortFor(undefined, 'xhigh')).toBe('xhigh')
  })

  it('keeps the model and takes only the effort where the thread stays on its first model', () => {
    expect(routedSettings(catalog, { tier: 'fable', effort: 'xhigh', reason: '' }, thread({ modelId: 'sonnet' }), true)).toEqual({ modelId: 'sonnet', reasoningEffort: 'xhigh' })
    // A thread on Default, which is no tier, still stays where it is.
    expect(routedSettings(catalog, { tier: 'haiku', effort: 'low', reason: '' }, thread({ modelId: 'default' }), true)).toEqual({ modelId: 'default', reasoningEffort: 'low' })
  })

  it('says why a thread cannot be routed, and routes only a marked thread while the feature is on', () => {
    expect(whyNotRouted(thread())).toBeUndefined()
    expect(whyNotRouted(thread({ archivedAt: '2026-11-13T00:00:00.000Z' }))).toMatch(/archived/u)
    expect(whyNotRouted(thread({ kind: 'watcher' }))).toMatch(/project/u)
    expect(whyNotRouted(thread({ remoteHost: true }))).toMatch(/another machine/u)
    expect(whyNotRouted(thread({ delegatedBy: 't' }))).toMatch(/another thread started/u)
    expect(whyNotRouted(thread({ providerId: 'codex' }))).toMatch(/Claude Code/u)
    expect(whyNotRouted(thread({ dynamic: true }))).toMatch(/Dynamic/u)
    expect(isRoutedThread(thread(), true)).toBe(true)
    expect(isRoutedThread(thread(), false)).toBe(false)
    expect(isRoutedThread(thread({ routed: undefined }), true)).toBe(false)
    expect(isRoutedThread(thread({ dynamic: true }), true)).toBe(false)
  })

  it('reads its settings one field at a time, starting with staying off', () => {
    expect(DEFAULT_MODEL_ROUTER).toEqual({ stayOnFirstModel: false })
    expect(parseModelRouterSettings(null)).toEqual({ stayOnFirstModel: false })
    expect(parseModelRouterSettings({ stayOnFirstModel: true, newThreads: true, other: 1 })).toEqual({ stayOnFirstModel: true, newThreads: true })
    expect(parseModelRouterSettings({ stayOnFirstModel: 'yes', newThreads: false })).toEqual({ stayOnFirstModel: false })
  })
})
