// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MEASURE_SAMPLE, MEASURE_SAMPLE_WORDS, OwnCleanupMeasures, keptSample, measureOwnCleanup, ownCleanupMaxTokens, ownServerBudgetMs, pickFastest,
  requestOwnCleanup, resolveOwnCleanup, withoutThinking, type OwnCleanupResolution,
} from '../../../src/main/llm/ownServerCleanup'
import { CLEANUP_MODELS, OWN_SERVER_DIAGNOSTIC, TranscriptPolishService, type PolishDiagnostic } from '../../../src/main/llm/transcriptPolishService'
import type { OwnServer } from '../../../src/shared/ownModelServers'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'

const SAMPLE_CLEANED = 'I wanted to give you a quick update on the garden project. We finished the raised beds on Saturday, and the soil '
  + 'gets delivered on Wednesday morning. After that we still need to buy the tomato seedlings, pick up two bags of mulch and fix '
  + 'the gate latch by the shed. Honestly, I think we should be done by the end of the month if the weather holds.'

const SERVER: OwnServer = {
  id: 'own-sparks', name: 'Sparks', address: 'http://spark-head:8888/v1', keyed: false,
  models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context: 131_072, thinking: true, images: false }],
}
const CHOICE = { server: SERVER.id, model: 'deepseek-v4.1-flash' }
const TARGET = { address: SERVER.address, model: CHOICE.model }

function reply(content: string, finish = 'stop'): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
function bodyOf(fetchFn: { mock: { calls: unknown[][] } }, call: number): Record<string, unknown> {
  return JSON.parse((fetchFn.mock.calls[call]![1] as RequestInit).body as string) as Record<string, unknown>
}
function urlOf(fetchFn: { mock: { calls: unknown[][] } }, call: number): string {
  return fetchFn.mock.calls[call]![0] as string
}

describe('pickFastest', () => {
  it('takes the fastest candidate whose every try passed, by its fastest try', () => {
    expect(pickFastest([
      { thinking: 'plain', ms: [2_400, 2_100] },
      { thinking: 'off', ms: [450, 410] },
      { thinking: 'least', ms: [380, null] },
    ])).toEqual({ status: 'fastest', thinking: 'off', ms: 410 })
  })

  it('lets the candidate listed first win a tie', () => {
    expect(pickFastest([{ thinking: 'plain', ms: [500, 500] }, { thinking: 'off', ms: [500, 500] }])).toEqual({ status: 'fastest', thinking: 'plain', ms: 500 })
  })

  it('says none passed when every candidate failed a try', () => {
    expect(pickFastest([{ thinking: 'plain', ms: [null] }, { thinking: 'off', ms: [300, null] }, { thinking: 'least', ms: [] }])).toEqual({ status: 'none-passed' })
  })
})

describe('the measure sample', () => {
  it('is long enough for the shrink guard, so a reply cut in half fails it', async () => {
    expect(MEASURE_SAMPLE_WORDS).toBeGreaterThanOrEqual(40)
    const half = SAMPLE_CLEANED.split(' ').slice(0, Math.floor(MEASURE_SAMPLE_WORDS / 2) - 5).join(' ')
    const outcome = await requestOwnCleanup({
      fetchFn: async () => reply(half), target: TARGET, thinking: 'plain', text: MEASURE_SAMPLE, dictionary: '', signal: AbortSignal.timeout(1_000),
    })
    expect(outcome).toEqual({ text: null, reason: 'rejected-shrink' })
  })

  it('counts a cleanup that dropped the end of the sample as failed even under the shrink guard', () => {
    expect(keptSample(SAMPLE_CLEANED)).toBe(true)
    expect(keptSample(SAMPLE_CLEANED.replace(/ if the weather holds\.$/u, '.'))).toBe(false)
  })
})

