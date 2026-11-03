// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { OpenRouterSpeechModels } from '../../../src/main/llm/openRouterSpeechModels'
import { deferred } from '../../fixtures/deferred'

const speechList = {
  data: [
    { id: 'qwen/qwen3-asr-1.7b', name: 'Qwen: Qwen3-ASR 1.7B', architecture: { output_modalities: ['transcription'] }, pricing: { prompt: '0.0000075' } },
    { id: 'openai/gpt-transcribe', name: 'OpenAI: GPT Transcribe', architecture: { output_modalities: ['transcription'] }, pricing: { prompt: '0.000075' } },
    { id: 'microsoft/mai-transcribe-2', name: 'Microsoft: MAI-Transcribe-2', architecture: { output_modalities: ['transcription'] }, pricing: { prompt: '0.1' } },
    { id: 'someone/new-speech-model', name: 'Someone: New Speech Model', architecture: { output_modalities: ['transcription'] }, pricing: { prompt: '0.000005' } },
    { id: 'google/gemini-embedding-2', name: 'Google: Gemini Embedding 2', architecture: { output_modalities: ['embeddings'] }, pricing: { prompt: '0.0000002' } },
    { id: 'not a slug!', name: 'Broken', architecture: { output_modalities: ['transcription'] } },
  ],
}
const zdrList = { data: [{ model_id: 'microsoft/mai-transcribe-2' }, { model_id: 'qwen/qwen3-asr-1.7b' }] }

function fetchFor(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input) => Response.json(String(input).includes('/endpoints/zdr') ? zdrList : speechList))
}

describe('OpenRouterSpeechModels', () => {
  it('reads both response bodies before either body finishes', async () => {
    const entered = deferred()
    const modelBody = deferred<unknown>()
    const models = Response.json(speechList)
    const zdr = Response.json(zdrList)
    vi.spyOn(models, 'json').mockImplementation(() => { entered.resolve(); return modelBody.promise })
    const zdrJson = vi.spyOn(zdr, 'json')
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(models).mockResolvedValueOnce(zdr)
    const reader = new OpenRouterSpeechModels({ fetchFn })
    const reading = reader.list()
    await entered.promise
    const overlap = zdrJson.mock.calls.length
    modelBody.resolve(speechList)
    await expect(reading).resolves.toMatchObject({ ok: true })
    expect(overlap).toBe(1)
  })

  it('classifies a timeout without returning private error details', async () => {
    const reader = new OpenRouterSpeechModels({ fetchFn: vi.fn<typeof fetch>().mockRejectedValue(new DOMException('private details', 'TimeoutError')) })
    expect(await reader.list()).toEqual({ ok: false, reason: 'timeout' })
  })

  it('reads both public lists without a key and ranks the speech models, best first', async () => {
    const fetchFn = fetchFor()
    const reader = new OpenRouterSpeechModels({ fetchFn })
    const list = await reader.list()
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      'https://openrouter.ai/api/v1/models?output_modalities=transcription',
      'https://openrouter.ai/api/v1/endpoints/zdr',
    ])
    for (const [, options] of fetchFn.mock.calls) expect(new Headers(options?.headers).has('Authorization')).toBe(false)
    // Ranked by Sotto's blend; a model it has not tested comes last, priced only where OpenRouter's price is plainly per second.
    expect(list.ok && list.models.map((model) => model.id)).toEqual(['qwen/qwen3-asr-1.7b', 'microsoft/mai-transcribe-2', 'openai/gpt-transcribe', 'someone/new-speech-model'])
    expect(list.ok && list.models[1]).toEqual({
      id: 'microsoft/mai-transcribe-2', name: 'MAI-Transcribe-2', maker: 'Microsoft', zdr: true,
      wer: 0.0437, medianMs: 1083, usdPerHour: 0.1, scoredBy: 'sotto',
    })
    expect(list.ok && list.models[3]).toMatchObject({ name: 'New Speech Model', zdr: false, wer: null, medianMs: null, usdPerHour: 0.018, scoredBy: null })
    // With nothing picked, dictation uses MAI-Transcribe-2 while OpenRouter lists it, whatever ranks first.
    expect(reader.defaultModel()).toBe('microsoft/mai-transcribe-2')
    expect(reader.zeroRetention('openai/gpt-transcribe')).toBe(false)
    expect(reader.zeroRetention('qwen/qwen3-asr-1.7b')).toBe(true)
    // A model the list does not name cannot be told apart from one with a zero-retention host.
    expect(reader.zeroRetention('someone/unlisted')).toBeNull()
  })

  it('reads again only when asked for a fresh list or after ten minutes, and keeps the last good list when a read fails', async () => {
    let now = 0
    const log = vi.fn()
    const fetchFn = fetchFor()
    const reader = new OpenRouterSpeechModels({ fetchFn, now: () => now, log })
    await reader.list()
    await reader.list()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(reader.zeroRetention('openai/gpt-transcribe')).toBe(false)
    now = 11 * 60_000
    fetchFn.mockRejectedValue(new TypeError('offline'))
    expect((await reader.list()).ok).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(4)
    expect(log.mock.calls).toEqual([['openrouter-speech-models-network']])
    // A list older than ten minutes still says which models have a zero-retention host, but no longer that one has none.
    expect(reader.zeroRetention('qwen/qwen3-asr-1.7b')).toBe(true)
    expect(reader.zeroRetention('openai/gpt-transcribe')).toBeNull()
    // Sotto's own measurement that a model's zero-retention route is refused holds without any list.
    expect(new OpenRouterSpeechModels({ fetchFn }).zeroRetention('mistralai/voxtral-mini-transcribe')).toBe(false)
  })

  it.each([
    ['http', 'http', () => Promise.resolve(new Response('private details', { status: 503 }))],
    ['invalid-response', 'http', () => Promise.resolve(Response.json({ data: 'private malformed list' }))],
    ['invalid-response', 'network', () => Promise.resolve(new Response('private invalid JSON'))],
    ['network', 'network', () => Promise.reject(new TypeError('private network details'))],
    ['timeout', 'timeout', () => Promise.reject(new DOMException('private timeout details', 'TimeoutError'))],
  ] as const)('logs the %s speech catalog cause while preserving the %s result', async (cause, reason, fail) => {
    const log = vi.fn()
    const fetchFn = vi.fn<typeof fetch>(async url => String(url).includes('/endpoints/zdr') ? Response.json(zdrList) : fail())
    const reader = new OpenRouterSpeechModels({ fetchFn, log })
    expect(await reader.list()).toEqual({ ok: false, reason })
    expect(log.mock.calls).toEqual([[`openrouter-speech-models-${cause}`]])
  })

  it('says OpenRouter could not be reached when nothing was ever read', async () => {
    const reader = new OpenRouterSpeechModels({ fetchFn: vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline')) })
    expect(await reader.list()).toEqual({ ok: false, reason: 'network' })
    expect(reader.defaultModel()).toBeNull()
    expect(reader.zeroRetention('microsoft/mai-transcribe-2')).toBeNull()
    const refused = new OpenRouterSpeechModels({ fetchFn: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 })) })
    expect(await refused.list()).toEqual({ ok: false, reason: 'http' })
  })
})

