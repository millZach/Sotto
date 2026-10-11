// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { turnPatch } from '../../../../src/renderer/src/tools/turnDiff'
describe('a turn’s file as a unified patch', () => {

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