describe('requestOwnCleanup', () => {
  it('asks the server’s chat completions endpoint with no key, at temperature 0, with a tight answer limit and the thinking setting', async () => {
    const fetchFn = vi.fn(async () => reply(SAMPLE_CLEANED))
    await expect(requestOwnCleanup({ fetchFn, target: TARGET, thinking: 'off', text: MEASURE_SAMPLE, dictionary: '', signal: AbortSignal.timeout(1_000) }))
      .resolves.toEqual({ text: SAMPLE_CLEANED, reason: 'ok' })
    expect(urlOf(fetchFn, 0)).toBe('http://spark-head:8888/v1/chat/completions')
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.headers).not.toHaveProperty('Authorization')
    expect(init.redirect).toBe('manual')
    const body = bodyOf(fetchFn, 0)
    expect(body).toMatchObject({ model: 'deepseek-v4.1-flash', temperature: 0, max_tokens: ownCleanupMaxTokens(MEASURE_SAMPLE_WORDS), chat_template_kwargs: { enable_thinking: false, thinking: false } })
    expect(body).not.toHaveProperty('reasoning')
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('sends the least effort for least and nothing about thinking for plain', async () => {
    const fetchFn = vi.fn(async () => reply(SAMPLE_CLEANED))
    await requestOwnCleanup({ fetchFn, target: TARGET, thinking: 'least', text: MEASURE_SAMPLE, dictionary: '', signal: AbortSignal.timeout(1_000) })
    await requestOwnCleanup({ fetchFn, target: TARGET, thinking: 'plain', text: MEASURE_SAMPLE, dictionary: '', signal: AbortSignal.timeout(1_000) })
    expect(bodyOf(fetchFn, 0)).toMatchObject({ reasoning_effort: 'low' })
    expect(bodyOf(fetchFn, 1)).not.toHaveProperty('reasoning_effort')
    expect(bodyOf(fetchFn, 1)).not.toHaveProperty('chat_template_kwargs')
  })

  it('takes off a closed think block and counts one that never closed as unfinished', async () => {
    expect(withoutThinking(`<think>tidy it</think>\n${SAMPLE_CLEANED}`)).toBe(SAMPLE_CLEANED)
    await expect(requestOwnCleanup({ fetchFn: async () => reply('<think>first I will'), target: TARGET, thinking: 'plain', text: MEASURE_SAMPLE, dictionary: '', signal: AbortSignal.timeout(1_000) }))
      .resolves.toEqual({ text: null, reason: 'unfinished' })
  })

  it('takes off thinking whose opening tag the chat template sent itself', () => {
    expect(withoutThinking(`The user wants a cleanup.</think>\n\n${SAMPLE_CLEANED}`)).toBe(SAMPLE_CLEANED)
    expect(withoutThinking(SAMPLE_CLEANED)).toBe(SAMPLE_CLEANED)
  })

  it('tells an answer that is not JSON from no answer at all', async () => {
    await expect(requestOwnCleanup({ fetchFn: async () => new Response('<html>proxy</html>', { status: 200 }), target: TARGET, thinking: 'plain', text: MEASURE_SAMPLE, dictionary: '', signal: AbortSignal.timeout(1_000) }))
      .resolves.toEqual({ text: null, reason: 'not-json' })
    await expect(measureOwnCleanup({ fetchFn: async () => new Response('<html>proxy</html>', { status: 200 }), target: TARGET }))
      .resolves.toEqual({ status: 'measured', tuning: { status: 'none-passed' } })
  })

  it('reads no more of an answer than the server check would', async () => {
    const huge = new Response('x', { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } })
    await expect(requestOwnCleanup({ fetchFn: async () => huge, target: TARGET, thinking: 'plain', text: MEASURE_SAMPLE, dictionary: '', signal: AbortSignal.timeout(1_000) }))
      .resolves.toEqual({ text: null, reason: 'oversized' })
  })

  it('counts an answer cut off at the limit as unfinished', async () => {
    await expect(requestOwnCleanup({ fetchFn: async () => reply(SAMPLE_CLEANED, 'length'), target: TARGET, thinking: 'least', text: MEASURE_SAMPLE, dictionary: '', signal: AbortSignal.timeout(1_000) }))
      .resolves.toEqual({ text: null, reason: 'unfinished' })
  })
})

