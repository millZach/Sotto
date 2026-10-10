import { collapseRepeatedPhrases, countWords } from '../../shared/textRepair'

/**
 * What the cleanup pass accepts from a model. TranscriptPolishService applies it to every attempt, and
 * scripts/llm-bench/compare-cleanup.mjs applies the same rules, so a benchmark counts what the app would keep.
 */

/**
 * A cleanup the model did not finish is not a cleanup. One cut off at the
 * token limit drops the end of the dictation, and Haiku 5.5's safety
 * classifiers can decline a transcript outright, which OpenRouter reports as
 * a content filter. Either way the fallback gets its turn.
 */
const UNFINISHED_FINISH_REASONS: ReadonlySet<unknown> = new Set(['length', 'content_filter'])
const UNFINISHED_NATIVE_REASONS: ReadonlySet<unknown> = new Set(['max_tokens', 'refusal'])

/** A wildly longer or empty response is a misbehaving model, not a cleanup. */
const MAX_GROWTH_FACTOR = 4

/**
 * Cleanup legitimately shrinks text (fillers, self-corrections), but a long
 * transcript losing more than half its words is a truncating model, not a
 * cleanup. Short inputs are exempt: one resolved correction can halve them.
 */
const MIN_WORDS_FOR_SHRINK_GUARD = 20
const MAX_SHRINK_FACTOR = 0.5

export type OutputVerdict = 'ok' | 'rejected' | 'rejected-shrink'

export function assessOutput(input: string, output: string): OutputVerdict {
  if (output.length === 0) return 'rejected'
  if (output.length > input.length * MAX_GROWTH_FACTOR + 200) return 'rejected'
  // Hallucinated repetition loops inflate the raw word count; measuring
  // shrinkage against the collapsed count keeps legitimate cleanups of such
  // input from being rejected as truncation.
  const inputWords = countWords(collapseRepeatedPhrases(input))
  if (
    inputWords >= MIN_WORDS_FOR_SHRINK_GUARD &&
    countWords(output) < inputWords * MAX_SHRINK_FACTOR
  ) {
    return 'rejected-shrink'
  }
  return 'ok'
}

export interface CleanupChoice {
  readonly content: string | null
  readonly finished: boolean
}

/** The first choice of an OpenRouter chat completion, or null when the reply has none. */
export function readCleanupChoice(payload: unknown): CleanupChoice | null {
  if (typeof payload !== 'object' || payload === null) return null
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const choice = choices[0] as {
    message?: { content?: unknown }
    finish_reason?: unknown
    native_finish_reason?: unknown
  }
  const content = choice.message?.content
  return {
    content: typeof content === 'string' ? content.trim() : null,
    finished: !UNFINISHED_FINISH_REASONS.has(choice.finish_reason) &&
      !UNFINISHED_NATIVE_REASONS.has(choice.native_finish_reason),
  }
}
