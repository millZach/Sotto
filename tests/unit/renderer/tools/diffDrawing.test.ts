import { describe, expect, it } from 'vitest'
import { common, createLowlight } from 'lowlight'
import type { DiffLine } from '../../../../src/renderer/src/tools/changesStore'
import { changedWords, decorateDiff, fileLines, guessLanguage, hunkHeading, isDocumentPath, languageOfPath, looksLikeDocument, markdownPaint, pairChangedLines, paintedParts, parseDiffText, readingOrder, wholeSide } from '../../../../src/renderer/src/tools/diffDrawing'

const highlighter = createLowlight(common)
const line = (kind: DiffLine['kind'], text: string): DiffLine => ({ kind, text, oldLine: null, newLine: null })
const marked = (text: string, ranges: readonly { start: number; end: number }[]): string[] => ranges.map(range => text.slice(range.start, range.end))

describe('changedWords', () => {
  it('finds only the words that changed, on each side', () => {
    const before = 'Status: an idea. Nothing is scheduled.', after = 'Status: an idea. Five pull requests are scheduled.'
    const words = changedWords(before, after)!
    expect(marked(before, words.before)).toEqual(['Nothing is'])
    expect(marked(after, words.after)).toEqual(['Five pull requests are'])
  })

  it('reads a run of changed words split by a space as one phrase', () => {
    const before = 'one two three', after = 'one four five three'
    expect(marked(after, changedWords(before, after)!.after)).toEqual(['four five'])
  })

  it('marks nothing when a line was rewritten rather than edited', () => {
    expect(changedWords('completely different words here today', 'nothing alike at all, not one bit')).toBeNull()
  })

  it('leaves a very long line alone rather than compare it', () => {
    expect(changedWords('a '.repeat(7_000), 'b '.repeat(7_000))).toBeNull()
  })
})

describe('pairChangedLines', () => {
  it('pairs a line with what it became, past a line that is new', () => {
    const lines = [
      line('remove', 'The worker runs them on a connection of its own.'),
      line('add', 'A brand new sentence nobody wrote before today.'),
      line('add', 'The worker runs them between its writes, on a connection of its own.'),
    ]
    expect([...pairChangedLines(lines)]).toEqual([[0, 2]])
  })

  it('pairs in order when a run is too big to compare, so its cost stays bounded', () => {
    const lines = [...Array.from({ length: 60 }, (_, index) => line('remove', `old ${index}`)), ...Array.from({ length: 60 }, (_, index) => line('add', `new ${index}`))]
    const pairs = pairChangedLines(lines)
    expect(pairs.size).toBe(60)
    expect(pairs.get(5)).toBe(65)
  })
})

describe('readingOrder', () => {
  it('sets each edited line above what it became and moves nothing past unchanged lines', () => {
    const lines = [line('context', 'a'), line('remove', 'b one'), line('remove', 'c one'), line('add', 'b two'), line('add', 'c two'), line('context', 'd')]
    expect(readingOrder(lines, new Map([[1, 3], [2, 4]]))).toEqual([0, 1, 3, 2, 4, 5])
  })

  it('keeps every line exactly once whatever the pairing', () => {
    const lines = [line('remove', 'a'), line('add', 'x'), line('remove', 'b'), line('add', 'y'), line('add', 'z')]
    expect(readingOrder(lines, new Map([[0, 3]])).sort()).toEqual([0, 1, 2, 3, 4])
  })
})

describe('parseDiffText', () => {
  it('draws a whole replacement with the lines both sides share as unchanged', () => {
    const parsed = parseDiffText('-a\n-b\n-c\n+a\n+B\n+c')
    expect(parsed.map(row => [row.kind, row.text])).toEqual([['context', 'a'], ['remove', 'b'], ['add', 'B'], ['context', 'c']])
  })

  it('numbers a patch and drops its raw paths', () => {
    const parsed = parseDiffText('--- a/x\n+++ b/x\n@@ -4 +4 @@ top\n-a\n+b')
    expect(parsed.map(row => row.kind)).toEqual(['hunk', 'remove', 'add'])
    expect(parsed[1]!.oldLine).toBe(4)
  })

  it('keeps the head of each file of a patch of several', () => {
    const parsed = parseDiffText('diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\n@@ -1 +1 @@\n-c\n+d')
    expect(parsed.filter(row => row.text.startsWith('diff --git'))).toHaveLength(2)
  })
})