describe('measureOwnCleanup', () => {
  it('rejects a candidate the server refuses or cuts short and keeps the fastest that passed', async () => {
    let clock = 0
    const times: Record<string, number> = { plain: 2_000, off: 400, least: 300 }
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      const thinking = 'chat_template_kwargs' in body ? 'off' : 'reasoning_effort' in body ? 'least' : 'plain'
      clock += times[thinking]!
      // Least effort still thinks and runs out of room under the tight limit.
      return thinking === 'least' ? reply('<think>The user wants', 'length') : reply(SAMPLE_CLEANED)
    })
    await expect(measureOwnCleanup({ fetchFn: fetchFn as unknown as typeof fetch, target: TARGET, now: () => clock }))
      .resolves.toEqual({ status: 'measured', tuning: { status: 'fastest', thinking: 'off', ms: 400 } })
    // Plain and off tried twice each, least stopped at its first failed try.
    expect(fetchFn).toHaveBeenCalledTimes(5)
  })

  it('decides nothing when the server never answered', async () => {
    const fetchFn = vi.fn(async () => { throw new TypeError('fetch failed') })
    await expect(measureOwnCleanup({ fetchFn, target: TARGET })).resolves.toEqual({ status: 'unreachable' })
  })

  it('says none passed when the server answers but every candidate fails', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 400 }))
    await expect(measureOwnCleanup({ fetchFn, target: TARGET })).resolves.toEqual({ status: 'measured', tuning: { status: 'none-passed' } })
  })
})

describe('resolveOwnCleanup', () => {
  it('finds the saved server and model with what was measured for them', () => {
    const tuning = { status: 'fastest', thinking: 'off', ms: 400 } as const
    expect(resolveOwnCleanup(CHOICE, [SERVER], [{ ...CHOICE, tuning }])).toEqual({ status: 'ready', target: TARGET, tuning })
  })

  it('says a removed server or model is gone and a server added with a key cannot clean up', () => {
    expect(resolveOwnCleanup(CHOICE, [], [])).toEqual({ status: 'gone' })
    expect(resolveOwnCleanup({ ...CHOICE, model: 'other' }, [SERVER], [])).toEqual({ status: 'gone' })
    expect(resolveOwnCleanup(CHOICE, [{ ...SERVER, keyed: true }], [])).toEqual({ status: 'keyed' })
  })
})

describe('ownServerBudgetMs', () => {
  it('gives a measured server three times its time, scaled to the transcript, never under 1.5 s', () => {
    const tuning = { status: 'fastest', thinking: 'off', ms: 400 } as const
    expect(ownServerBudgetMs(tuning, MEASURE_SAMPLE_WORDS)).toBe(1_500)
    expect(ownServerBudgetMs({ ...tuning, ms: 1_000 }, MEASURE_SAMPLE_WORDS)).toBe(3_000)
    expect(ownServerBudgetMs({ ...tuning, ms: 1_000 }, MEASURE_SAMPLE_WORDS * 4)).toBe(12_000)
    expect(ownServerBudgetMs(undefined, 100)).toBeUndefined()
    expect(ownServerBudgetMs({ status: 'none-passed' }, 100)).toBeUndefined()
  })
})

describe('OwnCleanupMeasures', () => {
  let directory: string | undefined
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

  it('keeps one measure per server and model, and refuses a server added with a key without asking it', async () => {
    directory = await mkdtemp(join(tmpdir(), 'sotto-own-cleanup-'))
    let servers: OwnServer[] = [SERVER]
    const fetchFn = vi.fn(async () => reply(SAMPLE_CLEANED))
    const measures = new OwnCleanupMeasures({ directory, servers: async () => servers, fetchFn })
    await expect(measures.measure(CHOICE)).resolves.toMatchObject({ status: 'measured', tuning: { status: 'fastest' } })
    await measures.measure(CHOICE)
    expect(await measures.measured()).toHaveLength(1)
    const reread = new OwnCleanupMeasures({ directory, servers: async () => servers, fetchFn })
    await expect(reread.resolve(CHOICE)).resolves.toMatchObject({ status: 'ready', tuning: { status: 'fastest' } })

    servers = [{ ...SERVER, keyed: true }]
    const calls = fetchFn.mock.calls.length
    await expect(measures.measure(CHOICE)).resolves.toEqual({ status: 'keyed' })
    await expect(measures.measure({ ...CHOICE, model: 'gone' })).resolves.toEqual({ status: 'not-found' })
    expect(fetchFn).toHaveBeenCalledTimes(calls)
  })
})

