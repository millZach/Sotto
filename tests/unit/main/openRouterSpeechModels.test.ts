// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { OpenRouterSpeechModels } from '../../../src/main/llm/openRouterSpeechModels'

const speechList = {
  data: [
    { id: 'qwen/qwen3-asr-1.7b', name: 'Qwen: Qwen3-ASR 1.7B', architecture: { output_modalities: ['transcription'] }, pricing: { prompt: '0.0000075' } },
    { id: 'openai/gpt-transcribe', name: 'OpenAI: GPT Transcribe', architecture: { output_modalities: ['transcription'] }, pricing: { prompt: '0.000075' } },
    { id: 'microsoft/mai-transcribe-2', name: 'Microsoft: MAI-Transcribe-2', architecture: { output_modalities: ['transcription'] }, pricing: { prompt: '0.1' } },
    { id: 'google/gemini-embedding-2', name: 'Google: Gemini Embedding 2', architecture: { output_modalities: ['embeddings'] }, pricing: { prompt: '0.0000002' } },
    { id: 'not a slug!', name: 'Broken', architecture: { output_modalities: ['transcription'] } },
  ],
}
const zdrList = { data: [{ model_id: 'microsoft/mai-transcribe-2' }, { model_id: 'qwen/qwen3-asr-1.7b' }] }

function fetchFor(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input) => Response.json(String(input).includes('/endpoints/zdr') ? zdrList : speechList))
}

describe('OpenRouterSpeechModels', () => {
  it('reads both public lists without a key and ranks the speech models, best first', async () => {
    const fetchFn = fetchFor()
    const reader = new OpenRouterSpeechModels({ fetchFn })
    const list = await reader.list()
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      'https://openrouter.ai/api/v1/models?output_modalities=transcription',
      'https://openrouter.ai/api/v1/endpoints/zdr',
    ])
    for (const [, options] of fetchFn.mock.calls) expect(new Headers(options?.headers).has('Authorization')).toBe(false)
    expect(list.ok && list.models.map((model) => model.id)).toEqual(['microsoft/mai-transcribe-2', 'openai/gpt-transcribe', 'qwen/qwen3-asr-1.7b'])
    expect(list.ok && list.models[0]).toEqual({
      id: 'microsoft/mai-transcribe-2', name: 'MAI-Transcribe-2', maker: 'Microsoft', zdr: true,
      wer: 0.02, medianMs: null, usdPerHour: null, scoredBy: 'artificial-analysis',
    })
    // A price is shown only where it is plainly per second of audio.
    expect(list.ok && list.models[2]).toMatchObject({ name: 'Qwen3-ASR 1.7B', zdr: true, wer: null, usdPerHour: 0.027, scoredBy: null })
    expect(reader.best()).toBe('microsoft/mai-transcribe-2')
    expect(reader.hasZeroRetentionHost('openai/gpt-transcribe')).toBe(false)
    expect(reader.hasZeroRetentionHost('qwen/qwen3-asr-1.7b')).toBe(true)
  })

  it('reads again only when asked for a fresh list or after ten minutes, and keeps the last good list when a read fails', async () => {
    let now = 0
    const fetchFn = fetchFor()
    const reader = new OpenRouterSpeechModels({ fetchFn, now: () => now })
    await reader.list()
    await reader.list()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    now = 11 * 60_000
    fetchFn.mockRejectedValue(new TypeError('offline'))
    expect((await reader.list()).ok).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(4)
  })

  it('says OpenRouter could not be reached when nothing was ever read', async () => {
    const reader = new OpenRouterSpeechModels({ fetchFn: vi.fn<typeof fetch>().mockRejectedValue(new TypeError('offline')) })
    expect(await reader.list()).toEqual({ ok: false, reason: 'network' })
    expect(reader.best()).toBeNull()
    const refused = new OpenRouterSpeechModels({ fetchFn: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 })) })
    expect(await refused.list()).toEqual({ ok: false, reason: 'http' })
  })
})
