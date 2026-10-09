import type { TranscriptPolishAsrContext, TranscriptPolishResult } from '../../shared/contracts'
import type { AppSettings } from '../../shared/settings'
import { collapseRepeatedPhrases, countWords } from '../../shared/textRepair'
import { assessOutput, readCleanupChoice } from './cleanupOutput'
import { buildPolishSystemPrompt, buildPolishUserPrompt } from './prompt'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

interface ModelSpec {
  readonly id: string
  /** OpenRouter unified reasoning param: false disables, a string sets effort. */
  readonly reasoning?: false | 'minimal' | 'low'
  /** Preferred provider order for models served by multiple hosts. */
  readonly provider?: readonly string[]
}

interface CleanupModels {
  readonly primary: ModelSpec
  readonly fallback: ModelSpec
  /**
   * The primary needs more headroom than the default deadline: Haiku's
   * first-token latency alone can eat most of 2.5 s. The user's llmTimeoutMs
   * still wins when it is larger.
   */
  readonly minTimeoutMs: number
}

/**
 * One model does every cleanup; the user only turns AI formatting on or off
 * (ADR-0065). Claude Haiku 5.5 made the fewest word errors in the 2026-10-09
 * benchmark (docs/perf/2026-10-09-cleanup-haiku-5-5.md) and spelled every
 * dictionary name right. At low effort it skipped thinking on every
 * benchmarked transcript, so it answers as fast as with thinking off without
 * the cleanup that thinking off once cut short. Mercury 2 answers in about a
 * third of the time, so it still fits after a primary that failed or ran long.
 *
 * The deadline floor is deliberately generous: measured provider latency
 * spikes (cold starts, evening congestion) exceeded the old 2.5-4.5 s floors
 * even on short transcripts, and a discarded late response means unformatted
 * output. A healthy model still returns well inside it; the floor only costs
 * time when the alternative was the fallback or the raw text anyway.
 */
export const CLEANUP_MODELS: CleanupModels = {
  primary: { id: 'anthropic/claude-haiku-5.5', reasoning: 'low' },
  fallback: { id: 'inception/mercury-2', reasoning: false },
  minTimeoutMs: 8_000,
}

/**
 * Every failure path returns the raw transcript unchanged: dictation must
 * never break or hang because the network or the model misbehaved. The
 * fallback model only runs when the primary failed fast enough to leave a
 * usable share of the overall deadline.
 */
const MIN_FALLBACK_BUDGET_MS = 500

/**
 * The primary attempt never gets the whole deadline: a cold-started or
 * overloaded primary that eats the full budget would starve the (reliably
 * fast) fallback and silently deliver the raw transcript. Every tier floor is
 * at least 2.5 s, so the primary always keeps 1.3 s or more for itself.
 */
const FALLBACK_RESERVE_MS = 1_200

/**
 * Cleanup must regenerate the whole transcript, so generation time grows with
 * its length and a fixed deadline silently abandons long dictations (measured:
 * ~190 words needs 3-6 s primary, ~2 s fallback). Both the total deadline and
 * the fallback's reserved slice scale with the word count; the waits stay
 * proportionally small next to the recording itself.
 */
const PER_WORD_BUDGET_MS = 30
const MAX_LENGTH_BUDGET_MS = 9_000
const PER_WORD_RESERVE_MS = 15
const MAX_FALLBACK_RESERVE_MS = 6_000

export interface PolishDiagnostic {
  readonly at: number
  readonly inputWords: number
  /** Input words after collapsing ASR repetition loops; the shrink-guard baseline. */
  readonly collapsedInputWords: number
  /** Words in the applied output, or null when the raw transcript was returned. */
  readonly outputWords: number | null
  readonly applied: boolean
  /** An attempt produced output rejected for excessive shrinkage. */
  readonly rejectedShrink: boolean
  /** Per-attempt outcome (primary first): 'ok', 'timeout', 'http-<status>', … */
  readonly attempts?: readonly string[]
  /** Per-segment ASR word counts, when the renderer supplied them. */
  readonly asrSegmentWords?: readonly number[]
  /** Per-segment audio RMS aligned with asrSegmentWords (silence vs lost speech). */
  readonly asrSegmentRms?: readonly number[]
  /** Full recording duration in milliseconds, when the renderer supplied it. */
  readonly asrDurationMs?: number
}

