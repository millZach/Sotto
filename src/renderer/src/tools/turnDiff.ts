/**
 * A turn's changes as unified patches, built from the before and after text Sotto's checkpoint kept for each
 * file (ADR-0027: turn diffs come from Sotto's own blobs, not Git refs). The line diff is Myers' over the part of
 * the file between the common start and end; past a thousand edits it gives up on alignment and shows that part
 * as removed then added, which is still the true change.
 */

const CONTEXT = 3
const MAX_EDITS = 1000

interface Line { readonly text: string; readonly newline: boolean }
type Edit = { readonly kind: 'same'; readonly old: number; readonly new: number } | { readonly kind: 'remove'; readonly old: number } | { readonly kind: 'add'; readonly new: number }

function lines(text: string): Line[] {
  if (text === '') return []
  const parts = text.split('\n')
  const last = parts.pop()!
  const result: Line[] = parts.map(part => ({ text: part, newline: true }))
  if (last !== '') result.push({ text: last, newline: false })
  return result
}

/** The shortest edit script from `a` to `b` by key, or null when it would need more than `limit` edits. */
function myers(a: readonly string[], b: readonly string[], limit: number): Edit[] | null {
  const n = a.length, m = b.length, max = Math.min(n + m, limit), offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || k !== d && v[offset + k - 1]! < v[offset + k + 1]! ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[offset + k] = x
      if (x >= n && y >= m) {
        const edits: Edit[] = []
        let cx = n, cy = m
        for (let back = d; back > 0; back--) {
          const previous = trace[back]!
          const ck = cx - cy
          const down = ck === -back || ck !== back && previous[offset + ck - 1]! < previous[offset + ck + 1]!
          const pk = down ? ck + 1 : ck - 1
          const px = previous[offset + pk]!, py = px - pk
          while (cx > px && cy > py) { cx--; cy--; edits.push({ kind: 'same', old: cx, new: cy }) }
          if (down) { cy--; edits.push({ kind: 'add', new: cy }) } else { cx--; edits.push({ kind: 'remove', old: cx }) }
        }
        while (cx > 0 && cy > 0) { cx--; cy--; edits.push({ kind: 'same', old: cx, new: cy }) }
        return edits.reverse()
      }
    }
  }
  return null
}

function script(before: readonly Line[], after: readonly Line[], key: (line: Line) => string): Edit[] {
  const a = before.map(key), b = after.map(key)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length, endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const middle = myers(a.slice(start, endA), b.slice(start, endB), MAX_EDITS)
  const edits: Edit[] = []
  for (let index = 0; index < start; index++) edits.push({ kind: 'same', old: index, new: index })
  if (middle) for (const edit of middle) edits.push(edit.kind === 'same' ? { kind: 'same', old: edit.old + start, new: edit.new + start } : edit.kind === 'remove' ? { kind: 'remove', old: edit.old + start } : { kind: 'add', new: edit.new + start })
  else {
    for (let index = start; index < endA; index++) edits.push({ kind: 'remove', old: index })
    for (let index = start; index < endB; index++) edits.push({ kind: 'add', new: index })
  }
  for (let offset = 0; offset < a.length - endA; offset++) edits.push({ kind: 'same', old: endA + offset, new: endB + offset })
  return edits
}

export interface TurnPatch { readonly patch: string; readonly additions: number; readonly deletions: number }

/**
 * One file's change in a turn as a unified patch with three lines of context, the way `git diff` prints it, so
 * Changes reads a turn the way it reads Git. `null` before is a file the turn added; `null` after, one it deleted.
 * With `ignoreWhitespace`, lines that differ only in whitespace count as the same, as `git diff -w` does; a file
 * whose only change was whitespace then has no hunks.
 */
export function turnPatch(path: string, before: string | null, after: string | null, ignoreWhitespace = false): TurnPatch {
  const a = lines(before ?? ''), b = lines(after ?? '')
  // A last line without a newline differs from the same text with one, as Git counts it.
  const key = (line: Line): string => (ignoreWhitespace ? line.text.replace(/\s+/gu, '') : line.text) + (line.newline ? '' : '\0')
  const edits = script(a, b, key)
  const header = [`diff --git a/${path} b/${path}`, ...before === null ? ['new file mode 100644'] : after === null ? ['deleted file mode 100644'] : [],
    `--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ ${after === null ? '/dev/null' : `b/${path}`}`]
  const changed = edits.map((edit, index) => edit.kind === 'same' ? -1 : index).filter(index => index >= 0)
  if (changed.length === 0) return { patch: '', additions: 0, deletions: 0 }
  const out: string[] = [...header]
  let additions = 0, deletions = 0
  let cursor = 0
  while (cursor < changed.length) {
    const first = changed[cursor]!
    let last = first
    while (cursor + 1 < changed.length && changed[cursor + 1]! - last <= CONTEXT * 2 + 1) last = changed[++cursor]!
    cursor++
    const from = Math.max(0, first - CONTEXT), to = Math.min(edits.length - 1, last + CONTEXT)
    const hunk = edits.slice(from, to + 1)
    const oldStart = firstIndex(edits, from, 'old'), newStart = firstIndex(edits, from, 'new')
    const oldCount = hunk.filter(edit => edit.kind !== 'add').length, newCount = hunk.filter(edit => edit.kind !== 'remove').length
    out.push(`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`)
    for (const edit of hunk) {
      const line = edit.kind === 'remove' ? a[edit.old]! : b[edit.new]!
      out.push(`${edit.kind === 'same' ? ' ' : edit.kind === 'add' ? '+' : '-'}${line.text}`)
      if (edit.kind === 'add') additions++
      if (edit.kind === 'remove') deletions++
      if (!line.newline) out.push('\\ No newline at end of file')
    }
  }
  return { patch: `${out.join('\n')}\n`, additions, deletions }
}

/** The 1-based line a hunk starts at on one side: the first line of that side at or after `from`. */
function firstIndex(edits: readonly Edit[], from: number, side: 'old' | 'new'): number {
  for (let index = from; index < edits.length; index++) {
    const edit = edits[index]!
    if (side === 'old' && edit.kind !== 'add') return edit.old + 1
    if (side === 'new' && edit.kind !== 'remove') return edit.new + 1
  }
  // A side with no lines in this hunk starts after the last line it had before it.
  let count = 0
  for (let index = 0; index < from; index++) { const edit = edits[index]!; if (side === 'old' ? edit.kind !== 'add' : edit.kind !== 'remove') count++ }
  return count
}

function range(start: number, count: number): string {
  if (count === 0) return `${start},0`
  return count === 1 ? `${start}` : `${start},${count}`
}
