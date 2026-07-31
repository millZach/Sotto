import { describe, expect, it, vi } from 'vitest'

import { QUALITY_TIERS, TranscriptPolishService } from '../../../src/main/llm/transcriptPolishService'
import { buildPolishSystemPrompt, parseDictionary } from '../../../src/main/llm/prompt'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'

const ENABLED: AppSettings = {
  ...DEFAULT_SETTINGS,
  llmFormatting: true,
  llmApiKey: 'sk-or-v1-test',
}

function okResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
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

  it('polishes with the configured primary model', async () => {
    const { fetchFn, service } = createService({})
    await expect(service.polish('um hello there my good friend')).resolves.toEqual({
      text: 'Polished text.',
      applied: true,
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { model: string }
    expect(body.model).toBe(QUALITY_TIERS.low.primary.id)
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
    const [, init] = fetchFn.mock.calls[1] as [string, RequestInit]
    expect((JSON.parse(init.body as string) as { model: string }).model).toBe(
      QUALITY_TIERS.low.fallback.id,
    )
  })

  it('routes each quality tier to its benchmark-selected primary model', async () => {
    for (const [quality, expected] of [
      ['low', 'inception/mercury-2'],
      ['medium', 'amazon/nova-2-lite-v1'],
      ['high', 'anthropic/claude-haiku-4.5'],
    ] as const) {
      const { fetchFn, service } = createService({
        settings: { ...ENABLED, llmQuality: quality },
      })
      await expect(service.polish('um hello there my good friend')).resolves.toEqual({
        text: 'Polished text.',
        applied: true,
      })
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
      expect((JSON.parse(init.body as string) as { model: string }).model).toBe(expected)
    }
  })

  it('extends the deadline floor for the slower high tier', async () => {
    let clock = 0
    const { fetchFn, service } = createService({
      settings: { ...ENABLED, llmQuality: 'high' },
      now: () => clock,
      fetchFn: async () => {
        // Slower than the user deadline, but within the high tier's floor:
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

  it('returns the raw transcript when the deadline leaves no fallback budget', async () => {
    let clock = 0
    const { fetchFn, service } = createService({
      now: () => clock,
      fetchFn: async () => {
        clock += DEFAULT_SETTINGS.llmTimeoutMs
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
    await service.polish(longInput)
    expect(diagnostics).toEqual([
      {
        at: expect.any(Number),
        inputWords: 40,
        outputWords: null,
        applied: false,
        rejectedShrink: true,
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
