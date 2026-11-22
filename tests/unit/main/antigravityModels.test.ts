import { describe, expect, it } from 'vitest'
import { antigravityCatalog, antigravityGeminiModel, antigravityModelChoices } from '../../../src/main/agents/antigravityModels'

/** The model option agy 1.5.13 sent for an AI Ultra account on November 21, 2026, IDs and names as it listed them. */
const ACCOUNT = { configOptions: [{ id: 'model', currentValue: 'gemini-3.8-flash', options: [
  { value: 'gemini-4-neon', name: 'Gemini 4 Neon' }, { value: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)' },
  { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }, { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
] }] }

describe('Antigravity’s models under Google’s terms (ADR-0212)', () => {
  it('keeps the account’s Gemini models and leaves out its Claude and GPT ones', () => {
    expect(antigravityModelChoices(ACCOUNT).map(choice => choice.id)).toEqual(['gemini-4-neon', 'gemini-pro-orchestrator', 'gemini-3.8-flash'])
    expect(['gemini-4-neon', 'Gemini-3.8-flash', ' gemini-pro-orchestrator'].every(antigravityGeminiModel)).toBe(true)
    expect(['claude-opus-5-5', 'gpt-oss-120b-medium', 'geminiish', ''].some(antigravityGeminiModel)).toBe(false)
  })

  it('lists them as one list with no maker, and never a model of another maker handed in', () => {
    const catalog = antigravityCatalog([{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }, { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
      { images: true, offersAuto: true, current: 'gemini-3.8-flash' })
    expect(catalog.map(entry => [entry.model.id, entry.model.source, entry.model.recommended])).toEqual([['gemini-3.8-flash', undefined, true]])
  })
})
