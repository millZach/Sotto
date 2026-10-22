import type { AgentMessage } from '../../shared/agents'

/**
 * A history as windows and phones are shown it: without the wake-ups that carried only delegation news (ADR-0081, October
 * 19, 2026), which the host marks `hiddenWakeUp` from its own record of the send. The same array when there is none to
 * leave out. It makes a new array when there is, so the coordinator asks it only when the history changed, never on an
 * update of another thread (`streamingCopyBudget.perf.test.ts` counts the calls).
 */
export function withoutHiddenWakeUps(messages: readonly AgentMessage[]): readonly AgentMessage[] {
  return messages.some(message => message.hiddenWakeUp === true) ? messages.filter(message => message.hiddenWakeUp !== true) : messages
}

/**
 * Whether two plain values, a message and its parts, are equal all the way down, compared in place without making
 * anything: a publish hands the coordinator a new copy of every message, so identity alone cannot say one is unchanged.
 */
export function samePlainValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null || Array.isArray(left) !== Array.isArray(right)) return false
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  let keys = 0
  for (const key in a) {
    if (!Object.hasOwn(a, key)) continue
    keys++
    if (!Object.hasOwn(b, key) || !samePlainValue(a[key], b[key])) return false
  }
  for (const key in b) if (Object.hasOwn(b, key)) keys--
  return keys === 0
}
