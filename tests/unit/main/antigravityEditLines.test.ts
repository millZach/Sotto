// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { antigravityEdits, antigravityFilePath, placeAntigravityEdit, placeAntigravityEdits } from '../../../src/main/agents/antigravityEditLines'

const file = (...lines: string[]) => lines.map(line => `${line}\n`).join('')

describe('Antigravity edits on their lines', () => {
  let folder = ''
  afterEach(async () => { if (folder) await rm(folder, { recursive: true, force: true }); folder = '' })

  it('places a whole-file edit, as agy 1.5.14 sends it, on the changed lines only, numbered as the file is now', () => {
    const before = file('alpha', 'bravo', 'charlie', 'delta', 'echo'), now = file('alpha', 'bravo', 'CHARLIE', 'extra', 'delta', 'echo')
    expect(placeAntigravityEdit({ oldText: before, newText: now }, now)).toBe('@@ -3 +3,2 @@\n-charlie\n+CHARLIE\n+extra')
  })

  it('places a snippet by finding it once in the file, and two changes apart as two hunks', () => {
    const now = file('one', 'two', 'THREE', 'four', 'five', 'six', 'seven', 'EIGHT', 'nine')
    expect(placeAntigravityEdit({ oldText: 'three\n', newText: 'THREE\n' }, now)).toBe('@@ -3 +3 @@\n-three\n+THREE')
    const whole = file('one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine')
    expect(placeAntigravityEdit({ oldText: whole, newText: now }, now)).toBe('@@ -3 +3 @@\n-three\n+THREE\n@@ -8 +8 @@\n-eight\n+EIGHT')
  })

  it('places a change inside the text agy named, even where the lines after it repeat it', () => {
    expect(placeAntigravityEdit({ oldText: 'a\n', newText: 'a\nx\n' }, 'a\nx\nx\n')).toBe('@@ -1,0 +2 @@\n+x')
    expect(placeAntigravityEdit({ oldText: 'b', newText: 'B' }, 'one\ntwo\naBc\nfour\n')).toBe('@@ -3 +3 @@\n-abc\n+aBc')
  })

  it('places a new file or an insertion as added lines', () => {
    expect(placeAntigravityEdit({ oldText: '', newText: file('a', 'b') }, file('a', 'b'))).toBe('@@ -0,0 +1,2 @@\n+a\n+b')
  })

  it('leaves an edit it cannot place: no new text, text not in the file, or in it twice', () => {
    expect(placeAntigravityEdit({ oldText: 'x\n', newText: '' }, file('a'))).toBeUndefined()
    expect(placeAntigravityEdit({ oldText: 'x\n', newText: 'y\n' }, file('a', 'b'))).toBeUndefined()
    expect(placeAntigravityEdit({ oldText: 'x\n', newText: 'y\n' }, file('y', 'a', 'y'))).toBeUndefined()
  })

  it('reads the edits of a finished tool call only, every diff with a path in its row’s order', () => {
    const content = [{ type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' }, { type: 'content', content: { type: 'text', text: 'ok' } }, { type: 'diff', path: 'b.ts', newText: 'z' }]
    expect(antigravityEdits({ sessionUpdate: 'tool_call_update', status: 'completed', content }))
      .toEqual([{ path: 'a.ts', oldText: 'x', newText: 'y' }, { path: 'b.ts', oldText: '', newText: 'z' }])
    expect(antigravityEdits({ sessionUpdate: 'tool_call_update', status: 'in_progress', content })).toEqual([])
    expect(antigravityEdits({ sessionUpdate: 'tool_call', status: 'completed', content })).toEqual([])
  })

  it('opens the file agy names in the thread’s folder only: its Windows form without the leading slash, or a relative path', () => {
    const work = join(tmpdir(), 'work')
    expect(antigravityFilePath('src/a.ts', work)).toBe(resolve(work, 'src/a.ts'))
    expect(antigravityFilePath(resolve(work, 'b.ts'), work)).toBe(resolve(work, 'b.ts'))
    if (process.platform === 'win32') expect(antigravityFilePath(`/${resolve(work, 'c.ts').replace(/\\/gu, '/')}`, work)).toBe(resolve(work, 'c.ts'))
    // Outside the thread's folder, a network share among them, it is not read.
    expect(antigravityFilePath(resolve(tmpdir(), 'elsewhere.ts'), work)).toBeUndefined()
    expect(antigravityFilePath('../up.ts', work)).toBeUndefined()
    expect(antigravityFilePath('\\\\server\\share\\a.ts', 'C:\\work', 'win32')).toBeUndefined()
  })

  it('reads each file once the edit is done, and leaves one it cannot read', async () => {
    folder = await mkdtemp(join(tmpdir(), 'sotto-agy-edit-'))
    await writeFile(join(folder, 'notes.txt'), file('alpha', 'BRAVO'))
    expect(await placeAntigravityEdits([{ path: 'notes.txt', oldText: 'bravo\n', newText: 'BRAVO\n' }, { path: 'missing.txt', oldText: 'a', newText: 'b' }], folder, join(tmpdir(), 'sotto-kept')))
      .toEqual(['@@ -2 +2 @@\n-bravo\n+BRAVO', undefined])
  })

  it('never reads a file in Sotto’s own Antigravity folder, where agy keeps its sign-in', async () => {
    folder = await mkdtemp(join(tmpdir(), 'sotto-agy-edit-'))
    const kept = join(folder, 'antigravity')
    await mkdir(kept, { recursive: true }); await writeFile(join(kept, 'token.json'), 'NEW\n')
    expect(await placeAntigravityEdits([{ path: join(kept, 'token.json'), oldText: 'OLD\n', newText: 'NEW\n' }], folder, kept)).toEqual([undefined])
  })

  it('never follows a link or junction in the thread’s folder to a file outside it', async () => {
    folder = await mkdtemp(join(tmpdir(), 'sotto-agy-edit-'))
    const outside = await mkdtemp(join(tmpdir(), 'sotto-agy-outside-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'NEW\n')
      await writeFile(join(folder, 'inside.txt'), 'NEW\n')
      // A junction needs no rights on Windows; elsewhere a directory link.
      await symlink(outside, join(folder, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
      expect(await placeAntigravityEdits([{ path: 'link/secret.txt', oldText: 'OLD\n', newText: 'NEW\n' }, { path: 'inside.txt', oldText: 'OLD\n', newText: 'NEW\n' }],
        folder, join(tmpdir(), 'sotto-kept'))).toEqual([undefined, '@@ -1 +1 @@\n-OLD\n+NEW'])
    } finally {
      await unlink(join(folder, 'link')).catch(() => undefined)
      await rm(outside, { recursive: true, force: true })
    }
  })
})
