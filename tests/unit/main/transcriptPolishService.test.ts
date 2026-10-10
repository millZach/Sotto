// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

import { CLEANUP_MODELS, TranscriptPolishService } from '../../../src/main/llm/transcriptPolishService'
import { buildPolishSystemPrompt } from '../../../src/main/llm/prompt'
import { parseDictionary } from '../../../src/shared/dictionary'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'

const ENABLED: AppSettings = {
  ...DEFAULT_SETTINGS,
  llmFormatting: true,
  llmApiKey: 'sk-or-v1-test',
}

function okResponse(content: string, finish: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content }, ...finish }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function requestBody(fetchFn: { mock: { calls: unknown[][] } }, call: number): Record<string, unknown> {
  const [, init] = fetchFn.mock.calls[call] as [string, RequestInit]
  return JSON.parse(init.body as string) as Record<string, unknown>
}

function createService(options: {
  settings?: AppSettings
  fetchFn?: typeof fetch
  now?: () => number
}) {
  const fetchFn = vi.fn(options.fetchFn ?? (async () => okResponse('Polished text.')))
  const service = new TranscriptPolishService({
    getSettings: () => options.settings ?? ENABLED,
    fetchFn,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { fetchFn, service }
}

describe('TranscriptPolishService', () => {
  it('returns the raw transcript without a request when formatting is disabled', async () => {
    const { fetchFn, service } = createService({
      settings: { ...ENABLED, llmFormatting: false },
    })
    await expect(service.polish('hello there my good friend')).resolves.toEqual({
      text: 'hello there my good friend',
      applied: false,
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('returns the raw transcript without a request when the API key is missing', async () => {
    const { fetchFn, service } = createService({ settings: { ...ENABLED, llmApiKey: '' } })
    await expect(service.polish('hello there my good friend')).resolves.toMatchObject({
      applied: false,
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('skips short utterances below the word threshold', async () => {
    const { fetchFn, service } = createService({})
    await expect(service.polish('yes sounds good')).resolves.toEqual({
      text: 'yes sounds good',
      applied: false,
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('polishes with the cleanup model', async () => {
    const { fetchFn, service } = createService({})
    await expect(service.polish('um hello there my good friend')).resolves.toEqual({
      text: 'Polished text.',
      applied: true,
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(requestBody(fetchFn, 0).model).toBe(CLEANUP_MODELS.primary.id)
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-or-v1-test',
    )
  })

  it('falls back to the secondary model when the primary fails fast', async () => {
    let call = 0
    const { fetchFn, service } = createService({
      fetchFn: async () =>
        call++ === 0 ? new Response('overloaded', { status: 500 }) : okResponse('Backup.'),
    })
    await expect(service.polish('um hello there my good friend')).resolves.toEqual({
      text: 'Backup.',
      applied: true,
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(requestBody(fetchFn, 1).model).toBe(CLEANUP_MODELS.fallback.id)
  })

  it('asks Claude Haiku 5.5 at low effort first and Mercury 2 with reasoning off second', async () => {
    const { fetchFn, service } = createService({
      fetchFn: async () => new Response('overloaded', { status: 500 }),
    })
    await service.polish('um hello there my good friend')
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(requestBody(fetchFn, 0)).toMatchObject({
      model: 'anthropic/claude-haiku-5.5',
      reasoning: { effort: 'low' },
    })
    expect(requestBody(fetchFn, 1)).toMatchObject({
      model: 'inception/mercury-2',
      reasoning: { enabled: false },
    })
  })

  it.each([
    ['cut off at the token limit', { finish_reason: 'length' }],
    ['declined by a content filter', { finish_reason: 'content_filter' }],
    ['refused by the provider', { finish_reason: 'stop', native_finish_reason: 'refusal' }],
  ])('treats an answer %s as unfinished and lets the fallback clean up', async (_label, finish) => {
    const diagnostics: unknown[] = []
    let call = 0
    const fetchFn = vi.fn(async () =>
      call++ === 0 ? okResponse('Um hello there', finish) : okResponse('Hello there, my good friend.'),
    )
    const service = new TranscriptPolishService({
      getSettings: () => ENABLED,
      fetchFn,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await expect(service.polish('um hello there my good friend')).resolves.toEqual({
      text: 'Hello there, my good friend.',
      applied: true,
    })
    expect(diagnostics[0]).toMatchObject({ attempts: ['unfinished', 'ok'] })
  })

  it('keeps a deadline floor above the default timeout for the cleanup model', async () => {
    let clock = 0
    const { fetchFn, service } = createService({
      now: () => clock,
      fetchFn: async () => {
        // Slower than the user deadline, but within the cleanup model's floor:
        // the fallback attempt must still be allowed to run.
        clock += DEFAULT_SETTINGS.llmTimeoutMs + 500
        return new Response('overloaded', { status: 500 })
      },
    })
    await expect(service.polish('um hello there my good friend')).resolves.toMatchObject({
      applied: false,
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('reserves fallback budget so a hung primary cannot starve the fallback', async () => {
    let clock = 0
    const diagnostics: unknown[] = []
    const fetchFn = vi.fn(async (): Promise<Response> => {
      if (fetchFn.mock.calls.length === 1) {
        // The primary consumes its entire reserved-slice budget and times out.
        clock += DEFAULT_SETTINGS.llmTimeoutMs - 1_200
        const timeout = new Error('The operation was aborted due to timeout')
        timeout.name = 'TimeoutError'
        throw timeout
      }
      clock += 400
      return okResponse('Backup cleaned text.')
    })
    const service = new TranscriptPolishService({
      getSettings: () => ENABLED,
      fetchFn,
      now: () => clock,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await expect(service.polish('um hello there my good friend')).resolves.toEqual({
      text: 'Backup cleaned text.',
      applied: true,
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(diagnostics[0]).toMatchObject({ applied: true, attempts: ['timeout', 'ok'] })
  })

  it('scales the deadline with transcript length so long dictations still get cleaned', async () => {
    // 190 words at ~30 ms/word: the measured 5-6 s primary latency on long
    // transcripts must not exhaust the deadline before the fallback runs.
    const longInput = Array.from({ length: 190 }, (_, i) => `word${i}`).join(' ')
    const polished = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ')
    let clock = 0
    const diagnostics: unknown[] = []
    const fetchFn = vi.fn(async (): Promise<Response> => {
      if (fetchFn.mock.calls.length === 1) {
        clock += 6_000
        const timeout = new Error('aborted due to timeout')
        timeout.name = 'TimeoutError'
        throw timeout
      }
      clock += 2_000
      return okResponse(polished)
    })
    const service = new TranscriptPolishService({
      getSettings: () => ENABLED,
      fetchFn,
      now: () => clock,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await expect(service.polish(longInput)).resolves.toEqual({
      text: polished,
      applied: true,
    })
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(diagnostics[0]).toMatchObject({ attempts: ['timeout', 'ok'] })
  })

  it('returns the raw transcript when the deadline leaves no fallback budget', async () => {
    let clock = 0
    const { fetchFn, service } = createService({
      now: () => clock,
      fetchFn: async () => {
        // Overrun the entire deadline (floor plus length budget).
        clock += 20_000
        throw new Error('timed out')
      },
    })
    await expect(service.polish('um hello there my good friend')).resolves.toMatchObject({
      applied: false,
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('rejects unusable model output and keeps the raw transcript', async () => {
    const { service } = createService({
      fetchFn: async () => okResponse(''),
    })
    await expect(service.polish('um hello there my good friend')).resolves.toEqual({
      text: 'um hello there my good friend',
      applied: false,
    })
  })

  it('rejects an output that lost more than half the words of a long transcript', async () => {
    const longInput = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
    const { fetchFn, service } = createService({
      fetchFn: async () => okResponse('Only a few words survived here.'),
    })
    await expect(service.polish(longInput)).resolves.toEqual({
      text: longInput,
      applied: false,
    })
    // The truncated primary output is rejected and the fallback still runs.
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('accepts normal cleanup shrinkage on long transcripts', async () => {
    const longInput = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
    const polished = Array.from({ length: 24 }, (_, i) => `word${i}`).join(' ')
    const { service } = createService({ fetchFn: async () => okResponse(polished) })
    await expect(service.polish(longInput)).resolves.toEqual({
      text: polished,
      applied: true,
    })
  })

  it('measures shrinkage against the collapsed input when ASR repeated itself', async () => {
    // 21 real words + a hallucinated repetition loop: the raw count (51) would
    // reject a legitimate cleanup, the collapsed count (22) must not.
    const realWords = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ')
    const longInput = `${realWords} wait ${'no, '.repeat(29)}no`
    const polished = Array.from({ length: 15 }, (_, i) => `word${i}`).join(' ')
    const { service } = createService({ fetchFn: async () => okResponse(polished) })
    await expect(service.polish(longInput)).resolves.toEqual({
      text: polished,
      applied: true,
    })
  })

  it('allows aggressive shrinkage on short transcripts', async () => {
    const { service } = createService({ fetchFn: async () => okResponse('Meet at 4.') })
    await expect(service.polish('meet at 3 no wait make that 4 instead okay')).resolves.toEqual({
      text: 'Meet at 4.',
      applied: true,
    })
  })

  it('reports word-count diagnostics without transcript content', async () => {
    const diagnostics: unknown[] = []
    const longInput = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
    const fetchFn = vi.fn(async () => okResponse('Only a few words survived here.'))
    const service = new TranscriptPolishService({
      getSettings: () => ENABLED,
      fetchFn,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    })
    await service.polish(longInput, { segmentWords: [25, 15], durationMs: 42_000 })
    expect(diagnostics).toEqual([
      {
        at: expect.any(Number),
        inputWords: 40,
        collapsedInputWords: 40,
        outputWords: null,
        applied: false,
        rejectedShrink: true,
        attempts: ['rejected-shrink', 'rejected-shrink'],
        asrSegmentWords: [25, 15],
        asrDurationMs: 42_000,
      },
    ])
    const serialized = JSON.stringify(diagnostics)
    expect(serialized).not.toContain('word0')
  })

  it('returns the raw transcript when settings are unavailable', async () => {
    const service = new TranscriptPolishService({
      getSettings: () => Promise.reject(new Error('store gone')),
      fetchFn: vi.fn(),
    })
    await expect(service.polish('hello there my good friend')).resolves.toMatchObject({
      applied: false,
    })
  })
})

describe('polish prompt', () => {
  it('parses one dictionary word per line, dropping blanks and duplicates', () => {
    expect(parseDictionary('Sotto\n\n  Moonshine \nSotto\n')).toEqual([
      'Sotto',
      'Moonshine',
    ])
  })

  it('mentions dictionary words only when present', () => {
    expect(buildPolishSystemPrompt('')).not.toContain('Words the speaker may use')
    expect(buildPolishSystemPrompt('Zache')).toContain('Zache')
  })
})
