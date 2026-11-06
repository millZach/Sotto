import { describe, expect, it } from 'vitest'
import { common, createLowlight } from 'lowlight'
import type { DiffLine } from '../../../../src/renderer/src/tools/changesStore'
import { changeGlimpses, changedWords, decorateDiff, fileLines, guessLanguage, hunkHeading, hunkSection, isCommentLine, editWeight, isDocumentPath, languageOfPath, looksLikeDocument, markdownPaint, pairChangedLines, paintedParts, paintWithin, parseDiffText, readingOrder, wholeSide, wordSegments, type WordSegment } from '../../../../src/renderer/src/tools/diffDrawing'

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

/** A line read once as text: kept words plain, then [-went-]{+came+} at each change. */
const readOnce = (before: string, after: string, segments: readonly WordSegment[]): string => segments.map(segment => segment.kind === 'kept'
  ? after.slice(segment.after.start, segment.after.end)
  : `${segment.before.end > segment.before.start ? `[-${before.slice(segment.before.start, segment.before.end)}-]` : ''}${segment.after.end > segment.after.start ? `{+${after.slice(segment.after.start, segment.after.end)}+}` : ''}`).join('')

describe('wordSegments', () => {
  it('reads an edited sentence once, with what went before what came at each change', () => {
    const before = 'Status: an idea. Nothing is scheduled.', after = 'Status: an idea. Five pull requests are scheduled.'
    expect(readOnce(before, after, wordSegments(before, after)!)).toBe('Status: an idea. [-Nothing is-]{+Five pull requests are+} scheduled.')
  })

  it('keeps every character of both lines, each once and in order', () => {
    const before = '**Log checkpoint.** A worker thread runs them on a connection of its own, half a second after the last one.'
    const after = '**Log checkpoint.** The **store worker** runs them between its writes, half a second after the last one finished.'
    const segments = wordSegments(before, after)!
    const went = segments.map(segment => segment.kind === 'kept' ? after.slice(segment.after.start, segment.after.end) : before.slice(segment.before.start, segment.before.end)).join('')
    const came = segments.map(segment => after.slice(segment.after.start, segment.after.end)).join('')
    expect(went).toBe(before)
    expect(came).toBe(after)
  })

  it('leaves the space around a change kept, so each change starts and ends on a word', () => {
    const before = 'one two three', after = 'one four three'
    expect(wordSegments(before, after)).toEqual([{ kind: 'kept', after: { start: 0, end: 4 } }, { kind: 'changed', before: { start: 4, end: 7 }, after: { start: 4, end: 8 } }, { kind: 'kept', after: { start: 8, end: 14 } }])
  })

  it('reads a word or two kept between longer changes as part of one change', () => {
    const before = 'the quick brown fox jumps', after = 'the slow and steady brown tortoise jumps'
    expect(readOnce(before, after, wordSegments(before, after)!)).toBe('the [-quick brown fox-]{+slow and steady brown tortoise+} jumps')
  })

  it('leaves a rewritten line to stand above what it became', () => {
    expect(wordSegments('completely different words here today', 'nothing alike at all, not one bit')).toBeNull()
  })
})

