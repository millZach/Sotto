// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { deepseekCatalog, deepseekModelValue, deepseekSettingsOf } from '../../../src/main/agents/deepseekModels'
import { compareDeepSeekVersions, parseDeepSeekVersion } from '../../../src/main/agents/deepseekRpc'
import { deepseekPatch, deepseekRouteKeyVariable, deepseekRouteKeys, keylessServers } from '../../../src/main/ownModelServers/deepseekPatch'
import type { OwnServer } from '../../../src/shared/ownModelServers'

const SERVER: OwnServer = {
  id: 'own-abc123', name: 'Spark Cluster', address: 'http://spark-head.example:8888/v1', keyed: false,
  models: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', context: 1048576, thinking: true, images: true },
    { id: 'qwen-plain', name: 'Qwen Plain', context: 65536, output: 8192, thinking: false, images: false },
  ],
}
const KEYED: OwnServer = { id: 'own-keyed1', name: 'Keyed box', address: 'http://keyed.example/v1', keyed: true,
  models: [{ id: 'm', name: 'M', context: 32768, thinking: false, images: false }] }

describe('the DeepSeek Harness overlay (ADR-0138)', () => {
  it('declares one route per keyless server, disables the cloud adapters, and holds no key', () => {
    const patch = deepseekPatch([SERVER, KEYED])!
    expect(patch).toContain('"own-abc123"')
    expect(patch).not.toContain('own-keyed1')
    expect(patch).toContain('api: openai-completions')
    expect(patch).toContain('baseURL: "http://spark-head.example:8888/v1"')
    expect(patch).toContain(`apiKeyEnv: "${deepseekRouteKeyVariable(SERVER.id)}"`)
    expect(patch).not.toContain('sotto-no-key')
    expect(patch).toContain('- id: llm-deepseek\n  disabled: true')
    expect(patch).toContain('- id: llm-deepseek-account\n  disabled: true')
    // The ACP entry starts on the first keyless server's first model.
    expect(patch).toContain('provider: "own-abc123"\n    model: "deepseek-v4-flash"')
  })

  it('gives a thinking model its effort levels and a plain one none, with outputs Sotto derives the OpenCode way', () => {
    const patch = deepseekPatch([SERVER])!
    expect(patch).toContain('contextWindow: 1048576')
    // No saved output: a quarter of the context under the same 32,000-token cap OpenCode's block derives.
    expect(patch).toContain('maxTokens: 32000')
    expect(patch).toContain('maxTokens: 8192')
    expect(patch).toContain('reasoningEfforts:\n              off:\n              low: low\n              high: high\n              max: max')
    expect(patch).toContain('reasoningEfforts: false')
    // The DeepSeek thinking format only on the model that calls itself one, and images only where the record says so.
    expect(patch.match(/thinkingFormat: deepseek/g)).toHaveLength(1)
    expect(patch.match(/input: \[text, image\]/g)).toHaveLength(1)
    expect(patch.match(/input: \[text\]/g)).toHaveLength(1)
  })

  it('starts the ACP entry on the first model that reads images, since the harness takes images only from that default', () => {
    const plainFirst: OwnServer = { ...SERVER, models: [SERVER.models[1]!, SERVER.models[0]!] }
    const patch = deepseekPatch([plainFirst])!
    expect(patch).toContain('- id: acp\n  name: \'@deepseek-ai/dsh-acp\'\n  config:\n    provider: "own-abc123"\n    model: "deepseek-v4-flash"')
    expect(patch).toContain('- id: agent-default-model\n  name: \'@deepseek-ai/dsh-agent-default-model\'\n  config:\n    provider: "own-abc123"\n    model: "deepseek-v4-flash"')
    // With no model that reads images, the first model stays the default.
    const textOnly: OwnServer = { ...SERVER, models: [SERVER.models[1]!] }
    expect(deepseekPatch([textOnly])).toContain('provider: "own-abc123"\n    model: "qwen-plain"')
  })

  it('is undefined with no keyless server: there is no model a session could run', () => {
    expect(deepseekPatch([])).toBeUndefined()
    expect(deepseekPatch([KEYED])).toBeUndefined()
    expect(keylessServers([SERVER, KEYED])).toEqual([SERVER])
  })

  it('names one placeholder key variable per keyless server', () => {
    expect(deepseekRouteKeys([SERVER, KEYED])).toEqual({ SOTTO_OWN_OWN_ABC123_KEY: 'sotto-no-key' })
  })
})

