import type { TranscriptPolishResult } from '../../shared/contracts'
import type { AppSettings } from '../../shared/settings'
import { buildPolishSystemPrompt, buildPolishUserPrompt } from './prompt'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

/**
 * Every failure path returns the raw transcript unchanged: dictation must
 * never break or hang because the network or the model misbehaved. The
 * fallback model only runs when the primary failed fast enough to leave a
 * usable share of the overall deadline.
 */
const MIN_FALLBACK_BUDGET_MS = 500

/** A wildly longer or empty response is a misbehaving model, not a cleanup. */
const MAX_GROWTH_FACTOR = 4

export interface TranscriptPolishServiceDependencies {
  readonly getSettings: () => AppSettings | Promise<AppSettings>
  readonly fetchFn?: typeof fetch
  readonly now?: () => number
}

interface AttemptOutcome {
  readonly text: string | null
}

function countWords(text: string): number {
  return text.split(/\s+/u).filter((word) => word.length > 0).length
}

function acceptableOutput(input: string, output: string): boolean {
  if (output.length === 0) return false
  return output.length <= input.length * MAX_GROWTH_FACTOR + 200
}

function extractContent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const message = (choices[0] as { message?: { content?: unknown } }).message
  const content = message?.content
  return typeof content === 'string' ? content.trim() : null
}

export class TranscriptPolishService {
  private readonly fetchFn: typeof fetch
  private readonly now: () => number

  constructor(private readonly dependencies: TranscriptPolishServiceDependencies) {
    this.fetchFn = dependencies.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.now = dependencies.now ?? Date.now
  }

  async polish(text: string): Promise<TranscriptPolishResult> {
    const raw: TranscriptPolishResult = { text, applied: false }

    let settings: AppSettings
    try {
      settings = await this.dependencies.getSettings()
    } catch {
      return raw
    }
    if (!settings.llmFormatting || settings.llmApiKey.length === 0) return raw
    if (countWords(text) < settings.llmMinWords) return raw

    const deadline = this.now() + settings.llmTimeoutMs
    const primary = await this.attempt(settings, settings.llmModel, text, deadline)
    if (primary.text !== null) return { text: primary.text, applied: true }

    const fallbackModel = settings.llmFallbackModel
    if (fallbackModel.length === 0 || fallbackModel === settings.llmModel) return raw
    if (deadline - this.now() < MIN_FALLBACK_BUDGET_MS) return raw
    const fallback = await this.attempt(settings, fallbackModel, text, deadline)
    return fallback.text === null ? raw : { text: fallback.text, applied: true }
  }

  private async attempt(
    settings: AppSettings,
    model: string,
    text: string,
    deadline: number,
  ): Promise<AttemptOutcome> {
    const budget = deadline - this.now()
    if (budget <= 0) return { text: null }

    try {
      const response = await this.fetchFn(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.llmApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: buildPolishSystemPrompt(settings.llmDictionary) },
            { role: 'user', content: buildPolishUserPrompt(text) },
          ],
          max_tokens: 4_000,
          provider: { order: ['groq', 'cerebras'], allow_fallbacks: true },
        }),
        signal: AbortSignal.timeout(budget),
      })
      if (!response.ok) return { text: null }
      const content = extractContent(await response.json())
      if (content === null || !acceptableOutput(text, content)) return { text: null }
      return { text: content }
    } catch {
      return { text: null }
    }
  }
}