describe('the ranking Sotto ships', () => {
  it('ranks by words wrong plus one point a second, and marks a zero-retention route OpenRouter refused', async () => {
    const { CLOUD_SPEECH_SCORES, cloudSpeechRank, rankCloudSpeechModels, cloudSpeechHints } = await import('../../../src/shared/cloudSpeechModels')
    expect(cloudSpeechRank({ wer: 0.03, medianMs: 1_500 })).toBeCloseTo(0.045)
    const ranked = rankCloudSpeechModels(Object.keys(CLOUD_SPEECH_SCORES).map((id) => ({ id, name: id, promptPrice: null, zdr: true })))
    const ranks = ranked.map((model) => cloudSpeechRank(CLOUD_SPEECH_SCORES[model.id]!))
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(ranked.find((model) => model.id === 'mistralai/voxtral-mini-transcribe')?.zdr).toBe(false)
    expect(cloudSpeechHints('microsoft/mai-transcribe-2')).toBe('azure-phrase-list')
    expect(cloudSpeechHints('qwen/qwen3-asr-1.7b')).toBeNull()
    expect(cloudSpeechHints('someone/new-speech-model')).toBe('keyterms')
    const { defaultCloudSpeechModel } = await import('../../../src/shared/cloudSpeechModels')
    expect(defaultCloudSpeechModel(ranked)).toBe('microsoft/mai-transcribe-2')
    expect(defaultCloudSpeechModel(ranked.filter((model) => model.id !== 'microsoft/mai-transcribe-2'))).toBe(ranked[0]!.id)
    expect(defaultCloudSpeechModel([])).toBeNull()
  })
})
