import type { AgentActivity } from './agentActivity'
import type { AgentThreadDetail, AgentThreadDetailDelta } from './agents'
import { agentActivitySignature } from './agentThreadDetail'

/**
 * Cut bodies (ADR-0025, October 18 amendment; `docs/host-protocol.md` under `activity-bodies`). A desktop that accepts
 * `activity-bodies` is sent each activity record with every body over this many UTF-8 bytes cut down to its first or last
 * part, and fetches the whole record with `activity-body` when its row opens. The bodies are a record's `output`, its
 * `text` and each of its changes' `diff`; every other field goes whole.
 */
export const ACTIVITY_BODY_LIMIT = 2_048

/** Which end of a body a cut keeps: command output its end, where the result is, and text and diffs their start. */
type Keep = 'start' | 'end'
type Cut = NonNullable<AgentActivity['cut']>

export const utf8Bytes = (value: string): number => {
  // Most bodies are ASCII, and counting them needs no encoding.
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00) { bytes += 4; index++ }
    else bytes += 3
  }
  return bytes
}

/** The UTF-8 size of one code point starting at `index`, and how many UTF-16 units it takes. */
function codePointAt(value: string, index: number): { bytes: number; units: number } {
  const code = value.charCodeAt(index)
  if (code < 0x80) return { bytes: 1, units: 1 }
  if (code < 0x800) return { bytes: 2, units: 1 }
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && (value.charCodeAt(index + 1) & 0xfc00) === 0xdc00) return { bytes: 4, units: 2 }
  return { bytes: 3, units: 1 }
}

/**
 * The part of `value` a cut keeps: at most `limit` UTF-8 bytes from the kept end, ending (or, for the end, starting) at a
 * line break, so no line shows half. A window with no line break in it keeps nothing. Never splits a surrogate pair.
 */
export function cutText(value: string, keep: Keep, limit = ACTIVITY_BODY_LIMIT): string {
  if (keep === 'start') {
    let bytes = 0, end = 0
    while (end < value.length) {
      const point = codePointAt(value, end)
      if (bytes + point.bytes > limit) break
      bytes += point.bytes; end += point.units
    }
    if (end >= value.length) return value
    // The window ends where a line does, or is shortened back to the last line break inside it.
    if (value[end] === '\n') return value.slice(0, end)
    const lastBreak = value.lastIndexOf('\n', end - 1)
    return lastBreak < 0 ? '' : value.slice(0, lastBreak)
  }
  let bytes = 0, start = value.length
  while (start > 0) {
    // A low surrogate preceded by a high one is one code point of four bytes.
    const low = value.charCodeAt(start - 1)
    const pair = (low & 0xfc00) === 0xdc00 && start >= 2 && (value.charCodeAt(start - 2) & 0xfc00) === 0xd800
    const point = pair ? { bytes: 4, units: 2 } : codePointAt(value, start - 1)
    if (bytes + point.bytes > limit) break
    bytes += point.bytes; start -= point.units
  }
  if (start <= 0) return value
  if (value[start - 1] === '\n') return value.slice(start)
  const firstBreak = value.indexOf('\n', start)
  return firstBreak < 0 ? '' : value.slice(firstBreak + 1)
}

/** A JSON string literal's UTF-8 size, quotes and escapes included. */
const literalBytes = (value: string): number => utf8Bytes(JSON.stringify(value))

/** `value` shortened so its JSON literal takes at most `limit` bytes, at a line break when one is in reach. */
function shortenString(value: string, limit: number): string {
  if (literalBytes(value) <= limit) return value
  let low = 0, high = value.length
  // The longest prefix whose literal fits, found by halving: escapes make the literal's size uneven along the string.
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    let end = middle
    if (end < value.length && (value.charCodeAt(end) & 0xfc00) === 0xdc00 && end > 0) end -= 1
    if (literalBytes(value.slice(0, end)) <= limit) low = middle
    else high = middle - 1
  }
  let end = low
  if (end < value.length && (value.charCodeAt(end) & 0xfc00) === 0xdc00 && end > 0) end -= 1
  const prefix = value.slice(0, end)
  const lastBreak = prefix.lastIndexOf('\n')
  return lastBreak > 0 ? prefix.slice(0, lastBreak) : prefix
}

/** Every string value in `value` (keys left alone) cut so its literal takes at most `cap` bytes. */
function shortenStrings(value: unknown, cap: number): unknown {
  if (typeof value === 'string') return shortenString(value, cap)
  if (Array.isArray(value)) return value.map(item => shortenStrings(item, cap))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shortenStrings(item, cap)]))
  return value
}
function stringLiterals(value: unknown, into: number[]): number[] {
  if (typeof value === 'string') into.push(literalBytes(value))
  else if (Array.isArray(value)) for (const item of value) stringLiterals(item, into)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) stringLiterals(item, into)
  return into
}

/**
 * Text that is a JSON object or array, such as Claude's tool input, kept valid JSON within the limit: each long string
 * value in it is shortened, so the short ones (a file path, a pattern) stay whole for the row's preview. Null when the
 * text is not JSON, or when even shortened strings leave it over the limit.
 */
