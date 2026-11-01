import { ULTRACODE } from '../../../shared/ultracode'

/**
 * How much thought a draft seems to ask for, read from its own words in the window (ADR-0161, ADR-0172). It only ever
 * suggests: the effort word offers the level, and nothing changes until the user presses it (ADR-0004). Nothing leaves
 * the computer for it.
 */
/** Each kind of hard work a draft may name, counted once however often or in whatever form it appears. */
const HARD_WORK = [/\brefactor/iu, /\bdebug/iu, /\binvestigat/iu, /\bwhy\b/iu, /\bredesign/iu, /\barchitect/iu, /\bmigrat/iu,
  /\broot cause\b/iu, /\brace condition/iu, /\bregression/iu, /\bflak[yi]/iu, /\bdeadlock/iu, /\bconcurren/iu, /\bperformance\b/iu,
  /\boptimi[sz]/iu, /\bsecurity\b/iu, /\baudit/iu, /\bend[- ]to[- ]end\b/iu, /\bentire\b/iu, /\bwhole (?:app|codebase|repo)\b/iu,
  /\bthorough/iu, /\bcomprehensive\b/iu, /\bbuggy\b/iu, /\bnot working\b/iu, /\bcrash/iu, /\bbroken\b/iu]

/** 0 for an ordinary draft, up to 5 for a long draft of several lines that names several kinds of hard work. */
export function draftEffortScore(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length < 14) return 0
  const named = HARD_WORK.filter(pattern => pattern.test(trimmed)).length
  const lines = trimmed.split('\n').filter(line => line.trim() !== '').length
  return Math.min(3, named) + (lines >= 3 ? 1 : 0) + (trimmed.length > 140 ? 1 : 0)
}

/**
 * The level a score suggests, as an index into `levels`, or null when it suggests nothing above `value`, the level set
 * ('' on the provider's default). It is measured from the model's own default: one level above it for a draft that
 * names hard work, runs to several lines or runs long, and two for one that does three of those. It suggests up only, so
 * it suggests nothing on the provider's default when the model names no default, and never Ultracode, which is a way of
 * working rather than more thought.
 */
export function suggestedEffortIndex(score: number, levels: readonly string[], value: string, defaultLevel: string | undefined): number | null {
  const steps = score >= 3 ? 2 : score >= 1 ? 1 : 0
  const base = defaultLevel !== undefined && levels.includes(defaultLevel) ? levels.indexOf(defaultLevel) : -1
  const current = levels.includes(value) ? levels.indexOf(value) : base
  if (steps === 0 || current < 0 && base < 0) return null
  const top = levels.filter(level => level !== ULTRACODE).length - 1
  const index = Math.min(top, (base < 0 ? current : base) + steps)
  return index > current ? index : null
}
