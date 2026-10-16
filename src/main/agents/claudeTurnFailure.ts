import { claudeUsageLimitSentence, CLAUDE_SPENDING_LIMIT_SENTENCE } from '../../shared/limitStops'
import type { ClaudeFrame } from './claudeProtocol'

/**
 * What a Claude turn that ended in error puts on the provider, in Sotto's words. Claude Code's own error text holds
 * status codes and protocol bodies, so it is read to tell the reasons apart and never shown. Each sentence says
 * what happened, that nothing in the thread was lost, and what to do next; a reason Sotto does not recognise gets
 * the general one.
 */
export const CLAUDE_TURN_FAILED = 'Claude could not complete this turn. Check its native subscription, model and usage limits.'

type Reason = 'usage-limit' | 'busy' | 'offline' | 'sign-in' | 'account' | 'model' | 'too-long' | 'step-limit' | 'spending-limit'

const SENTENCES: ReadonlyMap<Exclude<Reason, 'usage-limit'>, string> = new Map([
  ['busy', 'Claude’s servers were busy or had a problem, so this turn stopped. Nothing in the thread was lost. This is usually brief: send again in a moment.'],
  ['offline', 'Claude Code could not reach Claude’s servers, so this turn stopped. Nothing in the thread was lost. Check your internet connection, then send again.'],
  ['sign-in', 'Claude Code is not signed in, or its sign-in has expired, so this turn stopped. Nothing in the thread was lost. Sign in again in Claude Code, then send again.'],
  ['account', 'Claude turned this turn away because of your Claude account or billing. Nothing in the thread was lost. Check your Claude account, then send again.'],
  ['model', 'Claude Code could not use this thread’s model, so this turn stopped. Nothing in the thread was lost. Choose another model from the model chip, then send again.'],
  ['too-long', 'This thread’s conversation is too long for its model, so this turn stopped. Nothing in the thread was lost. Compact the thread or choose a model with more context, then send again.'],
  ['step-limit', 'Claude stopped this turn after the most steps it takes in one turn. What it did so far is kept. Send a message to let it carry on.'],
  // Sotto's own sentence, which the window reads to offer continuing on another provider (ADR-0088).
  ['spending-limit', CLAUDE_SPENDING_LIMIT_SENTENCE],
])

/** The classification Claude Code puts on an assistant message that stands for a failed API call (`SDKAssistantMessageError`). */
const ASSISTANT_ERRORS: ReadonlyMap<string, Reason> = new Map([
  ['rate_limit', 'usage-limit'], ['overloaded', 'busy'], ['server_error', 'busy'],
  ['authentication_failed', 'sign-in'], ['oauth_org_not_allowed', 'sign-in'], ['cloud_credential_error', 'sign-in'],
  ['account_on_hold', 'account'], ['verification_required', 'account'], ['billing_error', 'account'],
  ['model_not_found', 'model'],
])
/** The words Claude Code's error text uses for each reason, tried in order when nothing structured says. */
const TEXT: readonly (readonly [Reason, RegExp])[] = [
  ['usage-limit', /usage limit|rate limit|hit your limit|limit reached|too many requests/iu],
  ['too-long', /prompt is too long|context (?:window|length)|input is too long/iu],
  ['model', /model[^.]*(?:not found|not available|unavailable|does not exist|isn't available|is not supported)|not_found_error|issue with the selected model/iu],
  ['sign-in', /\/login|please (?:log|sign) ?in|not (?:logged|signed) in|authenticat|invalid api key|oauth|unauthori[sz]ed|credential/iu],
  ['account', /billing|credit balance|account (?:is )?(?:on hold|suspended|disabled)/iu],
  ['offline', /connection error|could not connect|unable to connect|failed to connect|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|fetch failed|network error/iu],
  ['busy', /overloaded|internal server error|server error|service unavailable|bad gateway|gateway timeout|temporarily unavailable/iu],
]

function reasonOf(frame: ClaudeFrame, assistantError: string | undefined, text: string): Reason | undefined {
  if (frame.subtype === 'error_max_turns' || frame.terminal_reason === 'max_turns') return 'step-limit'
  if (frame.subtype === 'error_max_budget_usd' || frame.terminal_reason === 'budget_exhausted') return 'spending-limit'
  if (frame.terminal_reason === 'prompt_too_long') return 'too-long'
  const classified = assistantError === undefined ? undefined : ASSISTANT_ERRORS.get(assistantError)
  if (classified) return classified
  const status = typeof frame.api_error_status === 'number' ? frame.api_error_status : undefined
  if (status === 429) return 'usage-limit'
  if (status === 401 || status === 403) return 'sign-in'
  if (status === 404) return 'model'
  if (status !== undefined && status >= 500) return 'busy'
  return TEXT.find(([, pattern]) => pattern.test(text))?.[0]
}

/** When a usage limit resets, if Claude Code's text says: a local time, or the epoch seconds it has appended after a `|`. */
function resetTime(text: string): string | undefined {
  const epoch = /\|(\d{10})\b/u.exec(text)?.[1]
  if (epoch) return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(Number(epoch) * 1000))
  const said = /\bresets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s?[ap]m)(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)+)\))?/iu.exec(text)
  return said ? [said[1]!.replace(/\s+/gu, ''), said[2] ? `(${said[2]})` : undefined].filter(Boolean).join(' ') : undefined
}

/** A turn Claude Code cut short, by a stop or a prompt sent now, rather than one it finished or failed. */
export function claudeTurnAborted(frame: ClaudeFrame): boolean {
  return frame.terminal_reason === 'aborted_streaming' || frame.terminal_reason === 'aborted_tools'
}

/**
 * The provider error for a result Claude Code ended in error, or null for a turn the user stopped, which is no
 * failure. `assistantError` is the classification on the turn's last assistant message, when it had one. Only a
 * `success` result's `result` is error text (a failed result's is not read), and like the `errors` an early stop
 * lists it is only matched against, never shown.
 */
export function claudeTurnFailure(frame: ClaudeFrame, assistantError?: string): string | null {
  if (claudeTurnAborted(frame)) return null
  const said = frame.subtype === 'success' ? [frame.result] : Array.isArray(frame.errors) ? frame.errors : []
  const text = said.filter((item): item is string => typeof item === 'string').join('\n')
  const reason = reasonOf(frame, assistantError, text)
  if (reason === undefined) return CLAUDE_TURN_FAILED
  if (reason !== 'usage-limit') return SENTENCES.get(reason)!
  return claudeUsageLimitSentence(resetTime(text))
}