describe('the DeepSeek Harness catalog and settings (ADR-0138)', () => {
  it('builds models from keyless servers only, grouped by server, with the three modes', () => {
    const catalog = deepseekCatalog([SERVER, KEYED])
    expect(catalog.map(model => model.id)).toEqual(['own-abc123/deepseek-v4-flash', 'own-abc123/qwen-plain'])
    expect(catalog[0]).toMatchObject({ provider: 'DeepSeek Harness', source: 'Spark Cluster', ready: true,
      reasoningEfforts: ['off', 'low', 'high', 'max'], defaultReasoningEffort: 'high',
      runtimeModes: ['approval-required', 'auto-accept-edits', 'full-access'] })
    expect(catalog[1]!.reasoningEfforts).toBeUndefined()
  })

  it('offers images only on a model whose record reads them, once the harness has advertised image prompts', () => {
    expect(deepseekCatalog([SERVER]).map(model => model.supportsImages)).toEqual([undefined, undefined])
    expect(deepseekCatalog([SERVER], false).map(model => model.supportsImages)).toEqual([undefined, undefined])
    expect(deepseekCatalog([SERVER], true).map(model => model.supportsImages)).toEqual([true, undefined])
  })

  it('encodes a model as the harness’s route pair, and reads a pair and an effort back', () => {
    expect(deepseekModelValue('own-abc123/deepseek-v4-flash')).toBe('["own-abc123","deepseek-v4-flash"]')
    expect(deepseekModelValue('plain-id')).toBeUndefined()
    expect(deepseekSettingsOf({ configOptions: [
      { id: 'model', currentValue: '["own-abc123","qwen-plain"]' },
      { id: 'reasoning_effort', currentValue: '' },
    ] })).toEqual({ model: 'own-abc123/qwen-plain', effort: undefined })
    expect(deepseekSettingsOf({ configOptions: [{ id: 'reasoning_effort', currentValue: 'max' }] }).effort).toBe('max')
    expect(deepseekSettingsOf({ configOptions: [{ id: 'model', currentValue: 'not-json' }] }).model).toBeUndefined()
    expect(deepseekSettingsOf(null)).toEqual({ model: undefined, effort: undefined })
  })
})

describe('DeepSeek Harness client versions', () => {
  it('orders release candidates before their release, and an unreadable version before every readable one', () => {
    expect(parseDeepSeekVersion('0.2.1-rc.2')).toBeDefined()
    expect(parseDeepSeekVersion('dsh 0.2.1')).toBeUndefined()
    expect(compareDeepSeekVersions('0.2.1-rc.2', '0.2.1-rc.2')).toBe(0)
    expect(compareDeepSeekVersions('0.2.1-rc.2', '0.2.1-rc.3')).toBeLessThan(0)
    expect(compareDeepSeekVersions('0.2.1', '0.2.1-rc.9')).toBeGreaterThan(0)
    expect(compareDeepSeekVersions('0.2.1-beta.3', '0.2.1-rc.2')).toBeLessThan(0)
    expect(compareDeepSeekVersions('0.2.1-alpha.9', '0.2.1-beta.1')).toBeLessThan(0)
    expect(compareDeepSeekVersions('0.1.0', '0.2.1-rc.2')).toBeLessThan(0)
    expect(compareDeepSeekVersions('unreadable', '0.2.1-rc.2')).toBeLessThan(0)
  })
})