export interface TranscriptPolishServiceDependencies {
  readonly getSettings: () => AppSettings | Promise<AppSettings>
  readonly fetchFn?: typeof fetch
  readonly now?: () => number
  /** Local observability for silent formatting failures; must never throw into polish. */
  readonly onDiagnostic?: (diagnostic: PolishDiagnostic) => void
}

interface AttemptOutcome {
  readonly text: string | null
  readonly reason: string
  readonly rejectedShrink?: boolean
}

export class TranscriptPolishService {
  private readonly fetchFn: typeof fetch
  private readonly now: () => number

  constructor(private readonly dependencies: TranscriptPolishServiceDependencies) {
    this.fetchFn = dependencies.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.now = dependencies.now ?? Date.now
  }

  async polish(
    text: string,
    asr?: TranscriptPolishAsrContext,
  ): Promise<TranscriptPolishResult> {
    const raw: TranscriptPolishResult = { text, applied: false }

    let settings: AppSettings
    try {
      settings = await this.dependencies.getSettings()
    } catch {
      return raw
    }
    if (!settings.llmFormatting || settings.llmApiKey.length === 0) return raw
    if (countWords(text) < settings.llmMinWords) return raw

    const words = countWords(text)
    const lengthBudget = Math.min(MAX_LENGTH_BUDGET_MS, words * PER_WORD_BUDGET_MS)
    const reserve = Math.min(
      MAX_FALLBACK_RESERVE_MS,
      FALLBACK_RESERVE_MS + words * PER_WORD_RESERVE_MS,
    )
    const deadline =
      this.now() + Math.max(settings.llmTimeoutMs, CLEANUP_MODELS.minTimeoutMs) + lengthBudget
    const primary = await this.attempt(settings, CLEANUP_MODELS.primary, text, deadline - reserve)
    if (primary.text !== null) {
      return this.report(text, asr, { text: primary.text, applied: true }, primary)
    }

    if (deadline - this.now() < MIN_FALLBACK_BUDGET_MS) {
      return this.report(text, asr, raw, primary)
    }
    const fallback = await this.attempt(settings, CLEANUP_MODELS.fallback, text, deadline)
    return this.report(
      text,
      asr,
      fallback.text === null ? raw : { text: fallback.text, applied: true },
      primary,
      fallback,
    )
  }

  private report(
    input: string,
    asr: TranscriptPolishAsrContext | undefined,
    result: TranscriptPolishResult,
    ...attempts: readonly AttemptOutcome[]
  ): TranscriptPolishResult {
    try {
      this.dependencies.onDiagnostic?.({
        at: this.now(),
        inputWords: countWords(input),
        collapsedInputWords: countWords(collapseRepeatedPhrases(input)),
        outputWords: result.applied ? countWords(result.text) : null,
        applied: result.applied,
        rejectedShrink: attempts.some((attempt) => attempt.rejectedShrink === true),
        attempts: attempts.map((attempt) => attempt.reason),
        ...(asr === undefined
          ? {}
          : {
              asrSegmentWords: asr.segmentWords,
              ...(asr.segmentRms === undefined ? {} : { asrSegmentRms: asr.segmentRms }),
              asrDurationMs: asr.durationMs,
            }),
      })
    } catch {
      // Observability must never affect the polish result.
    }
    return result
  }

  private async attempt(
    settings: AppSettings,
    model: ModelSpec,
    text: string,
    deadline: number,
  ): Promise<AttemptOutcome> {
    const budget = deadline - this.now()
    if (budget <= 0) return { text: null, reason: 'skipped' }

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
      if (!response.ok) return { text: null, reason: `http-${response.status}` }
      const choice = readCleanupChoice(await response.json())
      if (choice?.finished === false) return { text: null, reason: 'unfinished' }
      const content = choice?.content ?? null
      if (content === null) return { text: null, reason: 'empty' }
      const verdict = assessOutput(text, content)
      if (verdict !== 'ok') {
        return { text: null, reason: verdict, rejectedShrink: verdict === 'rejected-shrink' }
      }
      return { text: content, reason: 'ok' }
    } catch (error) {
      const timedOut = error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')
      return { text: null, reason: timedOut ? 'timeout' : 'network' }
    }
  }
}
