import type { TranscriptPolishResult } from '../../shared/contracts'
import type { AppSettings, LlmQuality } from '../../shared/settings'
import { buildPolishSystemPrompt, buildPolishUserPrompt } from './prompt'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

interface ModelSpec {
  readonly id: string
  /** OpenRouter unified reasoning param: false disables, a string sets effort. */
  readonly reasoning?: false | 'minimal'
  /** Preferred provider order for models served by multiple hosts. */
  readonly provider?: readonly string[]
}

interface QualityTier {
  readonly primary: ModelSpec
  readonly fallback: ModelSpec
  /**
   * Slower tiers need more headroom than the default deadline: Haiku's
   * first-token latency alone can eat most of 2.5 s. The user's llmTimeoutMs
   * still wins when it is larger.
   */
  readonly minTimeoutMs: number
}

export const QUALITY_TIERS: Record<LlmQuality, QualityTier> = {
  low: {
    primary: { id: 'inception/mercury-2', reasoning: false },
    fallback: { id: 'google/gemini-3.1-flash-lite', reasoning: 'minimal' },
    minTimeoutMs: 2_500,
  },
  medium: {
    primary: { id: 'amazon/nova-2-lite-v1', reasoning: false },
    fallback: { id: 'google/gemini-3.1-flash-lite', reasoning: 'minimal' },
    minTimeoutMs: 3_500,
  },
  high: {
    primary: { id: 'anthropic/claude-haiku-4.5', reasoning: false },
    fallback: { id: 'amazon/nova-2-lite-v1', reasoning: false },
    minTimeoutMs: 4_500,
  },
}

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

    const tier = QUALITY_TIERS[settings.llmQuality]
    const deadline = this.now() + Math.max(settings.llmTimeoutMs, tier.minTimeoutMs)
    const primary = await this.attempt(settings, tier.primary, text, deadline)
    if (primary.text !== null) return { text: primary.text, applied: true }

    if (deadline - this.now() < MIN_FALLBACK_BUDGET_MS) return raw
    const fallback = await this.attempt(settings, tier.fallback, text, deadline)
    return fallback.text === null ? raw : { text: fallback.text, applied: true }
  }

  private async attempt(
    settings: AppSettings,
    model: ModelSpec,
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
          model: model.id,
          messages: [
            { role: 'system', content: buildPolishSystemPrompt(settings.llmDictionary) },
            { role: 'user', content: buildPolishUserPrompt(text) },
          ],
          max_tokens: 4_000,
          ...(model.reasoning === false
            ? { reasoning: { enabled: false } }
            : model.reasoning === undefined
              ? {}
              : { reasoning: { effort: model.reasoning } }),
          ...(model.provider === undefined
            ? {}
            : { provider: { order: model.provider, allow_fallbacks: true } }),
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
