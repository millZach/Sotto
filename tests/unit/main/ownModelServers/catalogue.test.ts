// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ModelCatalogue, parseCatalogue, confirmedEfforts, mergeModelFacts } from '../../../../src/main/ownModelServers/catalogue'
import { apiModel, readBoundedText } from '../../../../src/main/ownModelServers/check'
import { modelEfforts, ownServerSchema } from '../../../../src/shared/ownModelServers'

const model = { id: 'model', name: 'Model', context: 131072, thinking: true, images: false }
const listed = { name: 'Example', api: 'https://example.test/v1', npm: '@ai-sdk/openai-compatible', models: { model: {
  name: 'Catalogue name', reasoning: true, reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
  tool_call: true, modalities: { input: ['text', 'image'] }, limit: { context: 1000000, output: 8192 }, cost: { input: 3, output: 4, cache_read: 0.3 },
} } }

describe('the API catalogue and provider facts', () => {
  it('lists only compatible entries with an address, plus OpenRouter', () => {
    const result = parseCatalogue({ example: listed, missing: { ...listed, api: undefined }, native: { ...listed, npm: '@ai-sdk/anthropic' }, openrouter: { ...listed, npm: '@ai-sdk/openrouter' } })
    expect(result.map(provider => provider.id)).toEqual(['example', 'openrouter'])
  })
  it('reads Abliteration fields, per-token prices and an explicit zero defensively', () => {
    const found = apiModel({ id: 'model', display_name: 'API name', context_length: 262144, max_output_length: 512,
      input_modalities: ['text', 'image'], supported_features: ['reasoning', 'tools'], pricing: { prompt: '0.000003', completion: 0.000004, input_cache_read: 0 } })
    expect(found).toMatchObject({ name: 'API name', context: 262144, output: 512, images: true, thinking: true, tools: true, cost: { input: 3, output: 4, cacheRead: 0 } })
    expect(apiModel({ id: 'bad', context_length: 'oops', pricing: { prompt: '-1', completion: 'no' } }).cost).toBeUndefined()
  })
  it('reads OpenRouter limits, modalities and parameters', () => {
    expect(apiModel({ id: 'model', context_length: 128000, top_provider: { max_completion_tokens: 16000 }, architecture: { input_modalities: ['text'] }, supported_parameters: ['tools', 'reasoning'] }))
      .toMatchObject({ output: 16000, images: false, thinking: true, tools: true })
  })
  it('lets API values win for all facts, false and zero included', () => {
    const catalogued = parseCatalogue({ example: listed })[0]!.models.get('model')!
    const api = apiModel({ id: 'model', display_name: 'model', context_length: 262144, max_output_length: 32000, input_modalities: ['text'], supported_features: [], pricing: { prompt: 0 } })
    expect(mergeModelFacts(api, catalogued)).toMatchObject({ name: 'model', context: 262144, output: 32000, images: false, thinking: false, tools: false, cost: { input: 0, output: 4, cacheRead: 0.3 }, reasoningEfforts: [] })
  })
  it('does not invent effort levels and keeps old thinking records unchanged', () => {
    expect(confirmedEfforts([{ type: 'effort', values: ['high', 'max'] }])).toEqual(['high', 'max'])
    expect(confirmedEfforts([{ type: 'toggle' }])).toEqual(['none', 'default'])
    expect(mergeModelFacts({ id: 'missing', name: 'missing', context: undefined }, { id: 'missing', name: 'Catalogue', context: 128000 }).context).toBe(128000)
    expect(mergeModelFacts({ id: 'unknown', name: 'unknown' }).reasoningEfforts).toEqual(['default'])
    expect(mergeModelFacts({ id: 'off', name: 'off', thinking: false }).reasoningEfforts).toEqual([])
    const old = { id: 'own-test', name: 'Server', address: 'http://localhost/v1', keyed: false, models: [model] }
    expect(ownServerSchema.parse(old)).toEqual(old)
    expect(modelEfforts(ownServerSchema.parse(old).models[0]!)).toEqual(['low', 'medium', 'high'])
  })
  it('downloads once without credentials and retries a failure', async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response(JSON.stringify({ example: listed })))
    const catalogue = new ModelCatalogue(request)
    expect((await catalogue.load()).available).toBe(false)
    expect((await catalogue.load()).entries).toHaveLength(1)
    expect((await catalogue.load()).entries).toHaveLength(1)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1]![1]).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { accept: 'application/json' } })
  })
  it('bounds chunked replies without a content length', async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)); controller.close() } }))
    expect(await readBoundedText(response, 10)).toBeNull()
  })
})


it('keeps template entries discoverable and uses their metadata after the address is completed', async () => {
  const api = 'https://${ACCOUNT}.example.test/v1'
  const catalogue = new ModelCatalogue(async () => new Response(JSON.stringify({ templated: { ...listed, api } })))
  expect((await catalogue.load()).entries[0]!.api).toBe(api)
  expect(catalogue.provider('https://account.example.test/v1', 'templated')?.models.get('model')?.context).toBe(1000000)
})
