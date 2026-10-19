import type { ProviderId } from './agents'

/**
 * The limits a provider's turn can stop at that Sotto names in its own words (`claudeTurnFailure.ts`), and how the
 * window tells one from a turn's error: by Sotto's own sentence for it, never by a provider's words.
 */

/** A Claude Code turn that stopped at a limit, as Sotto's own sentence for it says, with when the limit resets if it said. */
export interface LimitStop { readonly kind: 'usage' | 'spending'; readonly provider: ProviderId; readonly resetsAt?: string }

/** How Sotto's sentence for Claude Code's usage-limit stop begins. */
const CLAUDE_USAGE_LIMIT_LEAD = 'Claude Code has reached your plan’s usage limit, so this turn stopped.'
/** Claude Code's usage-limit stop in Sotto's words (`claudeTurnFailure.ts`), with when it resets if Claude Code said. */
export function claudeUsageLimitSentence(reset: string | undefined): string {
  return `${CLAUDE_USAGE_LIMIT_LEAD} Nothing in the thread was lost. ${reset ? `Send again after it resets at ${reset}.` : 'Send again once it resets; Claude Code shows when.'}`
}
export const CLAUDE_SPENDING_LIMIT_SENTENCE = 'Claude stopped this turn at the spending limit set in Claude Code. What it did so far is kept. Raise the limit in Claude Code, then send a message to carry on.'

/**
 * The limit a turn's error says it stopped at, read from Sotto's own sentences for those stops and never from a
 * provider's words. Undefined for any other error.
 */
export function limitStopOf(error: string | undefined): LimitStop | undefined {
  if (error === undefined) return undefined
  if (error === CLAUDE_SPENDING_LIMIT_SENTENCE) return { kind: 'spending', provider: 'claude' }
  if (!error.startsWith(CLAUDE_USAGE_LIMIT_LEAD)) return undefined
  const reset = /Send again after it resets at (.+)\.$/u.exec(error)?.[1]
  return { kind: 'usage', provider: 'claude', ...(reset ? { resetsAt: reset } : {}) }
}