describe('what a diff is', () => {
  it('knows a document by its name', () => {
    expect(isDocumentPath('docs/plans/split.md')).toBe(true)
    expect(isDocumentPath('src/a.ts')).toBe(false)
  })

  it('finds the grammar for a file ending', () => {
    expect(languageOfPath('src/a.tsx', highlighter)).toBe('tsx')
    expect(languageOfPath('notes.unknown', highlighter)).toBeNull()
  })

  it('tells words from code by the text alone', () => {
    expect(looksLikeDocument([line('add', '# The order'), line('add', 'Five pull requests, smallest risk first, each safe to merge alone.'), line('remove', 'Status: an idea. Nothing is scheduled at all.')])).toBe(true)
    expect(looksLikeDocument([line('add', 'const ready = true;'), line('remove', 'function start() {'), line('context', 'return ready')])).toBe(false)
  })

  it('guesses a language from a sample', () => {
    expect(guessLanguage([line('add', 'def start(self):'), line('add', '    import os'), line('add', '    return os.getcwd()')], highlighter)).toBe('python')
  })

  it('knows when a whole file came or went', () => {
    expect(wholeSide([line('hunk', '@@ -0,0 +1 @@'), line('add', 'a')])).toBe('add')
    expect(wholeSide([line('add', 'a'), line('remove', 'b')])).toBeUndefined()
    expect(wholeSide([line('context', 'c'), line('add', 'a')])).toBeUndefined()
  })

  it('reads a hunk head for its line and section', () => {
    expect(hunkHeading('@@ -335,11 +340,12 @@ Answering a question')).toEqual({ line: 340, section: 'Answering a question' })
    expect(hunkHeading('@@ -1 +1 @@')).toEqual({ line: 1, section: '' })
    // Git keeps 80 bytes of the line it names a hunk by and drops the rest unmarked.
    const cut = "import { watcherOwnChangeSchema, watcherObservedChangesSchema } from '../../shar"
    expect(hunkHeading(`@@ -15,6 +15,6 @@ ${cut}`)).toEqual({ line: 15, section: cut, cut: true })
    expect(hunkHeading('@@ -15,6 +15,6 @@ export class ThreadStore {')?.cut).toBeUndefined()
    expect(hunkHeading('not a head')).toBeNull()
  })
})

describe('markdownPaint', () => {
  it('shapes a heading and fades its mark', () => {
    expect(markdownPaint('## The order')).toEqual({ shape: 'heading-2', tokens: [{ start: 0, end: 3, className: 'diff-md-mark' }] })
  })

  it('fades the marks of bold, code and links, and leaves the words they dress as the source has them', () => {
    const { tokens } = markdownPaint('1. **Bold** then `code` and [link](url)')
    expect(tokens?.map(token => token.className)).toEqual(Array.from({ length: 7 }, () => 'diff-md-mark'))
    expect(tokens?.map(({ start, end }) => '1. **Bold** then `code` and [link](url)'.slice(start, end))).toEqual(['1. ', '**', '**', '`', '`', '[', '](url)'])
  })

  it('leaves plain words alone', () => {
    expect(markdownPaint('Just a sentence with a * star.')).toEqual({})
  })
})

describe('decorateDiff', () => {
  it('keeps each stretch of a line whole when colour and changed words cross', () => {
    const lines = fileLines('@@ -1 +1 @@\n-const ready = false\n+const ready = true\n')
    const decoration = decorateDiff(lines, { reading: 'code', language: 'ts', highlighter })
    const after = lines[2]!
    const parts = paintedParts(after.text, decoration.paint.get(after)!)
    expect(parts.map(part => part.text).join('')).toBe(after.text)
    expect(parts.filter(part => part.marked).map(part => part.text)).toEqual(['true'])
    expect(parts.find(part => part.text === 'const')?.className).toContain('hljs-keyword')
  })

  it('keeps a comment that spans lines coloured on every one of them', () => {
    const lines = fileLines('@@ -1,3 +1,3 @@\n /* one\n-two\n+TWO\n three */\n')
    const decoration = decorateDiff(lines, { reading: 'code', language: 'ts', highlighter })
    for (const row of lines.slice(1)) expect(decoration.paint.get(row)?.tokens?.[0]?.className).toContain('hljs-comment')
  })

  it('does not treat what is inside a fence as Markdown', () => {
    const lines = fileLines('@@ -1,3 +1,3 @@\n ```\n # not a heading\n ```\n')
    const decoration = decorateDiff(lines, { reading: 'document' })
    expect(decoration.paint.get(lines[2]!)).toEqual({ shape: 'fence' })
  })

  it('stays bounded on a very large file, leaving the lines past the cap plain', () => {
    const text = 'x '.repeat(400)
    const rows = Array.from({ length: 3_000 }, (_, index) => line(index % 2 === 0 ? 'remove' : 'add', `${text}${index}`))
    const started = performance.now()
    const decoration = decorateDiff(rows, { reading: 'code', language: 'ts', highlighter })
    expect(decoration.paint.has(rows.at(-1)!)).toBe(false)
    // A generous bound that only a whole-file comparison or colouring of every line could miss.
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})
