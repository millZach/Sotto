import React, { Fragment, memo, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { I18n } from '@lingui/core'
import { Check, Copy } from 'lucide-react'
import { highlighterNow, loadHighlighter, type Highlighter } from '../agents/codeHighlighter'
import { useTransientFlag, writeClipboard } from '../agents/richActions'
import { shownLineCount } from '../state/interfaceNumbers'
import type { DiffLine } from './changesStore'
import { decorateDiff, guessLanguage, hunkHeading, isDocumentPath, languageOfPath, looksLikeDocument, paintedParts, paintWithin, parseDiffText, readingOrder, wholeSide, type DiffDecoration, type LinePaint, type PaintedPart, type TextRange, type WordSegment } from './diffDrawing'
import './changes.css'

/** A diff in the transcript opens on this many lines; the rest is one press away, and is not read until then. */
const OPENING_ROWS = 24

export const sign = (line: DiffLine | undefined): string => line?.kind === 'add' ? '+' : line?.kind === 'remove' ? '−' : ''

/** What a screen reader hears before a changed line, which sighted readers get from its sign. */
export const spoken = (line: DiffLine | undefined, words: I18n): ReactNode => line?.kind === 'add' ? <span className="tt-visually-hidden">{words._(msg({ message: 'Added: ', comment: 'Read before an added line of a diff.' }))}</span>
  : line?.kind === 'remove' ? <span className="tt-visually-hidden">{words._(msg({ message: 'Removed: ', comment: 'Read before a removed line of a diff.' }))}</span> : null

/**
 * How far a line of code is indented, for the stylesheet to hang its wrapped remainder inside that indent, so a wrapped
 * line reads as one line of its block and not as the next one. Nothing for a line that starts at the margin.
 */
export function hangingIndent(text: string): CSSProperties | undefined {
  let columns = 0
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (character === ' ') columns++
    else if (character === '\t') columns += 4
    else break
  }
  return columns === 0 ? undefined : { '--changes-indent': `${columns}ch` } as CSSProperties
}

