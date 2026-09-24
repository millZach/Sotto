// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { turnPatch } from '../../../../src/renderer/src/tools/turnDiff'

/** Git's own hunks for the same two texts, headers dropped, for comparison. */
async function gitHunks(before: string, after: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-turn-diff-'))
  try {
    await writeFile(join(root, 'a'), before); await writeFile(join(root, 'b'), after)
    let output = ''
    try { execFileSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-color', '--diff-algorithm=myers', 'a', 'b'], { cwd: root, encoding: 'utf8', windowsHide: true }) }
    catch (error) { output = String((error as { stdout?: string }).stdout ?? '') }
    return output.slice(output.indexOf('@@')).replace(/^(@@ [^@]+ @@).*$/gmu, '$1')
  } finally { await rm(root, { recursive: true, force: true }) }
}
const hunks = (patch: string): string => patch.slice(patch.indexOf('@@'))

describe('a turn’s file as a unified patch', () => {
  it.each([
    ['one line changed among many', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n', 'a\nb\nc\nd\nE\nf\ng\nh\ni\nj\n'],
    ['two far-apart edits make two hunks', Array.from({ length: 30 }, (_v, i) => `line ${i}`).join('\n') + '\n', Array.from({ length: 30 }, (_v, i) => i === 2 ? 'two' : i === 25 ? 'twenty-five' : `line ${i}`).join('\n') + '\n'],
    ['lines inserted and removed', 'keep\nold one\nold two\ntail\n', 'keep\nnew one\nnew two\nnew three\ntail\n'],
    ['a missing final newline', 'a\nb', 'a\nc'],
    ['a newline added at the end', 'a\nb', 'a\nb\n'],
    ['insertion at the start', 'x\ny\n', 'new\nx\ny\n'],
  ])('matches git diff: %s', async (_name, before, after) => {
    expect(hunks(turnPatch('f.txt', before, after).patch)).toBe(await gitHunks(before, after))
  })

  it('writes added and deleted files with their counts and headers', () => {
    const added = turnPatch('src/new.ts', null, 'one\ntwo\n')
    expect(added).toEqual({ patch: 'diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n', additions: 2, deletions: 0 })
    const deleted = turnPatch('gone.md', 'bye\n', null)
    expect(deleted).toMatchObject({ additions: 0, deletions: 1 })
    expect(deleted.patch).toContain('deleted file mode 100644\n--- a/gone.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n')
    expect(turnPatch('same.txt', 'x\n', 'x\n')).toEqual({ patch: '', additions: 0, deletions: 0 })
  })

  it('treats whitespace-only differences as the same line when asked', () => {
    expect(turnPatch('f.txt', 'a\n  b\nc\n', 'a\nb   \nc\n', true)).toEqual({ patch: '', additions: 0, deletions: 0 })
    const mixed = turnPatch('f.txt', 'a\n  b\nc\n', 'a\nb\nC\n', true)
    expect(mixed).toMatchObject({ additions: 1, deletions: 1 })
    expect(mixed.patch).toContain('-c\n+C')
  })

  it('shows a wholesale rewrite past the edit limit as the whole block removed then added', () => {
    const before = Array.from({ length: 1500 }, (_v, i) => `old ${i}`).join('\n') + '\n'
    const after = Array.from({ length: 1500 }, (_v, i) => `new ${i}`).join('\n') + '\n'
    expect(turnPatch('big.txt', before, after)).toMatchObject({ additions: 1500, deletions: 1500 })
  })
})