describe('TranscriptPolishService on the user’s own server', () => {
  const TEXT = 'um so the the build is green and we can ship it on friday after lunch if nobody objects'
  const SETTINGS: AppSettings = { ...DEFAULT_SETTINGS, llmFormatting: true, llmApiKey: 'sk-or-v1-test', llmOwnModel: CHOICE, llmMode: 'nitro' }

  function service(options: { resolution?: OwnCleanupResolution; fetchFn: (url: string, init: RequestInit) => Promise<Response>; now?: () => number; gated?: boolean }) {
    const fetchFn = vi.fn(options.fetchFn)
    const diagnostics: PolishDiagnostic[] = []
    const resolution: OwnCleanupResolution = options.resolution ?? { status: 'ready', target: TARGET, tuning: { status: 'fastest', thinking: 'off', ms: 400 } }
    const polish = new TranscriptPolishService({
      getSettings: () => SETTINGS,
      chosenModel: true,
      fetchFn: fetchFn as unknown as typeof fetch,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.gated === false ? {} : { ownServer: async () => resolution }),
      onDiagnostic: diagnostic => { diagnostics.push(diagnostic) },
    })
    return { polish, fetchFn, diagnostics }
  }

  it('cleans up on the server with the measured setting, and mode does not apply', async () => {
    const { polish, fetchFn, diagnostics } = service({ fetchFn: async () => reply('The build is green and we can ship it on Friday after lunch if nobody objects.') })
    await expect(polish.polish(TEXT)).resolves.toEqual({ text: 'The build is green and we can ship it on Friday after lunch if nobody objects.', applied: true })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(urlOf(fetchFn, 0)).toBe('http://spark-head:8888/v1/chat/completions')
    expect(bodyOf(fetchFn, 0)).toMatchObject({ model: 'deepseek-v4.1-flash', chat_template_kwargs: { enable_thinking: false } })
    expect(String(bodyOf(fetchFn, 0).model)).not.toContain(':nitro')
    // The diagnostic never names the server or its model.
    expect(diagnostics[0]).toMatchObject({ primaryModel: OWN_SERVER_DIAGNOSTIC, attempts: ['ok'] })
  })

  it('hands over to Mercury 2 on OpenRouter, unsuffixed, when the server fails', async () => {
    const { polish, fetchFn, diagnostics } = service({
      fetchFn: async url => url.startsWith('http://spark-head') ? new Response('{}', { status: 503 }) : reply('Mercury cleaned it up for Friday after lunch.'),
    })
    await expect(polish.polish(TEXT)).resolves.toEqual({ text: 'Mercury cleaned it up for Friday after lunch.', applied: true })
    expect(urlOf(fetchFn, 1)).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(bodyOf(fetchFn, 1).model).toBe(CLEANUP_MODELS.fallback.id)
    expect(diagnostics[0]?.attempts).toEqual(['http-503', 'ok'])
  })

  it.each([
    [{ status: 'gone' } as const, 'own-gone'],
    [{ status: 'keyed' } as const, 'own-keyed'],
    [{ status: 'ready', target: TARGET, tuning: { status: 'none-passed' } } as const, 'own-none-passed'],
  ])('goes straight to Mercury 2 when the choice cannot run (%o)', async (resolution, reason) => {
    const { polish, fetchFn, diagnostics } = service({ resolution, fetchFn: async () => reply('Mercury cleaned it up for Friday after lunch.') })
    await expect(polish.polish(TEXT)).resolves.toMatchObject({ applied: true })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(bodyOf(fetchFn, 0).model).toBe(CLEANUP_MODELS.fallback.id)
    expect(diagnostics[0]?.attempts).toEqual([reason, 'ok'])
  })

  it('ignores the saved choice while the feature is off', async () => {
    const { polish, fetchFn } = service({ gated: false, fetchFn: async () => reply('Haiku cleaned it up for Friday after lunch.') })
    await expect(polish.polish(TEXT)).resolves.toMatchObject({ applied: true })
    expect(urlOf(fetchFn, 0)).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(bodyOf(fetchFn, 0).model).toBe(`${CLEANUP_MODELS.primary.id}:nitro`)
  })
})