/** A run of code this short never breaks inside: a wrap goes at the space before it. A longer run can be wider than a wrapped line. */
const KEPT_RUN = 16
/** Where a browser would break inside a run of code a reader reads as one word, such as `'history-off'` or `a/b`. */
const BREAKS_INSIDE = /[-/|}?!%](?=[\p{L}\p{N}_$])/u
/** After these, a run too long to keep whole breaks where a reader expects: after a dot before a name, a comma, a slash or an opening bracket. */
const BREAK_AFTER = /(?:[,;([{</]|\.(?=[\p{L}_$]))(?=\S)/gu

interface BreakPlan { readonly kept: readonly TextRange[]; readonly after: readonly number[] }

/**
 * Where a wrapped line of code may break. A short run of letters and marks stays whole, so `'history-off'` never
 * splits at its hyphen; a long one gets a chance after its dots, commas and brackets before the browser breaks it
 * anywhere at all. Spaces stay the first place a line breaks. Nothing is added to the text. Null when the browser's
 * own breaks already serve.
 */
export function codeBreaks(text: string): BreakPlan | null {
  let kept: TextRange[] | null = null, after: number[] | null = null
  for (const run of text.matchAll(/\S+/gu)) {
    const word = run[0], start = run.index
    if (word.length <= KEPT_RUN) {
      if (BREAKS_INSIDE.test(word)) (kept ??= []).push({ start, end: start + word.length })
      continue
    }
    for (const at of word.matchAll(BREAK_AFTER)) (after ??= []).push(start + at.index + at[0].length)
  }
  return kept || after ? { kept: kept ?? [], after: after ?? [] } : null
}

/** A stretch of a line of code that starts `from` characters into the line, with the plan's breaks drawn in. */
function broken(text: string, from: number, plan: BreakPlan, key: number): ReactNode {
  const to = from + text.length
  const cuts = [
    ...plan.kept.filter(range => range.end > from && range.start < to).map(range => ({ at: Math.max(range.start, from), end: Math.min(range.end, to) })),
    ...plan.after.filter(point => point > from && point < to).map(point => ({ at: point, end: -1 })),
  ].sort((a, b) => a.at - b.at)
  if (cuts.length === 0) return text
  const out: ReactNode[] = []
  let at = from
  for (const cut of cuts) {
    if (cut.at < at) continue
    if (cut.at > at) out.push(text.slice(at - from, cut.at - from))
    if (cut.end < 0) { out.push(<wbr key={`${key}-${cut.at}`} />); at = cut.at }
    else { out.push(<span key={`${key}-${cut.at}`} className="changes-kept">{text.slice(cut.at - from, cut.end - from)}</span>); at = cut.end }
  }
  if (at < to) out.push(text.slice(at - from))
  return out
}

/**
 * A line's words with their colours, and the words that changed marked as one phrase each. `code` lets a wrapped line
 * break only where a reader expects (codeBreaks).
 */
export function PaintedText({ text, paint, code = false }: { readonly text: string; readonly paint: LinePaint | undefined; readonly code?: boolean }): ReactNode {
  if (!text) return ' '
  const plan = code ? codeBreaks(text) : null
  if (!paint?.tokens && !paint?.marks) return plan ? broken(text, 0, plan, 0) : text
  const parts = paintedParts(text, paint)
  const out: ReactNode[] = []
  let offset = 0
  const piece = (part: PaintedPart, index: number): ReactNode => {
    const words = plan ? broken(part.text, offset, plan, index) : part.text
    offset += part.text.length
    return part.className ? <span key={index} className={part.className}>{words}</span> : <Fragment key={index}>{words}</Fragment>
  }
  for (let index = 0; index < parts.length;) {
    if (!parts[index]!.marked) {
      out.push(piece(parts[index]!, index))
      index++
      continue
    }
    const first = index
    const inside: ReactNode[] = []
    for (; index < parts.length && parts[index]!.marked; index++) inside.push(piece(parts[index]!, index))
    out.push(<mark key={first} className="changes-word">{inside}</mark>)
  }
  return out
}

/** The space at a stretch's edges apart from its words. A stretch that is only space keeps it inside, since that is what changed. */
function edges(text: string): readonly [string, string, string] {
  const start = text.length - text.trimStart().length, end = text.trimEnd().length
  return end <= start ? ['', text, ''] : [text.slice(0, start), text.slice(start, end), text.slice(end)]
}

const REMOVED_LINE: DiffLine = { kind: 'remove', text: '', oldLine: null, newLine: null }
const ADDED_LINE: DiffLine = { kind: 'add', text: '', oldLine: null, newLine: null }

/**
 * A prose line and what it became, read once (wordSegments): the words both keep, then at each change the words it
 * took out, struck through in the removed role's ink, and the words it put in, in the added role's. Every character of
 * both lines is drawn, in order, and a screen reader hears which words went and which came.
 */
export function EditedText({ before, after, segments, paintBefore, paintAfter }: {
  readonly before: string; readonly after: string; readonly segments: readonly WordSegment[]
  readonly paintBefore: LinePaint | undefined; readonly paintAfter: LinePaint | undefined
}): ReactNode {
  const { i18n } = useLingui()
  const side = (line: string, range: TextRange, paint: LinePaint | undefined, removed: boolean, abut: boolean): ReactNode => {
    if (range.end <= range.start) return null
    const [lead, core, trail] = edges(line.slice(range.start, range.end))
    const at = range.start + lead.length
    const Tag = removed ? 'del' : 'ins'
    return <>{lead}<Tag className="changes-word changes-word--edit" data-abut={abut || undefined}>
      {spoken(removed ? REMOVED_LINE : ADDED_LINE, i18n)}<PaintedText text={core} paint={paintWithin(paint, { start: at, end: at + core.length })} />
    </Tag>{trail}</>
  }
  return segments.map((segment, index) => {
    if (segment.kind === 'kept') return <PaintedText key={index} text={after.slice(segment.after.start, segment.after.end)} paint={paintWithin(paintAfter, segment.after)} />
    const went = before.slice(segment.before.start, segment.before.end), came = after.slice(segment.after.start, segment.after.end)
    // Words that went and words that came, with no space of their own between them, are held a little apart.
    const abut = went.trim() !== '' && came.trim() !== '' && !/\s$/u.test(went) && !/^\s/u.test(came)
    return <Fragment key={index}>{side(before, segment.before, paintBefore, true, false)}{side(after, segment.after, paintAfter, false, abut)}</Fragment>
  })
}

/** A hunk's head as a quiet divider: the line it starts on and the section around it, on one line whatever its width. */
export function HunkHeading({ text }: { readonly text: string }): ReactNode {
  const { t } = useLingui()
  const heading = hunkHeading(text)
  if (!heading) return text
  const line = heading.line
  return <>
    <span className="changes-hunk__line">{t({ message: `Line ${line}`, comment: 'Where a part of a diff starts in the file; {line} is a line number.' })}</span>
    {heading.section ? <span className="changes-hunk__section">{heading.cut ? `${heading.section}…` : heading.section}</span> : null}
  </>
}

/** Keeps the highlighter once loaded, and loads it when something asks. */
export function useHighlighter(wanted: boolean): Highlighter | null {
  const [highlighter, setHighlighter] = useState(highlighterNow)
  useEffect(() => {
    if (!wanted || highlighter !== null) return
    let live = true
    void loadHighlighter().then(loaded => { if (live) setHighlighter(loaded) }, () => undefined)
    return () => { live = false }
  }, [wanted, highlighter])
  return highlighter
}

/** What a cut body says while the rest of it is on its host (ADR-0025): the line where the rest goes, and the bar's status. */
export interface DiffBlockCut { readonly line: string; readonly status: ReactNode }

/** The sign of a line read once with what it became: it lost words and gained some. */
export const EDITED_SIGN = '±'

function Line({ line, decoration, numbers, code }: { readonly line: DiffLine; readonly decoration: DiffDecoration; readonly numbers: boolean; readonly code: boolean }): ReactNode {
  const { i18n } = useLingui()
  const paint = decoration.paint.get(line)
  return <div className="changes-line" data-kind={line.kind} title={line.kind === 'hunk' ? line.text : undefined}>
    {numbers ? <span className="changes-line__number" aria-hidden="true">{line.newLine ?? line.oldLine ?? ''}</span> : null}
    <span className="changes-line__sign" aria-hidden="true">{sign(line)}</span>
    <span className="changes-line__text" data-shape={paint?.shape} style={hangingIndent(line.text)}>{line.kind === 'hunk' ? <HunkHeading text={line.text} /> : <>{spoken(line, i18n)}<PaintedText text={line.text} paint={paint} code={code} /></>}</span>
  </div>
}

/** A document's line and what it became, as one line (EditedText). */
function EditedLine({ before, after, segments, decoration, numbers }: {
  readonly before: DiffLine; readonly after: DiffLine; readonly segments: readonly WordSegment[]; readonly decoration: DiffDecoration; readonly numbers: boolean
}): ReactNode {
  const paintAfter = decoration.paint.get(after)
  return <div className="changes-line" data-kind="edited">
    {numbers ? <span className="changes-line__number" aria-hidden="true">{after.newLine ?? before.oldLine ?? ''}</span> : null}
    <span className="changes-line__sign" aria-hidden="true">{EDITED_SIGN}</span>
    <span className="changes-line__text" data-shape={paintAfter?.shape}><EditedText before={before.text} after={after.text} segments={segments} paintBefore={decoration.paint.get(before)} paintAfter={paintAfter} /></span>
  </div>
}

/**
 * A change as the transcript draws it, with the lines, marks and colours Changes draws: a document's words wrap and read
 * as words, the words that changed stand out, and what stayed the same is quiet. Nothing scrolls sideways. `path` names
 * the file when the caller knows it; without it the diff's own text says whether it is a document, and which language.
 * Read only: comments on lines belong to Changes.
 */
export const DiffBlock = memo(function DiffBlock({ diff, path, cut }: { readonly diff: string; readonly path?: string | undefined; readonly cut?: DiffBlockCut | undefined }): ReactNode {
  const { t } = useLingui()
  const [outcome, showOutcome] = useTransientFlag<'copied' | 'failed'>()
  const [all, setAll] = useState(false)
  const lines = useMemo(() => parseDiffText(diff), [diff])
  // The part of a cut body is short already, and its line says the rest goes after it, so all of it shows.
  const whole = all || cut !== undefined
  const shown = useMemo(() => whole ? lines : lines.slice(0, OPENING_ROWS), [lines, whole])
  const reading = useMemo(() => (path ? isDocumentPath(path) : looksLikeDocument(lines)) ? 'document' as const : 'code' as const, [lines, path])
  const highlighter = useHighlighter(reading === 'code')
  const language = useMemo(() => reading !== 'code' || !highlighter ? null : path ? languageOfPath(path, highlighter) : guessLanguage(lines, highlighter), [highlighter, lines, path, reading])
  const decoration = useMemo(() => decorateDiff(shown, { reading, language, highlighter }), [highlighter, language, reading, shown])
  // Each edited line of a document reads once with what it became; the rest are one line each.
  const rows = useMemo(() => {
    const order = reading === 'document' ? readingOrder(shown, decoration.pairs) : shown.map((_, index) => index)
    const out: [number, number | undefined][] = []
    for (let at = 0; at < order.length; at++) {
      const index = order[at]!, partner = decoration.pairs.get(index)
      if (partner !== undefined && order[at + 1] === partner && decoration.inline.has(shown[index]!)) { out.push([index, partner]); at++ }
      else out.push([index, undefined])
    }
    return out
  }, [decoration, reading, shown])
  const { additions, deletions } = useMemo(() => {
    let added = 0, removed = 0
    for (const line of lines) { if (line.kind === 'add') added++; else if (line.kind === 'remove') removed++ }
    return { additions: shownLineCount(added), deletions: shownLineCount(removed) }
  }, [lines])
  const numbers = lines.some(line => line.oldLine !== null || line.newLine !== null)
  const copied = outcome === 'copied'
  const feedback = outcome === null ? null : copied ? t`Copied` : t`Copy failed`
  const copy = (): void => { if (!cut) void writeClipboard(diff).then(() => showOutcome('copied'), () => showOutcome('failed')) }
  const shownCount = shown.length.toLocaleString(), lineCount = lines.length.toLocaleString()
  return <div className="changes-block" role="group" aria-label={t({ message: 'Diff', comment: 'Names the box that shows one change to a file in the transcript.' })}>
    <div className="changes-block__bar">
      <span className="changes-counts">
        <span aria-hidden="true"><span className="changes-counts__add">+{additions}</span> <span className="changes-counts__remove">−{deletions}</span></span>
        <span className="tt-visually-hidden">{t`${additions} added, ${deletions} removed`}</span>
      </span>
      <span className="changes-block__status" role="status" aria-live="polite">{feedback || cut?.status}</span>
      <button type="button" className="changes-block__copy tt-focusable" data-copied={copied || undefined} aria-disabled={cut ? true : undefined}
        aria-label={cut ? t`Copy diff, once the rest arrives` : t`Copy diff`} title={cut ? t`Copy works once the rest arrives` : t`Copy diff`} onClick={copy}>
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
    </div>
    <div className="changes-diff__rows" data-reading={reading} data-numbers={numbers ? 'one' : 'none'} data-whole={wholeSide(lines)}>
      {rows.map(([index, partner]) => partner === undefined ? <Line key={index} line={shown[index]!} decoration={decoration} numbers={numbers} code={reading === 'code'} />
        : <EditedLine key={index} before={shown[index]!} after={shown[partner]!} segments={decoration.inline.get(shown[index]!)!} decoration={decoration} numbers={numbers} />)}
      {cut ? <div className="changes-block__cut activity-body__cut">{cut.line}</div> : null}
    </div>
    {shown.length < lines.length ? <div className="changes-diff__more"><span>{t`Showing ${shownCount} of ${lineCount} lines.`}</span>
      <button type="button" className="files-link tt-focusable" onClick={() => setAll(true)}>{t`Show all`}</button></div> : null}
  </div>
})
