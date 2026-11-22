// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

  it('opens the file agy names: its Windows form without the leading slash, and a relative path in the thread’s folder', () => {
    expect(antigravityFilePath('/C:/Users/someone/notes.txt', 'D:\\work', 'win32')).toBe('C:/Users/someone/notes.txt')
    expect(antigravityFilePath('/home/someone/notes.txt', '/work', 'linux')).toBe('/home/someone/notes.txt')
    expect(antigravityFilePath('src/a.ts', join(tmpdir(), 'work'))).toBe(resolve(tmpdir(), 'work', 'src/a.ts'))
  })

  it('reads each file once the edit is done, and leaves one it cannot read', async () => {
    folder = await mkdtemp(join(tmpdir(), 'sotto-agy-edit-'))
    await writeFile(join(folder, 'notes.txt'), file('alpha', 'BRAVO'))
    expect(await placeAntigravityEdits([{ path: 'notes.txt', oldText: 'bravo\n', newText: 'BRAVO\n' }, { path: 'missing.txt', oldText: 'a', newText: 'b' }], folder))
      .toEqual(['@@ -2 +2 @@\n-bravo\n+BRAVO', undefined])
  })
})
