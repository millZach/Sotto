import { sameReviewLine, type ReviewLine } from '../agents/reviewComments'
import type { DiffLine } from './changesStore'

/**
 * One row of a file's diff as Changes draws it. Stacked, a row is one line; split, a row pairs a removed line
 * with the added line beside it, or shows one context line on both sides. Hunk heads, Git's metadata and
 * no-newline notes are rows nobody can comment on, so they have no position.
 */
export interface DiffRow {
  readonly key: string
  /** Stacked rows and rows that span both sides in split. */
  readonly line?: DiffLine
  /** Split rows: the left and right cells. A context line is on both. */
  readonly old?: DiffLine | undefined
  readonly next?: DiffLine | undefined
  /** This row's place among the rows a comment can cover, in reading order; null for the rest. */
  readonly position: number | null
  /** The indexes into the file's lines that this row shows and a comment on it quotes, in the file's own order. */
  readonly indices: readonly number[]
}

/**
 * A line as a comment quotes it. A file with Windows line endings keeps its carriage return at the end of each diff
 * line; it is dropped here, so the prompt carries the line's text alone and matching reads it the same way.
 */
export function reviewLine(line: DiffLine): ReviewLine | null {
  return line.kind === 'context' || line.kind === 'add' || line.kind === 'remove'
    ? { kind: line.kind, text: line.text.endsWith('\r') ? line.text.slice(0, -1) : line.text, oldLine: line.oldLine, newLine: line.newLine } : null
}

/** The rows for one layout. Split aligns each run of removals and additions pair by pair, as Git reads them. */
export function diffRows(lines: readonly DiffLine[], split: boolean): DiffRow[] {
  const rows: DiffRow[] = []
  let position = 0
  const push = (row: Omit<DiffRow, 'position'>): void => { rows.push({ ...row, position: row.indices.length > 0 ? position++ : null }) }
  if (!split) {
    lines.forEach((line, index) => push({ key: String(index), line, indices: reviewLine(line) ? [index] : [] }))
    return rows
  }
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!
    if (line.kind === 'remove' || line.kind === 'add') {
      const start = index
      const before: number[] = []
      const after: number[] = []
      while (index < lines.length && (lines[index]!.kind === 'remove' || lines[index]!.kind === 'add')) {
        if (lines[index]!.kind === 'remove') before.push(index)
        else after.push(index)
        index++
      }
      for (let offset = 0; offset < Math.max(before.length, after.length); offset++) {
        const old = before[offset], next = after[offset]
        push({ key: `${start}-${offset}`, old: old === undefined ? undefined : lines[old], next: next === undefined ? undefined : lines[next],
          indices: [old, next].filter((value): value is number => value !== undefined) })
      }
    } else {
      push(line.kind === 'context' ? { key: String(index), old: line, next: line, indices: [index] } : { key: String(index), line, indices: [] })
      index++
    }
  }
  return rows
}

/** The rows a comment can cover, by position. */
export function selectableRows(rows: readonly DiffRow[]): DiffRow[] {
  return rows.filter(row => row.position !== null)
}

/** The lines rows `from` to `to` show, each once and in the file's order, as a comment quotes them. */
export function quotedLines(lines: readonly DiffLine[], selectable: readonly DiffRow[], from: number, to: number): ReviewLine[] {
  const low = Math.max(0, Math.min(from, to)), high = Math.min(selectable.length - 1, Math.max(from, to))
  const indices = new Set<number>()
  for (let position = low; position <= high; position++) for (const index of selectable[position]!.indices) indices.add(index)
  return [...indices].sort((a, b) => a - b).flatMap(index => { const quoted = reviewLine(lines[index]!); return quoted ? [quoted] : [] })
}

/** The row that shows this line now, if the diff still has it: same kind, same numbers, same text. */
export function rowShowing(lines: readonly DiffLine[], rows: readonly DiffRow[], wanted: ReviewLine | undefined): DiffRow | undefined {
  if (wanted === undefined) return undefined
  return rows.find(row => row.indices.some(index => { const line = reviewLine(lines[index]!); return line !== null && sameReviewLine(line, wanted) }))
}

/** A line's identity for matching a comment to the diff drawn now. */
export function lineSignature(line: ReviewLine): string {
  return `${line.kind}\u0000${line.oldLine ?? ''}\u0000${line.newLine ?? ''}\u0000${line.text}`
}

/** The keys of the rows that show any of these lines. */
export function rowsShowing(lines: readonly DiffLine[], rows: readonly DiffRow[], wanted: readonly ReviewLine[]): ReadonlySet<string> {
  const signatures = new Set(wanted.map(lineSignature))
  const keys = new Set<string>()
  if (signatures.size === 0) return keys
  for (const row of rows) {
    if (row.indices.some(index => { const line = reviewLine(lines[index]!); return line !== null && signatures.has(lineSignature(line)) })) keys.add(row.key)
  }
  return keys
}

/** What a screen reader hears for a row: whether each line was added or removed, its number, then its text. */
export function rowLabel(row: DiffRow): string {
  const one = (line: DiffLine): string => line.kind === 'add' ? `Added line ${line.newLine}: ${line.text}`
    : line.kind === 'remove' ? `Removed line ${line.oldLine}: ${line.text}` : `Line ${line.newLine}: ${line.text}`
  if (row.line) return one(row.line)
  if (row.old && row.old === row.next) return one(row.old)
  return [row.old, row.next].flatMap(line => line ? [one(line)] : []).join('; ')
}
