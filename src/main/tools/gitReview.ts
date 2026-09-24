import type { GitChangeStatus } from '../../shared/gitChanges'

/**
 * The pure half of Changes' comparisons: reading what `git diff` prints with `-z --numstat`, `-z --name-status`
 * and `--patch`, and matching each file to its own part of the patch. Nothing here runs Git.
 */

export interface NumstatEntry { readonly path: string; readonly originalPath?: string; readonly additions: number | null; readonly deletions: number | null }
export interface NameStatusEntry { readonly path: string; readonly originalPath?: string; readonly status: GitChangeStatus }

/** `git diff -z --numstat`: `adds\tdels\tpath\0`, or `adds\tdels\t\0old\0new\0` for a rename. `-` counts are a binary file's. */
export function parseNumstatZ(output: string): NumstatEntry[] {
  const tokens = output.split('\0')
  const entries: NumstatEntry[] = []
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index++]!
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/u.exec(token.replace(/^\n+/u, ''))
    if (!match) continue
    const count = (value: string): number | null => value === '-' ? null : Number(value)
    let path = match[3]!
    let originalPath: string | undefined
    if (path === '') { originalPath = tokens[index++]; path = tokens[index++] ?? '' }
    if (!path) continue
    entries.push({ path, ...(originalPath ? { originalPath } : {}), additions: count(match[1]!), deletions: count(match[2]!) })
  }
  return entries
}

const NAME_STATUS: Record<string, GitChangeStatus> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'added', T: 'type-changed', U: 'conflicted' }

/** `git diff -z --name-status`: `M\0path\0`, or `R100\0old\0new\0` for a rename or a copy. */
export function parseNameStatusZ(output: string): NameStatusEntry[] {
  const tokens = output.split('\0')
  const entries: NameStatusEntry[] = []
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index++]!.trim()
    if (!code) continue
    const letter = code[0]!
    if (letter === 'R' || letter === 'C') {
      const originalPath = tokens[index++] ?? '', path = tokens[index++] ?? ''
      if (path) entries.push({ path, ...(letter === 'R' && originalPath ? { originalPath } : {}), status: NAME_STATUS[letter]! })
    } else {
      const path = tokens[index++] ?? ''
      if (path) entries.push({ path, status: NAME_STATUS[letter] ?? 'modified' })
    }
  }
  return entries
}

/** A patch cut into one section per file, each starting at its `diff --git` line, in the order Git printed them. */
export function splitPatch(patch: string): string[] {
  const starts: number[] = []
  const pattern = /^diff --git /gmu
  for (let match = pattern.exec(patch); match; match = pattern.exec(patch)) starts.push(match.index)
  return starts.map((start, index) => patch.slice(start, starts[index + 1] ?? patch.length))
}

/** A path as Git prints it in a patch header: bare, or C-quoted when it holds a quote, a backslash or a control character. */
export function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value
  const body = value.slice(1, -1)
  const bytes: number[] = []
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
  for (let index = 0; index < body.length; index++) {
    const character = body[index]!
    if (character !== '\\') { bytes.push(...Buffer.from(character, 'utf8')); continue }
    const next = body[index + 1] ?? ''
    if (/[0-7]/u.test(next)) {
      const octal = /^[0-7]{1,3}/u.exec(body.slice(index + 1))![0]
      bytes.push(Number.parseInt(octal, 8))
      index += octal.length
    } else if (next in simple) { bytes.push(simple[next]!); index++ }
    else bytes.push(92)
  }
  return Buffer.from(bytes).toString('utf8')
}

/** The file a patch section is about: its new path, or its old one when it was deleted. */
export function sectionPath(section: string): string | null {
  const head = section.slice(0, section.search(/^@@ /mu) >= 0 ? section.search(/^@@ /mu) : Math.min(section.length, 4096))
  const lines = head.split('\n')
  const prefixed = (marker: string, prefix: string): string | null => {
    const line = lines.find(item => item.startsWith(marker))
    if (!line) return null
    const value = unquoteGitPath(line.slice(marker.length).replace(/\t$/u, ''))
    return value === '/dev/null' ? null : value.startsWith(prefix) ? value.slice(prefix.length) : null
  }
  const plus = prefixed('+++ ', 'b/')
  if (plus !== null) return plus
  const renamed = lines.find(line => line.startsWith('rename to '))
  if (renamed) return unquoteGitPath(renamed.slice('rename to '.length))
  const minus = prefixed('--- ', 'a/')
  if (minus !== null) return minus
  const header = lines[0]?.slice('diff --git '.length) ?? ''
  if (header.startsWith('"')) {
    const second = /^"(?:[^"\\]|\\.)*" ("(?:[^"\\]|\\.)*"|.*)$/u.exec(header)?.[1]
    const value = second ? unquoteGitPath(second) : ''
    return value.startsWith('b/') ? value.slice(2) : null
  }
  // `a/P b/P` with the same P on both sides: its length follows from the whole.
  const length = (header.length - 5) / 2
  if (Number.isInteger(length) && length > 0 && header.startsWith('a/') && header.slice(2, 2 + length) === header.slice(5 + length)) return header.slice(2, 2 + length)
  return null
}

/** Whether a section is Git's word that the file has no text diff. */
export function sectionIsBinary(section: string): boolean {
  return /^Binary files .* differ$/mu.test(section) || /^GIT binary patch$/mu.test(section)
}
