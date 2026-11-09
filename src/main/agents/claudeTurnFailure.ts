import { claudeUsageLimitSentence, CLAUDE_SPENDING_LIMIT_SENTENCE } from '../../shared/limitStops'
import type { TurnLimitStop } from '../../shared/limitRestart'
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
  // Sotto's own sentence, which the window reads to offer continuing on another provider (ADR-0089).
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
  // "hit your limit", or a window named in one word: "hit your session limit", "hit your weekly limit".
  ['usage-limit', /usage limit|rate limit|hit your (?:[a-z]+ )?limit\b|limit reached|too many requests/iu],
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

/**
 * When Claude Code's text says a usage limit resets: "resets 3pm (America/Chicago)", "resets at 5:40pm", or, for a reset on
 * another day, "resets Nov 11, 5am (America/Los_Angeles)". The groups are the month and day when it names a day, the
 * hour, the minutes, a or p, and the zone.
 */
const SPOKEN_RESET = /\bresets?\s+(?:at\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s?([ap])m(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\))?/iu
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
/** The month a name such as "Nov" or "November" stands for, from 0, or undefined for a word that is no month. */
function monthOf(name: string): number | undefined {
  const word = name.toLowerCase()
  const at = word.length < 3 ? -1 : MONTHS.findIndex(month => month.startsWith(word))
  return at < 0 ? undefined : at
}

/** When a usage limit resets, if Claude Code's text says: a local time, or the epoch seconds it has appended after a `|`. */
function resetTime(text: string): string | undefined {
  const epoch = /\|(\d{10})\b/u.exec(text)?.[1]
  if (epoch) return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(Number(epoch) * 1000))
  const said = SPOKEN_RESET.exec(text)
  if (!said || said[1] !== undefined && monthOf(said[1]) === undefined) return undefined
  const clock = `${said[3]}${said[4] === undefined ? '' : `:${said[4]}`}${said[5]!.toLowerCase()}m`
  // As the sentence goes on after "resets at": "5am on Nov 11 (America/Los_Angeles)".
  return [clock, said[1] === undefined ? undefined : `on ${said[1]} ${said[2]}`, said[6] ? `(${said[6]})` : undefined].filter(Boolean).join(' ')
}

/**
 * The text of an assistant message that stands for a failed API call, such as "You’ve hit your weekly limit · resets Nov 11,
 * 5am (America/Los_Angeles)": only read for when a limit resets, never shown from here.
 */
export function claudeErrorReplyText(frame: ClaudeFrame): string | undefined {
  const message = frame.message
  const content = message !== null && typeof message === 'object' ? (message as { content?: unknown }).content : undefined
  if (!Array.isArray(content)) return undefined
  const text = content.flatMap(item => item !== null && typeof item === 'object' && (item as { type?: unknown }).type === 'text'
    && typeof (item as { text?: unknown }).text === 'string' ? [(item as { text: string }).text] : []).join('\n')
  return text || undefined
}

/** A turn Claude Code cut short, by a stop or a prompt sent now, rather than one it finished or failed. */
export function claudeTurnAborted(frame: ClaudeFrame): boolean {
  return frame.terminal_reason === 'aborted_streaming' || frame.terminal_reason === 'aborted_tools'
}

/**
 * The provider error for a result Claude Code ended in error, or null for a turn the user stopped, which is no
 * failure. `assistantError` is the classification on the turn's last assistant message, when it had one, and
 * `errorReply` that message's own text, read for when a usage limit resets when the result does not say. Only a
 * `success` result's `result` is error text (a failed result's is not read), and like the `errors` an early stop
 * lists it is only matched against, never shown.
 */
export function claudeTurnFailure(frame: ClaudeFrame, assistantError?: string, errorReply?: string): string | null {
  if (claudeTurnAborted(frame)) return null
  const text = errorText(frame)
  const reason = reasonOf(frame, assistantError, text)
  if (reason === undefined) return CLAUDE_TURN_FAILED
  if (reason !== 'usage-limit') return SENTENCES.get(reason)!
  return claudeUsageLimitSentence(resetTime(text) ?? (errorReply === undefined ? undefined : resetTime(errorReply)))
}

