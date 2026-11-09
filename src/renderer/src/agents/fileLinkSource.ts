import type { Link, Nodes, Parents, PhrasingContent, Root, Text } from 'mdast'
import type { VFile } from 'vfile'

/**
 * File links as agents write them, mended before they are drawn. Markdown reads two forms differently from what the
 * agent meant, so this remark step puts them back from the reply's own text:
 *
 * - A backslash before punctuation is an escape, so `C:\Users\me\.claude\CLAUDE.md` loses the separator before `.claude`
 *   (#2218). A link whose path starts with a drive, `~` or `.` and a backslash keeps the path as the reply wrote it.
 * - A path with a space but no angle brackets, as in `[audit](D:/Watcher Audit/audit.md)`, is not a link at all. Written
 *   with brackets around a name and a path that reads as a file, it becomes the link the agent meant.
 *
 * Code stays as written, and a web address is never made here.
 */
export function remarkFileLinks() {
  return (tree: Root, file: VFile): void => {
    const source = typeof file.value === 'string' ? file.value : String(file.value ?? '')
    if (source.includes('](')) mend(tree, source)
  }
}

/** A Windows path written with backslashes from its drive, home or `.\` start, which an escape can shorten. */
const backslashed = (path: string): boolean => /^(?:\/?[a-z]:|~|\.{1,2})\\/iu.test(path)
/** A path as written, with a doubled backslash read as one, since that is the escape a writer meant. */
const unescapedSeparators = (path: string): string => path.replace(/\\\\/gu, '\\')
/** An absolute, home, file URL or dot-relative path, never `/ ` and never another scheme. */
const LOCAL_START = /^(?:\/?[a-z]:[\\/]|\/(?!\s)|~[\\/]|\.{1,2}[\\/]|file:\/\/)/iu
/** A relative path that ends in a file name, with any location after it. */
const RELATIVE_FILE = /[\\/].*\.[a-z0-9]{1,10}(?:#[^#/\\]*|:\d+(?:[:-]\d+)?)?$/iu
/** `[name](path)` left as text because its path holds a space. */
const BRACKETED = /\[([^[\]\n]+)\]\(([^()<>"\n]*\s[^()<>"\n]*)\)/gu

function mend(parent: Parents, source: string): void {
  if (parent.type === 'link') { keepWrittenPath(parent, source); return }
  if (parent.type === 'linkReference') return
  const children = parent.children as Nodes[]
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!
    if (child.type === 'text') {
      const parts = linksInText(child, source)
      if (parts) { children.splice(index, 1, ...parts); index += parts.length - 1 }
    } else if ('children' in child) mend(child, source)
  }
}

/** The destination of an inline link as the reply wrote it, from the `(` after its label. */
function writtenDestination(source: string, open: number): string | null {
  if (source[open] !== '(') return null
  let at = open + 1
  while (/[ \t\n]/u.test(source[at] ?? '')) at++
  if (source[at] === '<') {
    const end = source.indexOf('>', at + 1)
    return end < 0 ? null : source.slice(at + 1, end)
  }
  let depth = 0
  let end = at
  for (; end < source.length; end++) {
    const character = source[end]!
    if (character === '\\') { end++; continue }
    if (/\s/u.test(character)) break
    if (character === '(') depth++
    else if (character === ')' && depth-- === 0) break
  }
  return source.slice(at, Math.min(end, source.length))
}

function keepWrittenPath(link: Link, source: string): void {
  const start = link.position?.start.offset
  if (start === undefined || source[start] !== '[') return
  const last = link.children.at(-1)?.position?.end.offset
  const close = last ?? start + 1
  if (source[close] !== ']') return
  const written = writtenDestination(source, close + 1)
  if (written && backslashed(written)) link.url = unescapedSeparators(written)
}

/** Another scheme, such as `https:`, is never a file here; a drive letter is, and so is `file:`. */
const OTHER_SCHEME = /^(?![a-z]:[\\/])(?!file:)[a-z][a-z0-9+.-]*:/iu
const readsAsFile = (path: string): boolean => !OTHER_SCHEME.test(path) && (LOCAL_START.test(path) || RELATIVE_FILE.test(path))

function linksInText(text: Text, source: string): PhrasingContent[] | null {
  if (!text.value.includes('](')) return null
  const matches = [...text.value.matchAll(BRACKETED)]
  if (!matches.some(match => readsAsFile(match[2]!.trim()))) return null
  // The same text as the reply wrote it, for a Windows path an escape shortened. Used only when it lines up match for match.
  const start = text.position?.start.offset, end = text.position?.end.offset
  const written = start !== undefined && end !== undefined ? [...source.slice(start, end).matchAll(BRACKETED)] : []
  const lined = written.length === matches.length
  const parts: PhrasingContent[] = []
  let at = 0
  matches.forEach((match, index) => {
    const path = match[2]!.trim()
    if (!readsAsFile(path)) return
    const asWritten = lined ? written[index]![2]!.trim() : path
    if (match.index > at) parts.push({ type: 'text', value: text.value.slice(at, match.index) })
    parts.push({ type: 'link', url: backslashed(asWritten) ? unescapedSeparators(asWritten) : path, title: null, children: [{ type: 'text', value: match[1]! }] })
    at = match.index + match[0].length
  })
  if (at < text.value.length) parts.push({ type: 'text', value: text.value.slice(at) })
  return parts
}