function cutJson(text: string, limit: number): { text: string; shortened: boolean } | null {
  const trimmed = text.trim()
  if (!(trimmed.startsWith('{') && trimmed.endsWith('}')) && !(trimmed.startsWith('[') && trimmed.endsWith(']'))) return null
  let value: unknown
  try { value = JSON.parse(trimmed) } catch { return null }
  if (value === null || typeof value !== 'object') return null
  const compact = JSON.stringify(value)
  // Only whitespace came out: nothing is missing, so nothing is cut.
  if (utf8Bytes(compact) <= limit) return { text: compact, shortened: false }
  const literals = stringLiterals(value, [])
  if (!literals.length) return null
  const overhead = utf8Bytes(compact) - literals.reduce((sum, bytes) => sum + bytes, 0)
  // The largest per-string cap whose strings, all cut to it, fit: a shortened string can come out a little under its cap.
  let low = 2, high = Math.max(...literals)
  if (overhead + literals.reduce((sum, bytes) => sum + Math.min(bytes, low), 0) > limit) return null
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (overhead + literals.reduce((sum, bytes) => sum + Math.min(bytes, middle), 0) <= limit) low = middle
    else high = middle - 1
  }
  for (let cap = low; cap >= 2; cap = Math.min(cap - 1, Math.floor(cap * 0.9))) {
    const shortened = JSON.stringify(shortenStrings(value, cap))
    if (utf8Bytes(shortened) <= limit) return { text: shortened, shortened: true }
  }
  return null
}

/** Whether a record's text would be read as tool input, as the desktop's rows read it (`activityInput`). */
const readsAsInput = (record: AgentActivity): boolean => !['reasoning', 'plan', 'status', 'turn'].includes(record.kind)

/**
 * A record as a desktop that accepts `activity-bodies` is sent it: each body over the limit cut, and `cut` naming each
 * one's whole size in UTF-8 bytes (diffs by their change's index). The record itself when nothing is over the limit.
 */
export function cutActivityBodies(record: AgentActivity, limit = ACTIVITY_BODY_LIMIT): AgentActivity {
  const cut: Cut = {}
  let next: AgentActivity | undefined
  const edit = (): AgentActivity => next ??= { ...record }
  if (record.output !== undefined) {
    const bytes = utf8Bytes(record.output)
    if (bytes > limit) { edit().output = cutText(record.output, 'end', limit); cut.output = bytes }
  }
  if (record.text !== undefined) {
    const bytes = utf8Bytes(record.text)
    if (bytes > limit) {
      const json = readsAsInput(record) ? cutJson(record.text, limit) : null
      edit().text = json ? json.text : cutText(record.text, 'start', limit)
      if (!json || json.shortened) cut.text = bytes
    }
  }
  if (record.changes?.some(change => change.diff !== undefined && change.diff.length * 3 > limit)) {
    const diffs: NonNullable<Cut['diffs']> = []
    const changes = record.changes.map((change, index) => {
      if (change.diff === undefined) return change
      const bytes = utf8Bytes(change.diff)
      if (bytes <= limit) return change
      diffs.push({ index, bytes })
      return { ...change, diff: cutText(change.diff, 'start', limit) }
    })
    if (diffs.length) { edit().changes = changes; cut.diffs = diffs }
  }
  if (next === undefined) return record
  if (cut.output !== undefined || cut.text !== undefined || cut.diffs !== undefined) next.cut = cut
  return next
}

/** Whether a record a desktop holds has a body still on its host. */
export const hasCutBody = (record: Pick<AgentActivity, 'cut'>): boolean => record.cut !== undefined

/**
 * A body's size as a reader of lengths should take it: the whole size in UTF-8 bytes when it was cut, else its length.
 * Anything on the desktop that asks whether a body is there, or whether it grew, asks this rather than `.length`.
 */
export function activityBodySize(record: Pick<AgentActivity, 'output' | 'text' | 'cut'>, field: 'output' | 'text'): number | undefined {
  return record.cut?.[field] ?? record[field]?.length
}

/**
 * Cut records made once per record, however many peers and details carry it. A record is looked up by identity and
 * checked by its signature, since a provider's record can change in place.
 */
export class CutBodies {
  private readonly made = new WeakMap<AgentActivity, { signature: string; record: AgentActivity }>()
  record(record: AgentActivity): AgentActivity {
    const signature = agentActivitySignature(record)
    const kept = this.made.get(record)
    if (kept?.signature === signature) return kept.record
    const made = cutActivityBodies(record)
    this.made.set(record, { signature, record: made })
    return made
  }
  detail(detail: AgentThreadDetail): AgentThreadDetail {
    return detail.activities === undefined ? detail : { ...detail, activities: detail.activities.map(record => this.record(record)) }
  }
  delta(delta: AgentThreadDetailDelta): AgentThreadDetailDelta {
    return delta.activityDeltas.length === 0 ? delta
      : { ...delta, activityDeltas: delta.activityDeltas.map(item => 'record' in item ? { record: this.record(item.record) } : item) }
  }
}
