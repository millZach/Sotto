/**
 * Ultracode (ADR-0148): Claude Code's standing multi-agent workflow mode, offered as the effort level past Max on a
 * Claude model. To Sotto it is one more level, saved and shown the way any level is. To Claude Code it is a session
 * setting, `ultracode`, beside a real effort level that every agent in the workflow runs at, which the user picks in
 * Settings → Providers → Claude Code. Claude Code offers it on exactly the models that offer Extra high.
 */

/** The level's ID, as a thread saves it and the effort control shows it. Never sent to Claude Code as an effort. */
export const ULTRACODE = 'ultracode'
/** The levels Ultracode may run at underneath, least thorough first: Claude Code's own effort levels. */
export const ULTRACODE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type UltracodeEffort = typeof ULTRACODE_EFFORTS[number]
/** Claude Code's own choice: `--effort ultracode` runs Extra high. */
export const DEFAULT_ULTRACODE_EFFORT: UltracodeEffort = 'xhigh'

/** A Claude model's reported levels with Ultracode after them, where Claude Code offers it: on a model with Extra high. */
export function withUltracode(levels: readonly string[]): string[] {
  return levels.includes('xhigh') && !levels.includes(ULTRACODE) ? [...levels, ULTRACODE] : [...levels]
}

/** The levels with Ultracode left out: what an agent may start a thread on, and what a default may land on by position. */
export function withoutUltracode(levels: readonly string[]): string[] {
  return levels.filter(level => level !== ULTRACODE)
}

/**
 * The level Ultracode runs at on a model that offers these levels: the chosen one, else the nearest below it that the
 * model offers, else the lowest the model offers. Undefined only for a model with no levels at all.
 */
export function ultracodeRunsAt(levels: readonly string[], chosen: UltracodeEffort): UltracodeEffort | undefined {
  const offered = ULTRACODE_EFFORTS.filter(level => levels.includes(level))
  return offered.filter(level => ULTRACODE_EFFORTS.indexOf(level) <= ULTRACODE_EFFORTS.indexOf(chosen)).at(-1) ?? offered[0]
}
