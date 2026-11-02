import { ULTRACODE } from './ultracode'

/**
 * Whether a thread set to `level` is at its model's top effort, where the composer's trace lights (ADR-0019, amended
 * October 26 and November 1). `levels` are the ones the effort control offers, least thorough first. The top is the last
 * of them, whatever the provider, and on Claude Max stays lit with Ultracode past it ("the highest effort for any
 * provider, and for claude max and ultracode", Zach, November 1). A model that reports one level has no top, so a lone
 * Max is not lit either. The iPhone keeps the same rule (`EffortWords.isTop`).
 */
export function isTopEffort(levels: readonly string[], level: string): boolean {
  if (levels.length < 2 || level === '') return false
  return levels[levels.length - 1] === level || (level === 'max' && levels.includes(ULTRACODE))
}
