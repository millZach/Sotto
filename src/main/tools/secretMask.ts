/**
 * Finding a typed secret in what a page says back (ADR-0219, decision 7), without a regular expression. A pattern built
 * from the secret overflowed V8's regular expression compiler once a secret passed about 5,000 characters, putting the
 * secret in the error, and backtracked for ever on a page of backslashes once the secret held one. This does neither:
 * its time grows with the text and the secret added together, and the most it holds is a few bytes for each byte of the
 * secret and one for each character of the text.
 *
 * The text is read in four ways, a character or an escape at a time, each reading giving a plain sequence of bytes:
 * - as it is;
 * - as JSON writes a string: `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`, and `\u` with four hex digits of either
 *   case, a pair of them for a character beyond U+FFFF;
 * - as an address or a form escapes it once: `%` and two hex digits of either case;
 * - as an address escapes it once or twice, with JSON's escapes as well: `%25` and two hex digits is read as the byte
 *   the two digits name, as an address carried inside another address is written.
 * In the two readings an address gives, a secret that holds a space is looked for a second time with each of its spaces
 * a `+`, and the text's spaces read as `+` too, so a space a form sent as `+`, or as `%2B` once that `+` is escaped
 * again, is found. A `+` in a secret is only ever a `+`, so a secret `a+b` does not mask the words `a b`. A reading
 * takes the longest escape at each place; the plain reading and the single escape find what that misses, such as a
 * secret that holds `%41` itself.
 *
 * In each reading the secret's UTF-8 bytes are looked for with the Knuth-Morris-Pratt search, which never goes back in
 * the text, and every character or escape a match touches is masked. Matches may overlap and may come from different
 * readings; each run of masked characters becomes one mask.
 */

/** What a typed secret is replaced by wherever it is found. */
export const MASK = '••••••••'
/** A secret shorter than this many characters is not masked: one that short is as likely the page's own words. */
export const MASK_MINIMUM = 3

/** `text` cut to at most `max` code units, never between the halves of a surrogate pair, which would leave no character. */
export function cutWhole(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max)).replace(/[\uD800-\uDBFF]$/u, '')
}

/** The secret's bytes and the Knuth-Morris-Pratt table that says how far a partial match falls back. */
interface Needle { readonly bytes: Uint8Array; readonly fallback: Int32Array }
/** A typed secret as the search needs it, made once when it is typed. It holds the secret's bytes, so it stays in memory only. */
export interface SecretMatcher {
  /** The secret's bytes as they are, for every reading. */
  readonly plain: Needle
  /**
   * For the readings an address gives: the secret with each space a `+`, as a form sends it, looked for in the text with
   * its spaces read as `+` too. Null for a secret that holds no space.
   */
  readonly spaced: Needle | null
}

const JSON_ESCAPES = 1, ESCAPED_ONCE = 2, ESCAPED_TWICE = 4
/** The four readings: as it is, as JSON, escaped once, and every escape together. */
const READINGS = [0, JSON_ESCAPES, ESCAPED_ONCE, ESCAPED_ONCE | ESCAPED_TWICE | JSON_ESCAPES] as const
const PLUS = 0x2b, SPACE = 0x20, PERCENT = 0x25, BACKSLASH = 0x5c, LETTER_U = 0x75, REPLACEMENT = 0xfffd
/** The character after a backslash in JSON, and the byte it stands for. */
const JSON_SHORT: ReadonlyMap<number, number> = new Map([[0x22, 0x22], [0x5c, 0x5c], [0x2f, 0x2f], [0x62, 0x08], [0x66, 0x0c], [0x6e, 0x0a], [0x72, 0x0d], [0x74, 0x09]])

