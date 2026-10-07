import { homedir, userInfo } from 'node:os'

// Identify every absolute prefix before removing text. A quoted path cannot
// consume another path's prefix and leave a private relative suffix behind.
// URLs and package names such as aqua:openai/codex are not absolute paths.
const ABSOLUTE_START = /(?<=file:\/\/)\/(?:[A-Za-z]:[\\/])?|(?<![\w/\\~])(?:[A-Za-z]:[\\/]|\\\\|\/(?=[^\s/]))|(?<![\w:/\\~])\/\//gu
const NON_FILE_URL = /\b(?!file:)[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/giu
function redactPaths(line: string): string {
  const urls = Array.from(line.matchAll(NON_FILE_URL), match => ({ start: match.index, end: match.index + match[0].length }))
  const paths = Array.from(line.matchAll(ABSOLUTE_START)).filter(match => !urls.some(url => match.index >= url.start && match.index < url.end)).map(match => {
    const start = match.index
    const prefixStart = line.slice(start - 7, start) === 'file://' ? start - 7 : start
    const preceding = line[prefixStart - 1]
    const quote = preceding === '"' || preceding === "'" ? preceding : undefined
    const windows = /^(?:\/?[A-Za-z]:[\\/]|\\\\|\/\/)/u.test(match[0])
    return { start: quote ? prefixStart - 1 : start, quote, windows, prefixLength: match[0].length }
  })
  let shown = '', cursor = 0
  for (const [index, path] of paths.entries()) {
    const next = paths[index + 1]
    const end = next?.start ?? line.length
    const span = line.slice(path.start, end)
    let suffix = ''
    if (path.quote) {
      // Quotes and spaces can be part of an account folder. Prefer the last
      // matching quote within this path's span, and keep only clear diagnostics.
      const closing = span.lastIndexOf(path.quote)
      const after = span.slice(closing + 1)
      if (closing > 0 && (/^\s*$/u.test(after)
        || next && /^\s*(?:->|to|,)\s*$/u.test(after)
        || /^\s*[,;:)]/u.test(after) && !/[\\/]/u.test(after.replace(NON_FILE_URL, '')))) suffix = after
    } else {
      // Spaces belong to account folders too. Only clear diagnostic delimiters
      // end an unquoted path; skip the drive colon when finding that boundary.
      const boundary = path.windows ? /:(?=[ \d])|["<>|?*)]/gu : /: |\s*[()]|:\d+:\d+\b/gu
      // Folder names may contain parentheses (and Unix names, colons). A suffix with
      // more path segments is still private, even across an identified prefix.
      const continues = next && line[next.start] === '/' && !/\s/u.test(line[next.start - 1]!)
      const diagnostic = Array.from(span.slice(path.prefixLength).matchAll(boundary))
        .find(match => path.windows && match[0] !== ')' || !continues && !/[\\/]/u.test(span.slice(path.prefixLength + match.index).replace(NON_FILE_URL, '')))
      const separator = next ? /\s+(?:->|to)\s*$/u.exec(span) : null
      const suffixStart = Math.min(diagnostic ? path.prefixLength + diagnostic.index : span.length, separator?.index ?? span.length)
      suffix = span.slice(suffixStart)
    }
    shown += line.slice(cursor, path.start) + (path.quote ? `${path.quote}…${path.quote}` : '…') + suffix
    cursor = end
  }
  return shown + line.slice(cursor)
}

/** The lines worth showing: not blank, and not npm's pointer to a log that sits in the home folder. */
function shownLines(output: string): string[] {
  return output.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
    .filter(line => !/complete log of this run/iu.test(line))
}
/**
 * This machine's own home folder and account name, wherever they sit: a host whose home is not under `/home` or
 * `/Users` (`/data/zach`, `/private/var/…`) would otherwise keep its user name in what the installer printed.
 */
function ownNames(): RegExp[] {
  const names: RegExp[] = []
  try { const home = homedir(); if (home.length > 1) names.push(new RegExp(escaped(home), 'giu')) } catch { /* No home to take out. */ }
  // The account name only as a folder in a path, so a word that happens to match it stays.
  try { const user = userInfo().username; if (user) names.push(new RegExp(`(?<=[\\\\/])${escaped(user)}(?=[\\\\/\\s"']|$)`, 'giu')) } catch { /* No account name. */ }
  return names
}
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const redact = (line: string): string => {
  let shown = redactPaths(line)
  for (const name of ownNames()) shown = shown.replace(name, '…')
  return shown.trim()
}

/**
 * What the installer said, bounded and without the machine in it. npm's last line is usually where
 * it put its log ("A complete log of this run can be found in C:\Users\<name>\..."), which is a home
 * folder and a user name on their way to the card, to Settings and to the turn record on disk. That
 * line is dropped, and any absolute path left in the one shown is replaced by an ellipsis.
 */
export function installerDetail(stderr: string): string | undefined {
  const tail = shownLines(stderr).at(-1)
  if (tail === undefined) return undefined
  const redacted = redact(tail)
  return redacted ? redacted.slice(0, 200) : undefined
}

/**
 * The last few lines the installer printed, for "What mise printed" under a failed update's Details: the same lines
 * `installerDetail` would choose from, each without a home folder, at most eight of them and 1,200 characters.
 */
export function installerOutput(output: string, lines = 8): string | undefined {
  const shown = shownLines(output).slice(-lines).map(line => redact(line).slice(0, 300)).filter(Boolean)
  if (!shown.length) return undefined
  let text = shown.join('\n')
  while (text.length > 1200 && shown.length > 1) { shown.shift(); text = shown.join('\n') }
  return text.slice(0, 1200)
}