describe('paintWithin', () => {
  it("cuts a line's colours to a stretch of it, counted from the stretch", () => {
    expect(paintWithin({ tokens: [{ start: 0, end: 2, className: 'a' }, { start: 5, end: 9, className: 'b' }] }, { start: 1, end: 7 })).toEqual({ tokens: [{ start: 0, end: 1, className: 'a' }, { start: 4, end: 6, className: 'b' }] })
    expect(paintWithin(undefined, { start: 0, end: 3 })).toEqual({})
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

  it('shows a hunk section only where it names a place, and cuts it on a whole word', () => {
    // An import names no place in the file, and a document's hunk is named only by a heading.
    expect(hunkSection(hunkHeading("@@ -15,6 +15,6 @@ import { a } from './b'")!, 'code')).toBe('')
    expect(hunkSection(hunkHeading('@@ -267,6 +267,6 @@ export class ThreadStore {')!, 'code')).toBe('export class ThreadStore {')
    expect(hunkSection(hunkHeading('@@ -335,11 +340,12 @@ Answering a question or permission request')!, 'document')).toBe('')
    expect(hunkSection(hunkHeading('@@ -7,3 +7,3 @@ ## Open questions ##')!, 'document')).toBe('Open questions')
    const cut = 'export function readTheWholeThreadFromTheStore(threadId: string, options: ReadOptio'
    expect(hunkSection(hunkHeading(`@@ -40,6 +40,6 @@ ${cut}`)!, 'code')).toBe('export function readTheWholeThreadFromTheStore(threadId: string, options:')
  })
})

describe('markdownPaint', () => {
  it('shapes a heading, and its mark dresses the whole line', () => {
    expect(markdownPaint('## The order')).toEqual({ shape: 'heading-2', tokens: [{ start: 0, end: 3, className: 'diff-md-mark', of: { start: 0, end: 12 } }] })
  })

  it('finds the marks of bold, code and links and the words each dresses, and keeps a list number', () => {
    const text = '1. **Bold** then `code` and [link](url)'
    const { tokens } = markdownPaint(text)
    expect(tokens?.map(token => [text.slice(token.start, token.end), token.className])).toEqual([
      ['1. ', 'diff-md-mark diff-md-number'], ['**', 'diff-md-mark'], ['Bold', 'diff-md-strong'], ['**', 'diff-md-mark'],
      ['`', 'diff-md-mark'], ['code', 'diff-md-code'], ['`', 'diff-md-mark'], ['[', 'diff-md-mark'], ['link', 'diff-md-link'], ['](url)', 'diff-md-mark'],
    ])
    expect(tokens?.[1]?.of).toEqual({ start: 3, end: 11 })
  })

  it('draws a dash as a bullet', () => {
    expect(markdownPaint('- Which job should leave first?').tokens?.[0]?.className).toBe('diff-md-mark diff-md-bullet')
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

  it('draws a document as its page unless a change goes through a mark without what it dresses', () => {
    const lines = fileLines('@@ -1,3 +1,3 @@\n-The **store worker** runs it.\n+The **event store** runs it.\n-Make it plain here.\n+Make it **plain** here.\n-Some words here.\n+Some words here, and **new bold ones** now.\n')
    const decoration = decorateDiff(lines, { reading: 'document' })
    // A change inside what the marks dress, or words that came with their marks, leaves the page.
    expect(decoration.paint.get(lines[2]!)?.source).toBeUndefined()
    expect(decoration.paint.get(lines[6]!)?.source).toBeUndefined()
    // Only making words bold would vanish on the page, so that line shows its marks.
    expect(decoration.paint.get(lines[3]!)?.source).toBe(true)
    expect(decoration.paint.get(lines[4]!)?.source).toBe(true)
  })

  it('reads a reworked paragraph once, as it is now, and says it was reworked', () => {
    const before = 'Main hands each write to the worker, which commits it and confirms it back, and a read that cannot wait lays the held events over what the store returns, so the publish never waits for the disk.'
    const after = 'Main posts each write to the store worker, which commits it and confirms it back, and a read that cannot wait lays the held events over what the store returns, so the update path never waits for the disk.'
    const lines = fileLines(`@@ -1 +1 @@\n-${before}\n+${after}\n`)
    const segments = wordSegments(before, after)!
    expect(editWeight(before, after, segments)).toBe('reworked')
    const decoration = decorateDiff(lines, { reading: 'document' })
    expect(decoration.inline.get(lines[1]!)).toEqual(segments)
    expect(decoration.reworked.has(lines[1]!)).toBe(true)
    expect(decoration.rewritten.has(lines[1]!)).toBe(false)
    expect(decoration.paint.get(lines[1]!)?.paired).toBeUndefined()
  })

  it('leaves a line edited in a place or two read once with what went struck through', () => {
    const before = 'Status: an idea. Nothing is scheduled.', after = 'Status: an idea. Five pull requests are scheduled.'
    expect(editWeight(before, after, wordSegments(before, after)!)).toBe('edited')
  })

  it('reads a line as it is now once one change runs longer than a few words, though it changed in one place', () => {
    const before = 'Every write goes this way. Today the store confirms each write as it makes it.'
    const after = 'Every write goes this way. An answer posted on its own holds the next write the same way, and the store worker confirms each write as it makes it.'
    expect(editWeight(before, after, wordSegments(before, after)!)).toBe('reworked')
  })

  it('reads a line that changed more than it kept as it is now, with no word marks', () => {
    const before = 'The worker thread runs them on a connection of its own, half a second after the last one finished, so no save on main runs one, and a save can still wait for one.'
    const after = 'The store worker runs them between its writes, half a second after the last one finished, so nothing on main runs one, and only the writer waits for it.'
    const segments = wordSegments(before, after)!
    expect(editWeight(before, after, segments)).toBe('rewritten')
    const lines = fileLines(`@@ -1 +1 @@\n-${before}\n+${after}\n`)
    const decoration = decorateDiff(lines, { reading: 'document' })
    expect(decoration.reworked.has(lines[1]!)).toBe(true)
    expect(decoration.rewritten.has(lines[1]!)).toBe(true)
  })

  it('glimpses a reworked line\'s changes as the words that went beside the words that came, as many as fit', () => {
    const before = '**Log checkpoint.** SQLite folding the log into `threads.sqlite`. A worker thread runs them on a connection of its own, half a second after the last one finished, so no save on main runs one. A save can still wait for one: once the log holds 16 MB the worker\'s RESTART takes the write lock.'
    const after = '**Log checkpoint.** SQLite folding the log into `threads.sqlite`. The store worker runs them between its writes, half a second after the last one finished, so nothing on main runs one. As the only writer it waits for no save: once the log holds 16 MB its RESTART waits a moment for main\'s reads to move off the log.'
    const glimpse = changeGlimpses(before, after, wordSegments(before, after)!)!
    const read = glimpse.glimpses.map(part => [part.lead ? after.slice(part.lead.start, part.lead.end) : null, before.slice(part.went.start, part.went.end), part.came ? after.slice(part.came.start, part.came.end) : null])
    // A change that starts a sentence leads with none of the one before it; a short one keeps two words of its place.
    expect(read[0]).toEqual([null, 'A worker thread runs them on a connection of its own', 'The store worker runs them between its writes'])
    expect(read[1]).toEqual(['finished, so', 'no save', 'nothing'])
    expect(glimpse.more).toBe(true)
  })

  it('ends a long side on a whole word, shows a whole rewrite\'s earlier start alone, and has none when nothing went', () => {
    const lead = 'One write to the event store, as main hands it over. '
    const before = `${lead}Today the store confirms it.`, after = `${lead}An answer posted on its own, and a history-publishing host's write, hold the thread's next write the same way. The store confirms it.`
    const [part] = changeGlimpses(before, after, wordSegments(before, after)!)!.glimpses
    expect(before.slice(part!.went.start, part!.went.end)).toBe('Today the')
    expect(after.slice(part!.came!.start, part!.came!.end)).toBe('An answer posted on its own, and a history-publishing')
    expect(part!.cameCut).toBe(true)
    const old = 'The worker thread that will make every write to the event store and run its log checkpoints, confirming each posted write back to main, which then only reads.'
    const whole = changeGlimpses(old, 'Something else entirely.', [{ kind: 'changed', before: { start: 0, end: old.length }, after: { start: 0, end: 24 } }])!
    expect(whole.glimpses).toHaveLength(1)
    expect(whole.glimpses[0]!.came).toBeNull()
    expect(whole.glimpses[0]!.wentCut).toBe(true)
    expect(old[whole.glimpses[0]!.went.end]).toBe(' ')
    const grown = 'Every write goes this way. Until a write is confirmed, main holds it.'
    const longer = `${grown} An answer posted on its own waits the same way.`
    expect(changeGlimpses(grown, longer, wordSegments(grown, longer)!)).toBeNull()
  })

  it('reads a long paragraph rewritten whole once, as it is now, and leaves a short one above what it became', () => {
    const before = 'The worker thread that will make every write to the event store and run its log checkpoints, confirming each posted write back to main. It is planned, not built: until it is, the store confirms on main.'
    const after = 'Store worker thread making each write the event store holds, and its checkpoints too. Its commit shows before its confirmation arrives, so the overlay leaves out what main already holds, and closing waits a minute at most.'
    const long = fileLines(`@@ -1 +1 @@\n-${before}\n+${after}\n`)
    const decoration = decorateDiff(long, { reading: 'document' })
    expect(decoration.inline.get(long[1]!)).toEqual([{ kind: 'changed', before: { start: 0, end: before.length }, after: { start: 0, end: after.length } }])
    expect(decoration.rewritten.has(long[1]!)).toBe(true)
    const short = fileLines('@@ -1 +1 @@\n-## Open questions\n+## The order\n')
    expect(decorateDiff(short, { reading: 'document' }).inline.size).toBe(0)
  })

  it("reads a document's edited line once with what it became, and leaves code as two lines", () => {
    const patch = '@@ -1 +1 @@\n-Status: an idea. Nothing is scheduled.\n+Status: an idea. Five pull requests are scheduled.\n'
    const lines = fileLines(patch)
    expect(decorateDiff(lines, { reading: 'document' }).inline.get(lines[1]!)).toBeDefined()
    expect(decorateDiff(lines, { reading: 'code' }).inline.size).toBe(0)
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

describe('isCommentLine', () => {
  const painted = (lines: readonly DiffLine[]) => decorateDiff(lines, { reading: 'code', language: 'typescript', highlighter })
  it('knows a line that is only a comment, by its shape or its colours', () => {
    const rows = [line('context', '/**'), line('context', ' * How long main looks for a gone worker.'), line('context', ' */'), line('context', '// A note'), line('context', 'const a = 1 // and a note')]
    const decoration = painted(rows)
    expect(rows.map(row => isCommentLine(row.text, decoration.paint.get(row)))).toEqual([true, true, true, true, false])
  })
  it('knows a comment a hunk opens partway through, which the highlighter reads as code', () => {
    const row = line('context', "   * The projection's shape. A change here means the `messages` table is rebuilt")
    expect(isCommentLine(row.text, painted([row]).paint.get(row))).toBe(true)
  })
  it('reads a comment by its colours in a language with other marks', () => {
    const row = line('context', '# Version 2 adds the checkpoint acknowledgement')
    const decoration = decorateDiff([row], { reading: 'code', language: 'python', highlighter })
    expect(isCommentLine(row.text, decoration.paint.get(row))).toBe(true)
    expect(isCommentLine('x = 2 * y', undefined)).toBe(false)
    expect(isCommentLine('   ', undefined)).toBe(false)
  })
})