/** The value of one hex digit's character code, either case, or -1. */
function hexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30
  const lower = code | 0x20
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1
}
/** The number `digits` hex digits starting at `at` spell, or -1 when any of them is not one (past the end included). */
function hexAt(text: string, at: number, digits: number): number {
  let value = 0
  for (let index = 0; index < digits; index++) {
    const digit = hexDigit(text.charCodeAt(at + index))
    if (digit < 0) return -1
    value = value * 16 + digit
  }
  return value
}
/** Writes a code point's UTF-8 bytes into `out` and says how many. A lone surrogate is U+FFFD, as `TextEncoder` writes it. */
function utf8(codePoint: number, out: Uint8Array): number {
  const point = codePoint >= 0xd800 && codePoint < 0xe000 ? REPLACEMENT : codePoint
  if (point < 0x80) { out[0] = point; return 1 }
  if (point < 0x800) { out[0] = 0xc0 | (point >> 6); out[1] = 0x80 | (point & 0x3f); return 2 }
  if (point < 0x10000) { out[0] = 0xe0 | (point >> 12); out[1] = 0x80 | ((point >> 6) & 0x3f); out[2] = 0x80 | (point & 0x3f); return 3 }
  out[0] = 0xf0 | (point >> 18); out[1] = 0x80 | ((point >> 12) & 0x3f); out[2] = 0x80 | ((point >> 6) & 0x3f); out[3] = 0x80 | (point & 0x3f)
  return 4
}
/** The code point of the character at `at` and the code units it takes: a surrogate pair is one character. */
function characterAt(text: string, at: number): { point: number; units: number } {
  const high = text.charCodeAt(at)
  if (high >= 0xd800 && high < 0xdc00) {
    const low = text.charCodeAt(at + 1)
    if (low >= 0xdc00 && low < 0xe000) return { point: 0x10000 + (high - 0xd800) * 0x400 + (low - 0xdc00), units: 2 }
  }
  return { point: high, units: 1 }
}

/** One character or escape as a reading gives it: its bytes, how many, and where the next one starts. */
interface Unit { readonly bytes: Uint8Array; size: number; end: number }
/** Reads the character or escape at `at` as `reading` does, into `unit`. Always moves on by at least one character. */
function read(text: string, at: number, reading: number, unit: Unit): void {
  const code = text.charCodeAt(at)
  if (code === PERCENT && reading & ESCAPED_ONCE) {
    // `%25` and two hex digits is a byte escaped twice; otherwise `%` and two hex digits is one escaped once.
    const twice = reading & ESCAPED_TWICE && text.charCodeAt(at + 1) === 0x32 && text.charCodeAt(at + 2) === 0x35 ? hexAt(text, at + 3, 2) : -1
    const byte = twice >= 0 ? twice : hexAt(text, at + 1, 2)
    if (byte >= 0) { unit.bytes[0] = byte; unit.size = 1; unit.end = at + (twice >= 0 ? 5 : 3); return }
  }
  if (code === BACKSLASH && reading & JSON_ESCAPES) {
    const next = text.charCodeAt(at + 1)
    const escaped = next === LETTER_U ? hexAt(text, at + 2, 4) : -1
    if (escaped >= 0) {
      // A high surrogate written as `\u` followed by a low one is one character, as JSON writes those beyond U+FFFF.
      const low = escaped >= 0xd800 && escaped < 0xdc00 && text.charCodeAt(at + 6) === BACKSLASH && text.charCodeAt(at + 7) === LETTER_U ? hexAt(text, at + 8, 4) : -1
      const paired = low >= 0xdc00 && low < 0xe000
      unit.size = utf8(paired ? 0x10000 + (escaped - 0xd800) * 0x400 + (low - 0xdc00) : escaped, unit.bytes)
      unit.end = at + (paired ? 12 : 6)
      return
    }
    const short = JSON_SHORT.get(next)
    if (short !== undefined) { unit.bytes[0] = short; unit.size = 1; unit.end = at + 2; return }
  }
  const character = characterAt(text, at)
  unit.size = utf8(character.point, unit.bytes)
  unit.end = at + character.units
}

/** A needle for `bytes`, with the table of how far a partial match of each length falls back on a mismatch. */
function needleOf(bytes: Uint8Array): Needle {
  const fallback = new Int32Array(bytes.length)
  for (let index = 1, length = 0; index < bytes.length; index++) {
    while (length > 0 && bytes[index] !== bytes[length]) length = fallback[length - 1]!
    if (bytes[index] === bytes[length]) length++
    fallback[index] = length
  }
  return { bytes, fallback }
}
/**
 * The matcher for a typed secret, or null for one too short to mask (`MASK_MINIMUM`), which is then not looked for.
 * Made once, when the secret is typed.
 */
