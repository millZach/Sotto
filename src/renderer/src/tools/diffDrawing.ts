import type { ElementContent, Root } from 'hast'
import type { Highlighter } from '../agents/codeHighlighter'
import { parseUnifiedDiff, type DiffLine } from './changesStore'
import { shortestEdits } from './turnDiff'

/**
 * What Changes and the transcript both draw on top of a diff's lines: which removed line became which added line, the
 * words that changed between them, syntax colour for code and Markdown's own shape for a document. All of it runs when
 * a diff is about to be seen, never on an update, and all of it is capped per file: past a cap a line simply draws plain.
 */

/** A file past this many characters of changed lines gets no more word marks or similarity pairing. */
const MAX_WORD_CHARS = 200_000
/** A line longer than this is not worth comparing word by word. */
const MAX_LINE_CHARS = 12_000
/** How many word edits one line pair may take before it counts as rewritten. */
const MAX_WORD_EDITS = 256
/** A run of changed lines bigger than this pairs in order rather than by likeness (cells of the comparison table). */
const MAX_PAIR_CELLS = 2_500
/** A file's lines past this many characters draw without syntax colour. */
const MAX_SYNTAX_CHARS = 120_000
/** Below this likeness two lines are different lines, not one line edited. */
const MIN_LIKENESS = 0.34
/** When more than this share of both lines changed, the line was rewritten; marking its words would only be noise. */
const REWRITTEN_SHARE = 0.68
/** The most of a diff read to guess its language when nothing names the file. */
const GUESS_SAMPLE_CHARS = 1_600
const GUESSED_LANGUAGES = ['typescript', 'javascript', 'python', 'css', 'scss', 'json', 'bash', 'go', 'rust', 'java', 'cpp', 'csharp', 'xml', 'yaml', 'sql', 'ruby', 'php', 'swift', 'kotlin']

export interface TextRange { readonly start: number; readonly end: number }
export interface TextToken extends TextRange { readonly className: string }
/** What a line of a document is, which sets its shape. */
export type DocumentLine = 'heading-1' | 'heading-2' | 'heading-3' | 'quote' | 'list' | 'fence' | 'table'
export interface LinePaint {
  readonly marks?: readonly TextRange[]
  readonly tokens?: readonly TextToken[]
  readonly shape?: DocumentLine
}

export type Reading = 'document' | 'code'

export interface DiffDecoration {
  readonly reading: Reading
  /** Which added line (by index) each removed line became. */
  readonly pairs: ReadonlyMap<number, number>
  readonly paint: ReadonlyMap<DiffLine, LinePaint>
}

const DOCUMENT_EXTENSIONS = new Set(['md', 'mdx', 'markdown', 'mdown', 'txt', 'text', 'rst', 'adoc', 'asciidoc'])

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? name : name.slice(dot + 1)
}

/** Whether a file is words to read rather than code. */
export const isDocumentPath = (path: string): boolean => DOCUMENT_EXTENSIONS.has(extension(path))

/** The grammar for a file's name. The highlighter knows every grammar's common file endings as aliases. */
export function languageOfPath(path: string, highlighter: Highlighter): string | null {
  const ending = extension(path)
  return highlighter.registered(ending) ? ending : null
}

