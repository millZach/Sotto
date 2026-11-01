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

/** Kinds of change that can split across agents, but say nothing of size by themselves (ADR-0148, ADR-0172 decision 5). */
const CHANGES = [/\brewrite\b/iu, /\bmigrat/iu, /\brefactor/iu, /\bredesign/iu]
/** Kinds of enquiry: alone they may be one small question, but two together are research wide enough to split. */
const ENQUIRIES = [/\bresearch/iu, /\baudit/iu, /\bsurvey\b/iu, /\bcompare\b/iu, /\bexplore\b/iu]
/** Signs of size: the work starts from nothing, spans much of a codebase, or runs side by side. */
const SCOPE = [/\bbuild(?:ing)? out\b/iu, /\bfrom scratch\b/iu, /\boverhaul/iu, /\bend[- ]to[- ]end\b/iu, /\bin parallel\b/iu,
  /\b(?:across|throughout) the (?:app|codebase|code|repo|project)\b/iu, /\b(?:whole|entire) (?:app|codebase|code ?base|repo|project|system)\b/iu,
  /\b(?:every |all (?:the )?)(?:files?|pages?|screens?|components?|providers?|tests?|modules?|endpoints?|routes?)\b/iu]
/**
 * Five or more pieces to make side by side, after a verb that makes them ("build 20 mock-up directions"): it counts
 * twice. A bare count is not enough, so "Node 24" or "5 ideas for a name" is not this.
 */
const MANY_PIECES = /\b(?:build|make|design|draft|sketch|mock(?:\s|-)?up|prototype|create|generate|try|explore)\w*\s+(?:\w+\s+){0,2}(?:[5-9]|[1-9]\d{1,2})\s+(?:\w+\s+){0,3}(?:directions|variants|mock-?ups|prototypes|designs|concepts|approaches|alternatives)\b/iu
const LIST_ITEM = /^\s*(?:[-*•]|\d{1,2}[.)])\s+\S/u

/**
 * Whether a draft reads like work that splits across agents, which Ultracode runs as a team (ADR-0148, ADR-0172 decision
 * 5): two kinds of enquiry (research and compare, say), or a sign of size (a build-out, the whole app, every page, five
 * or more pieces to make, a list of three or more items) beside another sign of size, a kind of change or enquiry, or
 * more than 280 characters. Length counts only beside a sign of size, so one verb before pasted material is not enough.
 * Kept narrow, since Ultracode uses many more tokens.
 */
export function draftBroadWork(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 14) return false
  const count = (patterns: readonly RegExp[]): number => patterns.filter(pattern => pattern.test(trimmed)).length
  const enquiries = count(ENQUIRIES)
  const items = trimmed.split('\n').filter(line => LIST_ITEM.test(line)).length
  const scope = count(SCOPE) + (MANY_PIECES.test(trimmed) ? 2 : 0) + (items >= 3 ? 1 : 0)
  return enquiries >= 2 || scope > 0 && scope + count(CHANGES) + enquiries + (trimmed.length > 280 ? 1 : 0) >= 2
}

/**
 * The level a score suggests, as an index into `levels`, or null when it suggests nothing above `value`, the level set
 * ('' on the provider's default). It is measured from the model's own default: one level above it for a draft that
 * names hard work, runs to several lines or runs long, and two for one that does three of those. It suggests up only, so
 * it suggests nothing on the provider's default when the model names no default. Ultracode, a way of working rather
 * than more thought, is suggested only for `broad` work (`draftBroadWork`) on a model that offers it, in place of a level.
 */
export function suggestedEffortIndex(score: number, levels: readonly string[], value: string, defaultLevel: string | undefined, broad = false): number | null {
  if (broad && value !== ULTRACODE && levels.includes(ULTRACODE)) return levels.indexOf(ULTRACODE)
  const steps = score >= 3 ? 2 : score >= 1 ? 1 : 0
  const base = defaultLevel !== undefined && levels.includes(defaultLevel) ? levels.indexOf(defaultLevel) : -1
  const current = levels.includes(value) ? levels.indexOf(value) : base
  if (steps === 0 || current < 0 && base < 0) return null
  const top = levels.filter(level => level !== ULTRACODE).length - 1
  const index = Math.min(top, (base < 0 ? current : base) + steps)
  return index > current ? index : null
}