export function secretMatcher(secret: string): SecretMatcher | null {
  const bytes: number[] = [], scratch = new Uint8Array(4)
  let characters = 0
  for (let at = 0; at < secret.length; characters++) {
    const character = characterAt(secret, at)
    const size = utf8(character.point, scratch)
    for (let index = 0; index < size; index++) bytes.push(scratch[index]!)
    at += character.units
  }
  if (characters < MASK_MINIMUM) return null
  return { plain: needleOf(Uint8Array.from(bytes)), spaced: bytes.includes(SPACE) ? needleOf(Uint8Array.from(bytes, byte => byte === SPACE ? PLUS : byte)) : null }
}
/** The characters a file name cannot hold, which Chromium makes `_` in a download's name before Sotto is told it. */
// eslint-disable-next-line no-control-regex -- A typed secret, which may hold any character.
const NOT_IN_FILE_NAMES = /[\x00-\x1f\x7f"*/:<>?\\|‪-‮⁦-⁩]/gu
/**
 * The matchers for a typed secret and the copies of it a page or Chromium makes with no script of the page's: with each
 * run of spaces closed up to one, and with none at either end, as a page shows its text; and with each character a file
 * name cannot hold made `_` or `-`, as a download is named. Each is made once, and one too short to mask is left out.
 */
export function secretMatchers(secret: string): SecretMatcher[] {
  const closed = secret.replace(/\s+/gu, ' ')
  const forms = new Set([secret, closed, closed.trim(), secret.replace(NOT_IN_FILE_NAMES, '_'), secret.replace(NOT_IN_FILE_NAMES, '-')])
  return [...forms].map(secretMatcher).filter(matcher => matcher !== null)
}

/**
 * Which characters of `text` lie inside a copy of `keep`, as a running count, so whether a stretch lies wholly inside
 * one is a subtraction. Null when `keep` is empty or not in the text.
 */
function keptCounts(text: string, keep: string): Int32Array | null {
  if (!keep || !text.includes(keep)) return null
  const inside = new Uint8Array(text.length)
  for (let at = text.indexOf(keep); at >= 0; at = text.indexOf(keep, at + keep.length)) inside.fill(1, at, at + keep.length)
  const counts = new Int32Array(text.length + 1)
  for (let index = 0; index < text.length; index++) counts[index + 1] = counts[index]! + inside[index]!
  return counts
}

/**
 * Marks in `covered` every character of `text` that a match of `needle` touches in `reading`, except a match that lies
 * wholly inside a kept stretch (`kept`). With `plus`, each space the reading gives is read as `+`. Each byte of the text
 * is compared with the needle once, plus the fall-backs the table allows, which are never more than the bytes compared.
 */
function cover(text: string, reading: number, needle: Needle, covered: Uint8Array, kept: Int32Array | null, plus = false): boolean {
  const { bytes, fallback } = needle, size = bytes.length
  // Where the character or escape holding each of the last `size` bytes began, so a match knows where it started.
  const starts = new Int32Array(size)
  const unit: Unit = { bytes: new Uint8Array(4), size: 0, end: 0 }
  let matched = 0, seen = 0, coveredTo = 0, found = false
  for (let at = 0; at < text.length; at = unit.end) {
    read(text, at, reading, unit)
    for (let index = 0; index < unit.size; index++) {
      const byte = plus && unit.bytes[index] === SPACE ? PLUS : unit.bytes[index]
      starts[seen % size] = at
      seen++
      while (matched > 0 && bytes[matched] !== byte) matched = fallback[matched - 1]!
      if (bytes[matched] === byte) matched++
      if (matched === size) {
        // From the start of the character or escape the match's first byte is in, to the end of this one. Matches
        // come in order, so nothing is marked twice in one reading.
        const start = starts[(seen - size) % size]!, end = unit.end
        if (!kept || kept[end]! - kept[start]! !== end - start) {
          covered.fill(1, Math.max(start, coveredTo), end)
          coveredTo = Math.max(coveredTo, end)
          found = true
        }
        matched = fallback[size - 1]!
      }
    }
  }
  return found
}

/**
 * How a place tidies the page's words before it says them, as the place itself would: `words` makes each control
 * character but a line break, and each bidirectional mark, a space, one for one; `line` makes each of those a space too,
 * closes up each run of spaces to one and drops them at either end, as one line says it; `title` drops each control
 * character and bidirectional mark, as a window's title says it.
 */
export type Tidy = 'words' | 'line' | 'title'

/** Whether `tidy` takes a character out or makes it a space: a control character, or a bidirectional mark. */
function isMark(code: number, tidy: Tidy): boolean {
  return (code <= 0x1f && !(tidy === 'words' && code === 0x0a)) || code === 0x7f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
}
/** Whether a character is one a regular expression's `\s` matches. */
function isSpace(code: number): boolean {
  return code === SPACE || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff
}
/**
 * `text` tidied as `tidy` says, and where in `text` each of its characters came from: character `j` of the tidied text
 * stands for `text` from `from[j]` up to `from[j + 1]`, with the characters taken out after it, and the first one for
 * those taken out before it as well.
 */
function tidied(text: string, tidy: Tidy): { text: string; from: Int32Array } {
  const codes = new Uint16Array(text.length), from = new Int32Array(text.length + 1)
  let length = 0, spaces = -1
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at), mark = isMark(code, tidy)
    if (tidy === 'words') { from[length] = at; codes[length++] = mark ? SPACE : code; continue }
    if (tidy === 'title') { if (!mark) { from[length] = at; codes[length++] = code } continue }
    if (mark || isSpace(code)) { if (spaces < 0) spaces = at; continue }
    if (spaces >= 0 && length > 0) { from[length] = spaces; codes[length++] = SPACE }
    spaces = -1
    from[length] = at; codes[length++] = code
  }
  from[0] = 0; from[length] = text.length
  const parts: string[] = []
  for (let at = 0; at < length; at += 8192) parts.push(String.fromCharCode(...codes.subarray(at, Math.min(length, at + 8192))))
  return { text: parts.join(''), from: from.subarray(0, length + 1) }
}
/** `text` tidied as `tidy` says (`Tidy`): how a place that tidies the page's words says them with no secret typed in it. */
export function tidyWords(text: string, tidy: Tidy): string { return tidied(text, tidy).text }

