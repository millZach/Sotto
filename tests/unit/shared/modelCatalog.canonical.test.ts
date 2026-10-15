// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { publicProviderEntityId } from '../../../src/shared/agents'
import { canonicalModelId, servedModelName } from '../../../src/shared/modelCatalog'

describe('one spelling per served model', () => {
  it.each([
    ['claude', 'claude-opus-5-5', 'claude-opus-5-5'],
    ['claude', publicProviderEntityId('claude', 'model', 'claude-opus-5-5'), 'claude-opus-5-5'],
    ['claude', publicProviderEntityId('claude', 'model', 'claude-opus-5-5[1m]'), 'claude-opus-5-5'],
    ['claude', 'native:claude:model:claude-opus-5-5[1m]', 'claude-opus-5-5'],
    ['claude', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
    ['claude', 'claude-opus-4-1@20250805', 'claude-opus-4-1'],
    ['claude', 'us.anthropic.claude-opus-5-5-v1:0', 'claude-opus-5-5'],
    ['claude', 'anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5'],
    ['claude', 'Claude-Opus-5-5', 'claude-opus-5-5'],
    ['codex', publicProviderEntityId('codex', 'model', 'gpt-6.1-sol'), 'gpt-6.1-sol'],
    ['codex', 'gpt-5-2025-08-07', 'gpt-5'],
    ['codex', 'codex-auto-review', 'codex-auto-review'],
    ['grok', 'native:grok:model:unknown', 'unknown'],
    ['grok', 'grok-4.7-build-fast', 'grok-4.7-build-fast'],
  ])('%s %s counts as %s', (provider, modelId, canonical) => {
    expect(canonicalModelId(provider, modelId)).toBe(canonical)
    // A canonical ID is its own canonical ID, so counting by it twice never splits a row.
    expect(canonicalModelId(provider, canonical)).toBe(canonical)
  })

  it('leaves an alias as the selection it is, since only a provider report says what it served', () => {
    expect(canonicalModelId('claude', publicProviderEntityId('claude', 'model', 'opus'))).toBe('opus')
    expect(canonicalModelId('claude', publicProviderEntityId('claude', 'model', 'opus[1m]'))).toBe('opus')
    expect(canonicalModelId('claude', 'sonnet')).toBe('sonnet')
  })

  it('keeps dated suffixes that are not the provider own spelling', () => {
    // Claude dates are eight digits; Codex dates are ISO. Neither rule strips the other's.
    expect(canonicalModelId('codex', 'model-20250929')).toBe('model-20250929')
    expect(canonicalModelId('claude', 'model-2025-08-07')).toBe('model-2025-08-07')
  })

  it('reads a missing name as unknown rather than an empty ID', () => {
    expect(canonicalModelId('claude', '')).toBe('unknown')
    expect(canonicalModelId('codex', '   ')).toBe('unknown')
    expect(canonicalModelId('codex', 'native:codex:model:')).toBe('unknown')
  })
})

describe('a served model name when no catalog lists it', () => {
  it.each([
    ['claude', 'claude-opus-5-5', 'Claude Opus 5.5'],
    ['claude', 'claude-opus-5', 'Claude Opus 5'],
    ['claude', 'claude-fable-5-1', 'Claude Fable 5.1'],
    ['claude', 'native:claude:model:claude-sonnet-5-5[1m]', 'Claude Sonnet 5.5'],
    ['claude', 'us.anthropic.claude-haiku-4-5-20251001-v1:0', 'Claude Haiku 4.5'],
    ['claude', 'opus', 'Opus'],
    ['codex', 'gpt-6.1-sol', 'GPT-6.1 Sol'],
    ['codex', 'gpt-6-astra', 'GPT-6 Astra'],
    ['codex', 'gpt-5.1-codex-mini', 'GPT-5.1 Codex Mini'],
    ['codex', 'codex-auto-review', 'Codex auto review'],
    ['grok', 'grok-4.7-build-fast', 'Grok 4.7 build fast'],
    ['grok', 'unknown', 'Model not reported'],
    ['codex', '', 'Model not reported'],
  ])('%s %s reads %s', (provider, modelId, name) => {
    expect(servedModelName(provider, modelId)).toBe(name)
  })

  it('gives every spelling of one served model the same name', () => {
    const names = ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-opus-5-5-20260922', publicProviderEntityId('claude', 'model', 'claude-opus-5-5')]
      .map(id => servedModelName('claude', id))
    expect(new Set(names)).toEqual(new Set(['Claude Opus 5.5']))
  })
})