/** How far one zone's wall clock is ahead of UTC at an instant, in milliseconds; throws for a zone this computer does not know. */
function zoneOffsetMs(zone: string | undefined, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(at))
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(item => item.type === type)?.value)
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - Math.floor(at / 1000) * 1000
}
/** The next instant after `now` at which a zone's clock reads `hour:minute`, or undefined when the zone cannot be read. */
function nextWallTime(hour: number, minute: number, zone: string | undefined, now: number): number | undefined {
  try {
    const offset = zoneOffsetMs(zone, now), today = new Date(now + offset)
    for (let day = 0; day <= 1; day++) {
      const wall = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + day, hour, minute)
      // The offset where the wall time falls, which a change of clocks overnight can move.
      const at = wall - zoneOffsetMs(zone, wall - offset)
      if (Number.isFinite(at) && at > now) return at
    }
  } catch { /* A zone this computer does not know says no time. */ }
  return undefined
}
/** The instant a zone's clock reads a wall time, or undefined when the zone cannot be read. */
function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, zone: string | undefined): number | undefined {
  try {
    const wall = Date.UTC(year, month, day, hour, minute)
    // The offset where the wall time falls, which a change of clocks that day can move.
    const at = wall - zoneOffsetMs(zone, wall - zoneOffsetMs(zone, wall))
    return Number.isFinite(at) ? at : undefined
  } catch { return undefined }
}
/**
 * When a usage limit resets, as an instant, if Claude Code's text says (ADR-0144): the epoch seconds it appends after a `|`,
 * or a spoken time ("resets 3pm (America/Chicago)", "resets 11pm (UTC)") as the next such time in that zone, or on this
 * computer's clock when it names none. A reset on another day ("resets Nov 11, 5am (America/Los_Angeles)") is that day's
 * time, in the year that puts it next. Undefined when it says neither, or names a zone or month this computer cannot read.
 */
function resetInstant(text: string, now: number): string | undefined {
  const epoch = /\|(\d{10})\b/u.exec(text)?.[1]
  if (epoch) return new Date(Number(epoch) * 1000).toISOString()
  const said = SPOKEN_RESET.exec(text)
  if (!said) return undefined
  const clock = Number(said[3]), minute = said[4] === undefined ? 0 : Number(said[4])
  if (clock < 1 || clock > 12 || minute > 59) return undefined
  const hour = clock % 12 + (said[5]!.toLowerCase() === 'p' ? 12 : 0)
  if (said[1] === undefined) {
    const at = nextWallTime(hour, minute, said[6], now)
    return at === undefined ? undefined : new Date(at).toISOString()
  }
  const month = monthOf(said[1]), day = Number(said[2])
  if (month === undefined || day < 1 || day > 31) return undefined
  let year: number
  try { year = new Date(now + zoneOffsetMs(said[6], now)).getUTCFullYear() } catch { return undefined }
  // A day already well past this year is next year's, as "Jan 2" said on December 30 is.
  for (const candidate of [year, year + 1]) {
    const at = zonedInstant(candidate, month, day, hour, minute, said[6])
    if (at === undefined) return undefined
    if (at > now - 24 * 60 * 60_000) return new Date(at).toISOString()
  }
  return undefined
}
/** The text a result frame's error is read from: a `success` result's `result`, or the `errors` an early stop lists. */
function errorText(frame: ClaudeFrame): string {
  const said = frame.subtype === 'success' ? [frame.result] : Array.isArray(frame.errors) ? frame.errors : []
  return said.filter((item): item is string => typeof item === 'string').join('\n')
}

/**
 * The usage-limit stop a failed result stands for (ADR-0144), with when the limit resets as an instant when Claude Code
 * said, or undefined for any other ending, a spending limit included: that one never resets on its own. Read from the same
 * frame and error reply `claudeTurnFailure` words, and never shown.
 */
export function claudeLimitStop(frame: ClaudeFrame, assistantError?: string, now: number = Date.now(), errorReply?: string): TurnLimitStop | undefined {
  if (claudeTurnAborted(frame)) return undefined
  const text = errorText(frame)
  if (reasonOf(frame, assistantError, text) !== 'usage-limit') return undefined
  const resetsAt = resetInstant(text, now) ?? (errorReply === undefined ? undefined : resetInstant(errorReply, now))
  return resetsAt ? { resetsAt } : {}
}
