// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { cursorCatalog, cursorEffortOption, cursorModeArguments, cursorModelListSchema, cursorModelMaker, cursorRuntimeMode, leastEffort } from '../../../src/main/agents/cursorModels'

const select = (id: string, category: string, currentValue: string, values: string[]) => ({ id, category, currentValue, type: 'select', options: values.map(value => ({ value, name: value })) })

describe('Cursor’s model makers', () => {
  it('reads each maker from the model’s name, and puts the rest under Cursor', () => {
    const makers = Object.fromEntries(['default', 'composer-2.5', 'claude-opus-5-5', 'claude-haiku-4-5', 'gpt-5.5', 'gpt-5.3-codex', 'o3', 'gemini-3.1-pro', 'grok-4.7',
      'kimi-k3', 'glm-5p3-flash', 'muse-spark-1.3', 'mystery-1'].map(id => [id, cursorModelMaker(id)]))
    expect(makers).toEqual({ default: 'Cursor', 'composer-2.5': 'Cursor', 'claude-opus-5-5': 'Anthropic', 'claude-haiku-4-5': 'Anthropic', 'gpt-5.5': 'OpenAI', 'gpt-5.3-codex': 'OpenAI',
      o3: 'OpenAI', 'gemini-3.1-pro': 'Google', 'grok-4.7': 'xAI', 'kimi-k3': 'Moonshot', 'glm-5p3-flash': 'Z.ai', 'muse-spark-1.3': 'Meta', 'mystery-1': 'Cursor' })
  })
})

describe('Cursor’s effort options', () => {
  it('takes the thought-level option whose values are efforts, whatever Cursor names it, in Sotto’s order', () => {
    expect(cursorEffortOption([select('reasoning', 'thought_level', 'medium', ['none', 'low', 'medium', 'high', 'extra-high'])]))
      .toEqual({ id: 'reasoning', levels: ['none', 'low', 'medium', 'high', 'extra-high'], current: 'medium' })
    expect(cursorEffortOption([select('reasoning_effort', 'thought_level', 'high', ['xhigh', 'high', 'medium', 'low'])]))
      .toEqual({ id: 'reasoning_effort', levels: ['low', 'medium', 'high', 'xhigh'], current: 'high' })
  })
  it('passes over an on-off thinking option and every model setting', () => {
    expect(cursorEffortOption([select('thinking', 'thought_level', 'true', ['false', 'true']), select('context', 'model_config', '300k', ['300k', '1m']),
      select('effort', 'thought_level', 'high', ['low', 'medium', 'high', 'max'])])).toEqual({ id: 'effort', levels: ['low', 'medium', 'high', 'max'], current: 'high' })
    expect(cursorEffortOption([select('thinking', 'thought_level', 'true', ['false', 'true'])])).toBeUndefined()
    expect(cursorEffortOption([select('fast', 'model_config', 'true', ['false', 'true'])])).toBeUndefined()
  })
})

describe('Cursor’s catalog', () => {
  const list = cursorModelListSchema.parse({ models: [
    { value: 'default', name: 'Auto', configOptions: [] },
    { value: 'grok-4.7', name: 'Grok 4.7', configOptions: [select('reasoning_effort', 'thought_level', 'high', ['low', 'medium', 'high', 'xhigh'])] },
    { value: 'composer-2.5', name: 'Composer 2.5', configOptions: [select('fast', 'model_config', 'true', ['false', 'true'])] },
    { value: 'claude-opus-5-5', name: 'Claude Opus 5.5', configOptions: [select('effort', 'thought_level', 'medium', ['low', 'medium', 'high', 'xhigh', 'max'])] },
    { value: 'gpt-5.4-nano', name: 'GPT-5.4 Nano', configOptions: [select('reasoning', 'thought_level', 'medium', ['none', 'low', 'medium', 'high', 'xhigh'])] },
    { value: 'kimi-k3', name: 'Kimi K3', configOptions: [] },
  ] })
  it('groups by maker in the menu’s order, Auto first, each model on Cursor and taking its permission modes', () => {
    const catalog = cursorCatalog(list, true)
    expect(catalog.map(entry => [entry.model.id, entry.model.source])).toEqual([['default', 'Cursor'], ['composer-2.5', 'Cursor'], ['claude-opus-5-5', 'Anthropic'],
      ['gpt-5.4-nano', 'OpenAI'], ['grok-4.7', 'xAI'], ['kimi-k3', 'Moonshot']])
    expect(catalog.every(entry => entry.model.provider === 'Cursor' && entry.model.supportsImages === true && entry.model.ready)).toBe(true)
    expect(catalog.find(entry => entry.model.id === 'gpt-5.4-nano')).toEqual({ effortOption: 'reasoning', model: expect.objectContaining({
      reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'medium', runtimeModes: ['approval-required', 'auto', 'full-access'] }) })
    expect(catalog.find(entry => entry.model.id === 'default')).toEqual({ model: expect.objectContaining({ reasoningEfforts: [] }) })
    expect(leastEffort(catalog.find(entry => entry.model.id === 'gpt-5.4-nano')!.model)).toBe('none')
  })
})

describe('Cursor’s permission modes', () => {
  it('runs Ask for approval in allowlist mode, Auto with Cursor’s auto-review, and Full access with force', () => {
    expect(cursorModeArguments('approval-required')).toEqual([])
    expect(cursorModeArguments('auto')).toEqual(['--auto-review'])
    expect(cursorModeArguments('full-access')).toEqual(['--force'])
  })
  it('starts Allow edits, or no mode at all, as Ask for approval', () => {
    expect(cursorRuntimeMode('auto-accept-edits')).toBe('approval-required')
    expect(cursorRuntimeMode(undefined)).toBe('approval-required')
    expect(cursorRuntimeMode('full-access')).toBe('full-access')
  })
})