const CODE_LINE = /[;{}]\s*$|^\s*(?:\/\/|\/\*|\*\s|#include|import\s.+from\s|from\s+\S+\s+import\s|def\s|class\s\w+|function\s|const\s|let\s|return\b|if\s*\()|=>|\(\)|===|!==|<\/\w+>/u
const MARKDOWN_LINE = /^(?:#{1,6}\s|>\s|\s*[-*+]\s|\s*\d+\.\s)|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)/u
const SENTENCE_LINE = /^[^<>{}=;]*\p{L}+(?:\s+\S+){5,}/u

/**
 * Whether a diff with no file name to go on reads as words. Lines of code are a strong sign against, so a commented
 * code change stays code; Markdown's shapes and whole sentences are the signs for.
 */
export function looksLikeDocument(lines: readonly DiffLine[]): boolean {
  let code = 0, words = 0, total = 0
  for (const line of lines) {
    if (line.kind !== 'add' && line.kind !== 'remove' && line.kind !== 'context') continue
    const text = line.text.trim()
    if (!text) continue
    if (++total > 80) break
    if (CODE_LINE.test(text)) code++
    else if (MARKDOWN_LINE.test(text) || SENTENCE_LINE.test(text)) words++
  }
  return total > 0 && code <= total * 0.1 && words >= total * 0.4
}

const HEADER_LINE = /^(?:diff --git |index [\da-f]+\.\.[\da-f]+(?: \d+)?$|--- |\+\+\+ |(?:new|deleted) file mode \d+$|rename (?:from|to) |similarity index )/u

/** A file's meaningful lines: Git's substantive metadata (mode, rename, similarity) stays; raw patch paths go. */
export function fileLines(patch: string): DiffLine[] {
  return parseUnifiedDiff(patch).filter(line => line.kind !== 'meta' || !HEADER_LINE.test(line.text))
}

/**
 * Lines that were replaced whole, removed then added (a provider's before and after text), with the lines both sides
 * share drawn back as unchanged. A run past the edit cap stays as it came, which is still the true change.
 */
function withSharedLines(lines: readonly DiffLine[]): DiffLine[] {
  const out: DiffLine[] = []
  for (let index = 0; index < lines.length;) {
    if (lines[index]!.kind === 'context') { out.push(lines[index]!); index++; continue }
    const removed: DiffLine[] = [], added: DiffLine[] = []
    for (; index < lines.length && lines[index]!.kind !== 'context'; index++) (lines[index]!.kind === 'remove' ? removed : added).push(lines[index]!)
    const edits = removed.length > 0 && added.length > 0 && removed.length + added.length <= 800
      ? shortestEdits(removed.map(line => line.text), added.map(line => line.text), 400) : null
    if (!edits) { out.push(...removed, ...added); continue }
    for (const edit of edits) out.push(edit.kind === 'same' ? { kind: 'context', text: added[edit.new]!.text, oldLine: null, newLine: null } : edit.kind === 'remove' ? removed[edit.old]! : added[edit.new]!)
  }
  return out
}

/**
 * A diff as the transcript or a reply carries it: a Git patch with hunks, a provider's bare hunks, or lines that only
 * carry `+` and `-`. Without hunks there are no line numbers to draw.
 */
export function parseDiffText(text: string): DiffLine[] {
  if (/^@@ -\d/mu.test(text)) {
    const several = (text.match(/^diff --git /gmu)?.length ?? 0) > 1
    return several ? parseUnifiedDiff(text).filter(line => line.kind !== 'meta' || line.text.startsWith('diff --git ') || !HEADER_LINE.test(line.text)) : fileLines(text)
  }
  const source = text.endsWith('\n') ? text.slice(0, -1) : text
  if (source === '') return []
  const lines = source.split('\n').filter(line => !/^(?:diff --git |index [\da-f]+\.\.|--- |\+\+\+ )/u.test(line)).map((line): DiffLine => {
    if (line.startsWith('+')) return { kind: 'add', text: line.slice(1), oldLine: null, newLine: null }
    if (line.startsWith('-')) return { kind: 'remove', text: line.slice(1), oldLine: null, newLine: null }
    if (line.startsWith('\\')) return { kind: 'note', text: line.slice(1).trim(), oldLine: null, newLine: null }
    return { kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line, oldLine: null, newLine: null }
  })
  return withSharedLines(lines)
}

/** The side a diff is all on, when a whole file came or went: nothing to compare, so nothing to wash. */
export function wholeSide(lines: readonly DiffLine[]): 'add' | 'remove' | undefined {
  let side: 'add' | 'remove' | undefined
  for (const line of lines) {
    if (line.kind === 'context') return undefined
    if (line.kind !== 'add' && line.kind !== 'remove') continue
    if (side && side !== line.kind) return undefined
    side = line.kind
  }
  return side
}

/** What a hunk head says: the line it starts on, and the section Git found above it. */
export function hunkHeading(text: string): { readonly line: number; readonly section: string } | null {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/u.exec(text)
  return match ? { line: Number(match[1]), section: match[2]!.trim() } : null
}

const WORD = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu

const WORDS_IN = /[\p{L}\p{N}_]+/gu
const inkLength = (text: string): number => text.replace(/\s+/gu, '').length

function joined(ranges: readonly TextRange[], text: string, prose: boolean): TextRange[] {
  const out: TextRange[] = []
  for (const range of ranges) {
    const last = out.at(-1)
    const gap = last ? text.slice(last.end, range.start) : ''
    // A space or a stray mark between two changes reads as one phrase, not two. In prose so does a word or two kept
    // between longer changes, or a rewritten sentence reads as confetti.
    const phrase = last !== undefined && (range.start - last.end <= 2 && !/[\p{L}\p{N}]/u.test(gap)
      || prose && (gap.match(WORDS_IN)?.length ?? 0) <= 2 && inkLength(gap) <= Math.max(inkLength(text.slice(last.start, last.end)), inkLength(text.slice(range.start, range.end))))
    if (phrase) out[out.length - 1] = { start: last.start, end: range.end }
    else out.push(range)
  }
  return out.map(range => withoutEdgeSpace(range, text))
}

/** A mark starts and ends on a word, so no wash hangs off the end of a wrapped line. A change that is only whitespace stays as it is: that is what changed. */
function withoutEdgeSpace(range: TextRange, text: string): TextRange {
  let { start, end } = range
  while (start < end && /\s/u.test(text[start]!)) start++
  while (end > start && /\s/u.test(text[end - 1]!)) end--
  return start === end ? range : { start, end }
}

const markedInk = (ranges: readonly TextRange[], text: string): number => ranges.reduce((sum, range) => sum + inkLength(text.slice(range.start, range.end)), 0)

/** The words that differ between a line and what it became, on each side. Null when the line was rewritten rather than edited. */
export function changedWords(before: string, after: string, prose = false): { readonly before: TextRange[]; readonly after: TextRange[] } | null {
  if (before === after || before.length > MAX_LINE_CHARS || after.length > MAX_LINE_CHARS) return null
  const a = before.match(WORD) ?? [], b = after.match(WORD) ?? []
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length, endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const offsets = (tokens: readonly string[]): number[] => { const at = [0]; for (const token of tokens) at.push(at.at(-1)! + token.length); return at }
  const atA = offsets(a), atB = offsets(b)
  const removed: TextRange[] = [], added: TextRange[] = []
  const edits = shortestEdits(a.slice(start, endA), b.slice(start, endB), MAX_WORD_EDITS)
  if (edits) {
    for (const edit of edits) {
      if (edit.kind === 'remove') removed.push({ start: atA[start + edit.old]!, end: atA[start + edit.old + 1]! })
      if (edit.kind === 'add') added.push({ start: atB[start + edit.new]!, end: atB[start + edit.new + 1]! })
    }
  } else {
    if (endA > start) removed.push({ start: atA[start]!, end: atA[endA]! })
    if (endB > start) added.push({ start: atB[start]!, end: atB[endB]! })
  }
  const marksA = joined(removed, before, prose), marksB = joined(added, after, prose)
  const inkA = inkLength(before), inkB = inkLength(after)
  if (inkA > 0 && inkB > 0 && markedInk(marksA, before) / inkA > REWRITTEN_SHARE && markedInk(marksB, after) / inkB > REWRITTEN_SHARE) return null
  return { before: marksA, after: marksB }
}

function wordSet(text: string): ReadonlySet<string> {
  const words = new Set<string>()
  for (const word of text.toLowerCase().match(WORD) ?? []) {
    if (word.trim() === '') continue
    words.add(word)
    if (words.size >= 200) break
  }
  return words
}

function likeness(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  const [small, large] = a.size < b.size ? [a, b] : [b, a]
  for (const word of small) if (large.has(word)) shared++
  return 2 * shared / (a.size + b.size)
}

/** Pairs a run of removed lines with the added lines they became, keeping both in order, the likeliest pairing overall. */
function pairRun(lines: readonly DiffLine[], removed: readonly number[], added: readonly number[], pairs: Map<number, number>, alike: boolean): void {
  const rows = removed.length, columns = added.length
  if (rows === 0 || columns === 0) return
  if (rows === 1 && columns === 1) { pairs.set(removed[0]!, added[0]!); return }
  if (!alike || rows * columns > MAX_PAIR_CELLS) {
    for (let index = 0; index < Math.min(rows, columns); index++) pairs.set(removed[index]!, added[index]!)
    return
  }
  const setsA = removed.map(index => wordSet(lines[index]!.text)), setsB = added.map(index => wordSet(lines[index]!.text))
  const width = columns + 1
  const score = new Float32Array((rows + 1) * width), step = new Uint8Array((rows + 1) * width)
  for (let row = 1; row <= rows; row++) {
    for (let column = 1; column <= columns; column++) {
      const like = likeness(setsA[row - 1]!, setsB[column - 1]!)
      const diagonal = like >= MIN_LIKENESS ? score[(row - 1) * width + column - 1]! + like : -1
      const up = score[(row - 1) * width + column]!, left = score[row * width + column - 1]!
      const best = Math.max(diagonal, up, left)
      score[row * width + column] = best
      step[row * width + column] = best === diagonal ? 2 : best === up ? 1 : 0
    }
  }
  for (let row = rows, column = columns; row > 0 && column > 0;) {
    const taken = step[row * width + column]
    if (taken === 2) { pairs.set(removed[row - 1]!, added[column - 1]!); row--; column-- } else if (taken === 1) row--
    else column--
  }
}

/** Which added line each removed line became, across the file. */
export function pairChangedLines(lines: readonly DiffLine[]): Map<number, number> {
  const pairs = new Map<number, number>()
  let budget = MAX_WORD_CHARS
  for (let index = 0; index < lines.length;) {
    const kind = lines[index]!.kind
    if (kind !== 'remove' && kind !== 'add') { index++; continue }
    const removed: number[] = [], added: number[] = []
    for (; index < lines.length && (lines[index]!.kind === 'remove' || lines[index]!.kind === 'add'); index++) {
      (lines[index]!.kind === 'remove' ? removed : added).push(index)
      budget -= lines[index]!.text.length
    }
    pairRun(lines, removed, added, pairs, budget > 0)
  }
  return pairs
}

/**
 * The order a document's lines read best in: each removed line straight above what it became, so an edited sentence
 * sits under the sentence it replaced. Every line stays once; only a run of changes moves, never past unchanged lines.
 */
export function readingOrder(lines: readonly DiffLine[], pairs: ReadonlyMap<number, number>): number[] {
  const order: number[] = []
  const partner = new Map<number, number>()
  for (const [removed, added] of pairs) partner.set(added, removed)
  for (let index = 0; index < lines.length;) {
    if (lines[index]!.kind !== 'remove' && lines[index]!.kind !== 'add') { order.push(index++); continue }
    const removed: number[] = [], added: number[] = []
    for (; index < lines.length && (lines[index]!.kind === 'remove' || lines[index]!.kind === 'add'); index++) (lines[index]!.kind === 'remove' ? removed : added).push(index)
    let r = 0, a = 0
    while (r < removed.length || a < added.length) {
      const old = removed[r], next = added[a]
      if (old !== undefined && next !== undefined && pairs.get(old) === next) { order.push(old, next); r++; a++ }
      else if (old !== undefined && !pairs.has(old)) { order.push(old); r++ }
      else if (next !== undefined && !partner.has(next)) { order.push(next); a++ }
      else if (old !== undefined) { order.push(old); r++ }
      else { order.push(next!); a++ }
    }
  }
  return order
}

const INLINE = /(\*\*|__)(?=\S)(.+?)(?<=\S)\1|(?<![\p{L}\p{N}*_])([*_])(?=\S)([^*_\n]+?)(?<=\S)\3(?![\p{L}\p{N}*_])|(`+)(.+?)\5|!?\[([^\]\n]*)\]\(([^)\n]*)\)/gu

/** The shape of a line of Markdown, and its marks to draw faint. The words they dress stay as they are: this is the source, not the page. */
export function markdownPaint(text: string): Pick<LinePaint, 'shape' | 'tokens'> {
  const tokens: TextToken[] = []
  const marker = (start: number, end: number): void => { if (end > start) tokens.push({ start, end, className: 'diff-md-mark' }) }
  let shape: DocumentLine | undefined
  let from = 0
  const heading = /^(#{1,6})\s+/u.exec(text)
  const list = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/u.exec(text)
  const quote = /^(?:>\s?)+/u.exec(text)
  if (/^\s*(?:```|~~~)/u.test(text)) return { shape: 'fence', tokens: [{ start: 0, end: text.length, className: 'diff-md-mark' }] }
  if (/^\s*\|.*\|\s*$/u.test(text)) return { shape: 'table' }
  if (heading) {
    shape = heading[1]!.length === 1 ? 'heading-1' : heading[1]!.length === 2 ? 'heading-2' : 'heading-3'
    marker(0, heading[0].length)
    from = heading[0].length
  } else if (quote) {
    shape = 'quote'
    marker(0, quote[0].length)
    from = quote[0].length
  } else if (list) {
    shape = 'list'
    marker(0, list[0].length)
    from = list[0].length
  }
  INLINE.lastIndex = from
  for (let match = INLINE.exec(text); match; match = INLINE.exec(text)) {
    const start = match.index, end = start + match[0].length
    if (match[1]) { marker(start, start + 2); marker(end - 2, end) }
    else if (match[3]) { marker(start, start + 1); marker(end - 1, end) }
    else if (match[5]) { const size = match[5].length; marker(start, start + size); marker(end - size, end) }
    else {
      const open = match[0].indexOf('[') + 1, label = match[7]!.length
      marker(start, start + open)
      marker(start + open + label, end)
    }
  }
  return { ...(shape ? { shape } : {}), ...(tokens.length ? { tokens } : {}) }
}

