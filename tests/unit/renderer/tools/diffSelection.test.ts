import { describe, expect, it } from 'vitest'
import { composeReviewMessage } from '../../../../src/renderer/src/agents/reviewComments'
import { parseUnifiedDiff } from '../../../../src/renderer/src/tools/changesStore'
import { diffRows, quotedLines, rowLabel, rowShowing, rowsShowing, selectableRows } from '../../../../src/renderer/src/tools/diffSelection'

const PATCH = '@@ -10,4 +10,5 @@\n keep\n-old one\n-old two\n+new one\n+new two\n+new three\n tail\n\\ No newline at end of file\n'
const lines = parseUnifiedDiff(PATCH)

describe('rows a comment can cover', () => {
  it('stacked: one row per line, hunk heads and notes left out of the positions', () => {
    const rows = diffRows(lines, false)
    expect(rows.map(row => row.position)).toEqual([null, 0, 1, 2, 3, 4, 5, 6, null])
    const selectable = selectableRows(rows)
    expect(quotedLines(lines, selectable, 3, 1).map(line => `${line.kind}:${line.text}`)).toEqual(['remove:old one', 'remove:old two', 'add:new one'])
  })

  it('split: a row pairs a removal with an addition, and a range quotes each line once in the file’s order', () => {
    const rows = diffRows(lines, true)
    expect(rows.map(row => [row.old?.text ?? null, row.next?.text ?? null, row.position])).toEqual([
      [null, null, null], ['keep', 'keep', 0], ['old one', 'new one', 1], ['old two', 'new two', 2], [null, 'new three', 3], ['tail', 'tail', 4], [null, null, null],
    ])
    const selectable = selectableRows(rows)
    // The first pair alone quotes its two lines, not the removal between them in the file.
    expect(quotedLines(lines, selectable, 1, 1).map(line => line.text)).toEqual(['old one', 'new one'])
    expect(quotedLines(lines, selectable, 1, 3).map(line => line.text)).toEqual(['old one', 'old two', 'new one', 'new two', 'new three'])
    expect(rowLabel(selectable[1]!)).toBe('Removed line 11: old one; Added line 11: new one')
    expect(rowLabel(selectable[0]!)).toBe('Line 10: keep')
  })

  it('quotes a file with Windows line endings without its carriage returns, and still finds the lines again', () => {
    const crlf = parseUnifiedDiff('@@ -1,2 +1,2 @@\n keep\r\n-old\r\n+new\r\n')
    const rows = diffRows(crlf, false)
    const quoted = quotedLines(crlf, selectableRows(rows), 0, 2)
    expect(quoted.map(line => line.text)).toEqual(['keep', 'old', 'new'])
    expect(rowShowing(crlf, rows, quoted.at(-1))?.key).toBe('3')
    expect([...rowsShowing(crlf, rows, quoted)]).toEqual(['1', '2', '3'])
    expect(composeReviewMessage('', [{ path: 'win.txt', lines: quoted, text: 'Why?' }])).not.toContain('\r')
  })

  it('finds a comment’s lines in the diff drawn now, and nothing once they have changed', () => {
    const rows = diffRows(lines, false)
    const quoted = quotedLines(lines, selectableRows(rows), 3, 4)
    expect(rowShowing(lines, rows, quoted.at(-1))?.key).toBe('5')
    expect([...rowsShowing(lines, rows, quoted)]).toEqual(['4', '5'])
    const edited = parseUnifiedDiff(PATCH.replace('+new two', '+new 2'))
    expect(rowShowing(edited, diffRows(edited, false), quoted.at(-1))).toBeUndefined()
  })
})
