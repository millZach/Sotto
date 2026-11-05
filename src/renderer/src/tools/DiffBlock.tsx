import React, { memo, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { I18n } from '@lingui/core'
import { Check, Copy } from 'lucide-react'
import { highlighterNow, loadHighlighter, type Highlighter } from '../agents/codeHighlighter'
import { useTransientFlag, writeClipboard } from '../agents/richActions'
import { shownLineCount } from '../state/interfaceNumbers'
import type { DiffLine } from './changesStore'
import { decorateDiff, guessLanguage, hunkHeading, isDocumentPath, languageOfPath, looksLikeDocument, paintedParts, parseDiffText, readingOrder, wholeSide, type DiffDecoration, type LinePaint } from './diffDrawing'
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

/** A line's words with their colours, and the words that changed marked as one phrase each. */
export function PaintedText({ text, paint }: { readonly text: string; readonly paint: LinePaint | undefined }): ReactNode {
  if (!text) return ' '
  if (!paint?.tokens && !paint?.marks) return text
  const parts = paintedParts(text, paint)
  const out: ReactNode[] = []
  for (let index = 0; index < parts.length;) {
    if (!parts[index]!.marked) {
      const part = parts[index]!
      out.push(part.className ? <span key={index} className={part.className}>{part.text}</span> : part.text)
      index++
      continue
    }
    const first = index
    const inside: ReactNode[] = []
    for (; index < parts.length && parts[index]!.marked; index++) {
      const part = parts[index]!
      inside.push(part.className ? <span key={index} className={part.className}>{part.text}</span> : part.text)
    }
    out.push(<mark key={first} className="changes-word">{inside}</mark>)
  }
  return out
}

/** A hunk's head as a quiet divider: the line it starts on and the section around it, on one line whatever its width. */
export function HunkHeading({ text }: { readonly text: string }): ReactNode {
  const { t } = useLingui()
  const heading = hunkHeading(text)
  if (!heading) return text
  const line = heading.line
  return <>
    <span className="changes-hunk__line">{t({ message: `Line ${line}`, comment: 'Where a part of a diff starts in the file; {line} is a line number.' })}</span>
    {heading.section ? <span className="changes-hunk__section">{heading.section}</span> : null}
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

function Line({ line, decoration, numbers }: { readonly line: DiffLine; readonly decoration: DiffDecoration; readonly numbers: boolean }): ReactNode {
  const { i18n } = useLingui()
  const paint = decoration.paint.get(line)
  return <div className="changes-line" data-kind={line.kind} title={line.kind === 'hunk' ? line.text : undefined}>
    {numbers ? <span className="changes-line__number" aria-hidden="true">{line.newLine ?? line.oldLine ?? ''}</span> : null}
    <span className="changes-line__sign" aria-hidden="true">{sign(line)}</span>
    <span className="changes-line__text" data-shape={paint?.shape} style={hangingIndent(line.text)}>{line.kind === 'hunk' ? <HunkHeading text={line.text} /> : <>{spoken(line, i18n)}<PaintedText text={line.text} paint={paint} /></>}</span>
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
  const order = useMemo(() => reading === 'document' ? readingOrder(shown, decoration.pairs) : null, [decoration, reading, shown])
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
      {(order ?? shown.map((_, index) => index)).map(index => <Line key={index} line={shown[index]!} decoration={decoration} numbers={numbers} />)}
      {cut ? <div className="changes-block__cut activity-body__cut">{cut.line}</div> : null}
    </div>
    {shown.length < lines.length ? <div className="changes-diff__more"><span>{t`Showing ${shownCount} of ${lineCount} lines.`}</span>
      <button type="button" className="files-link tt-focusable" onClick={() => setAll(true)}>{t`Show all`}</button></div> : null}
  </div>
})