/** A highlighted text's coloured stretches, by line. Nested spans flatten to one stretch carrying every class around it. */
function tokensByLine(tree: Root): TextToken[][] {
  const out: TextToken[][] = [[]]
  let column = 0
  const walk = (nodes: readonly ElementContent[], classes: string): void => {
    for (const node of nodes) {
      if (node.type === 'text') {
        const parts = node.value.split('\n')
        parts.forEach((part, index) => {
          if (index > 0) { out.push([]); column = 0 }
          if (part && classes) out.at(-1)!.push({ start: column, end: column + part.length, className: classes })
          column += part.length
        })
      } else if (node.type === 'element') {
        const own = Array.isArray(node.properties.className) ? node.properties.className.join(' ') : ''
        walk(node.children, own ? classes ? `${classes} ${own}` : own : classes)
      }
    }
  }
  walk(tree.children as ElementContent[], '')
  return out
}

/** Colours each hunk's two sides as text of their own, so a string or comment that spans lines stays one. */
function syntaxPaint(lines: readonly DiffLine[], language: string, highlighter: Highlighter, into: Map<DiffLine, LinePaint>): void {
  if (lines.reduce((sum, line) => sum + line.text.length, 0) > MAX_SYNTAX_CHARS) return
  const color = (side: readonly DiffLine[]): void => {
    if (side.length === 0) return
    let byLine: TextToken[][]
    try { byLine = tokensByLine(highlighter.highlight(language, side.map(line => line.text).join('\n'))) } catch { return }
    side.forEach((line, index) => {
      const tokens = byLine[index]
      if (tokens?.length) into.set(line, { ...into.get(line), tokens })
    })
  }
  let hunk: DiffLine[] = []
  const flush = (): void => {
    if (hunk.some(line => line.kind === 'remove')) color(hunk.filter(line => line.kind === 'remove' || line.kind === 'context'))
    color(hunk.filter(line => line.kind === 'add' || line.kind === 'context'))
    hunk = []
  }
  for (const line of lines) {
    if (line.kind === 'add' || line.kind === 'remove' || line.kind === 'context') hunk.push(line)
    else flush()
  }
  flush()
}