/** Marks in `covered` each character of `text` that holds one of `secrets` in any reading, but for those inside `keep`. */
function coverAll(text: string, secrets: readonly SecretMatcher[], keep: string, covered: Uint8Array): boolean {
  const kept = keptCounts(text, keep)
  let found = false
  for (const secret of secrets) for (const reading of READINGS) {
    if (cover(text, reading, secret.plain, covered, kept)) found = true
    if (reading & ESCAPED_ONCE && secret.spaced && cover(text, reading, secret.spaced, covered, kept, true)) found = true
  }
  return found
}

/**
 * `text` with each run of characters that holds one of `secrets`, in any of the four readings, replaced by `MASK`. A
 * secret found wholly inside a copy of `keep`, the page's own origin, is left: the agent knows the site it was given,
 * and a PIN that is also the page's port would otherwise mask every address on it.
 *
 * With `tidy`, the words are tidied as the place they go tidies them (`Tidy`) before they are cut, and a secret is looked
 * for both in the words as the page wrote them and once they are tidied, so neither a mark the page put inside a secret
 * nor the spaces tidying closes up leaves part of one. A place that tidies the page's words passes its tidy here rather
 * than tidying what this says: tidied after the cut, the rest of a secret the cut split could read as part of it.
 *
 * With `max`, only the first `max` characters of the tidied words are said, and a run the cut would fall inside is
 * masked whole: the words are masked before they are cut, so no cut leaves the start of a secret. Masks are shorter or
 * longer than what they replace, so the cut is counted in the words, never in what is said, which can be longer than
 * `max`; a place that takes no more than `max` cuts what this says again, which takes off only the end of a mask. Words
 * the page itself cut must run far enough past `max` that a secret starting before `max` is in them whole.
 */
export function maskSecrets(text: string, secrets: Iterable<SecretMatcher | null>, keep = '', max?: number, tidy?: Tidy): string {
  const view = tidy ? tidied(text, tidy) : null, words = view ? view.text : text
  if (!words) return words
  const matchers = [...secrets].filter(secret => secret !== null)
  const covered = new Uint8Array(words.length)
  let found = false
  if (view && matchers.length) {
    // A secret in the words as the page wrote them covers each tidied character that stands for any part of it.
    const raw = new Uint8Array(text.length)
    if (coverAll(text, matchers, keep, raw)) {
      const counts = new Int32Array(text.length + 1)
      for (let index = 0; index < text.length; index++) counts[index + 1] = counts[index]! + raw[index]!
      for (let index = 0; index < words.length; index++) if (counts[view.from[index + 1]!]! > counts[view.from[index]!]!) { covered[index] = 1; found = true }
    }
  }
  if (matchers.length && coverAll(words, matchers, keep, covered)) found = true
  let length = Math.max(0, Math.min(max ?? words.length, words.length))
  // A cut between the halves of a surrogate pair takes the whole character off.
  if (length < words.length && /[\uD800-\uDBFF]/u.test(words[length - 1] ?? '')) length--
  if (!found) return words.slice(0, length)
  if (length > 0 && covered[length - 1]) { const end = covered.indexOf(0, length); length = end < 0 ? words.length : end }
  const parts: string[] = []
  for (let at = 0; at < length;) {
    const end = covered.indexOf(covered[at] ? 0 : 1, at)
    const stop = end < 0 || end > length ? length : end
    parts.push(covered[at] ? MASK : words.slice(at, stop))
    at = stop
  }
  return parts.join('')
}
