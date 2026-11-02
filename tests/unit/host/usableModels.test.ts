// @vitest-environment node
/**
 * The catalog a phone that accepts `usable-models` is sent (ADR-0028, November 1 part 2): ready models, and a model that
 * is not ready only while something names it. On the owner's laptop, 853 of 942 models were neither, 846 of them left by
 * Devin when it was no longer connected.
 */
import { describe, expect, it } from 'vitest'
import { usableModels } from '../../../src/host/usableModels'
import type { AgentModel } from '../../../src/shared/agents'

const model = (id: string, ready: boolean): AgentModel => ({ id, name: id, provider: 'Devin', providerId: 'devin', ready, reasoningEfforts: [], supportsImages: false })

describe('usable models', () => {
  it('keeps every ready model, and a model that is not ready only while something names it', () => {
    const models = [model('ready', true), model('gone', false), model('named', false), model('also-ready', true)]
    expect(usableModels(models, ['named', 'ready', undefined, 'unknown']).map(item => item.id)).toEqual(['ready', 'named', 'also-ready'])
    expect(usableModels(models, []).map(item => item.id)).toEqual(['ready', 'also-ready'])
  })

  it('hands back one array while the catalog and what names it are unchanged, so its revision stays put', () => {
    const models = [model('ready', true), model('gone', false), model('named', false)]
    const first = usableModels(models, ['named', 'ready'])
    expect(usableModels(models, ['ready', 'named', 'named'])).toBe(first)
    const without = usableModels(models, [])
    expect(without).not.toBe(first)
    expect(usableModels(models, ['named'])).toEqual(first)
  })

  it('hands back the catalog itself when every model is ready', () => {
    const models = [model('a', true), model('b', true)]
    expect(usableModels(models, [])).toBe(models)
  })
})