/** The language of a diff with no file name, guessed from a sample of its text among the common ones. */
export function guessLanguage(lines: readonly DiffLine[], highlighter: Highlighter): string | null {
  let sample = ''
  for (const line of lines) {
    if (line.kind !== 'add' && line.kind !== 'remove' && line.kind !== 'context') continue
    sample += `${line.text}\n`
    if (sample.length > GUESS_SAMPLE_CHARS) break
  }
  if (sample.trim() === '') return null
  try { return highlighter.highlightAuto(sample, { subset: GUESSED_LANGUAGES }).data?.language ?? null } catch { return null }
}

export interface DecorateOptions {
  readonly reading: Reading
  /** The grammar for code, if the file has one and the highlighter has loaded. */
  readonly language?: string | null | undefined
  readonly highlighter?: Highlighter | null | undefined
}

/** Everything a diff's lines draw with. Pure, and bounded by the caps at the top of this file. */
export function decorateDiff(lines: readonly DiffLine[], { reading, language, highlighter }: DecorateOptions): DiffDecoration {
  const pairs = pairChangedLines(lines)
  const paint = new Map<DiffLine, LinePaint>()
  if (reading === 'document') {
    let fenced = false
    for (const line of lines) {
      if (line.kind === 'hunk') fenced = false
      if (line.kind !== 'add' && line.kind !== 'remove' && line.kind !== 'context') continue
      const fence = /^\s*(?:```|~~~)/u.test(line.text)
      // Code inside a fence keeps its letters alone: it is not Markdown.
      if (fenced && !fence) { paint.set(line, { shape: 'fence' }); continue }
      if (fence && line.kind !== 'remove') fenced = !fenced
      const shaped = markdownPaint(line.text)
      if (shaped.shape || shaped.tokens) paint.set(line, shaped)
    }
  } else if (language && highlighter) syntaxPaint(lines, language, highlighter, paint)
  let budget = MAX_WORD_CHARS
  for (const [removed, added] of pairs) {
    const before = lines[removed]!, after = lines[added]!
    budget -= before.text.length + after.text.length
    if (budget < 0) break
    const words = changedWords(before.text, after.text, reading === 'document')
    if (!words) continue
    if (words.before.length) paint.set(before, { ...paint.get(before), marks: words.before })
    if (words.after.length) paint.set(after, { ...paint.get(after), marks: words.after })
  }
  return { reading, pairs, paint }
}

/** One stretch of a painted line: its text, its classes and whether its words changed. */
export interface PaintedPart { readonly text: string; readonly className?: string | undefined; readonly marked: boolean }

/** A line cut where its colours and its changed words begin and end. */
export function paintedParts(text: string, { tokens = [], marks = [] }: Pick<LinePaint, 'tokens' | 'marks'>): PaintedPart[] {
  if (tokens.length === 0 && marks.length === 0) return [{ text, marked: false }]
  const cuts = new Set<number>([0, text.length])
  for (const range of tokens) { cuts.add(Math.min(range.start, text.length)); cuts.add(Math.min(range.end, text.length)) }
  for (const range of marks) { cuts.add(Math.min(range.start, text.length)); cuts.add(Math.min(range.end, text.length)) }
  const points = [...cuts].sort((a, b) => a - b)
  const parts: PaintedPart[] = []
  let token = 0, mark = 0
  const ordered = tokens.length > 1 ? [...tokens].sort((a, b) => a.start - b.start) : tokens
  for (let index = 0; index + 1 < points.length; index++) {
    const start = points[index]!, end = points[index + 1]!
    while (token < ordered.length && ordered[token]!.end <= start) token++
    while (mark < marks.length && marks[mark]!.end <= start) mark++
    const over = ordered[token]
    const className = over && over.start <= start ? over.className : undefined
    parts.push({ text: text.slice(start, end), className, marked: mark < marks.length && marks[mark]!.start <= start })
  }
  return parts
}
