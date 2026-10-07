// @vitest-environment node
import { expect, it } from 'vitest'
import { installerDetail, installerOutput } from '../../../src/main/agents/installerDetail'

it.each([
  [String.raw`C:\Users\John Smith\AppData\codex.exe: The process cannot access the file…`, '…: The process cannot access the file…'],
  ['mise ERROR /Users/John Smith/Library/Application Support/mise/codex failed: exit status 1', 'mise ERROR …: exit status 1'],
  [String.raw`at Object.<anonymous> (C:\Users\John Smith\x.js:1:2)`, 'at Object.<anonymous> (…:1:2)'],
  ['~/.local/share/mise: Permission denied', '~/.local/share/mise: Permission denied'],
  [String.raw`Cannot write C:\Users\John Smith\codex.exe) Try again`, 'Cannot write …) Try again'],
  ['Cannot write /home/jsmith/codex: Permission denied', 'Cannot write …: Permission denied'],
  ['at /home/jsmith/x.js:1:2 (load failed)', 'at …:1:2 (load failed)'],
  ['Cannot write /Users/John Smith/codex (permission denied)', 'Cannot write … (permission denied)'],
  ['Cannot write /home/jsmith/codex) Try again', 'Cannot write …) Try again'],
  ['file:///Users/John Smith/codex: Permission denied', 'file://…: Permission denied'],
  ['file:///home/jsmith/x.js:1:2', 'file://…:1:2'],
  ['Cannot write "file:///Users/John Smith/codex"; permission denied', 'Cannot write "…"; permission denied'],
  ['Cannot write file:///C:/Users/John Smith/codex.exe: Permission denied', 'Cannot write file://…: Permission denied'],
  ['Cannot write /home/Smith: John/client: Permission denied', 'Cannot write …: Permission denied'],
  ['Cannot write /home/John (Work)/client: Permission denied', 'Cannot write ……: Permission denied'],
  [String.raw`Cannot write C:\Users\John)Smith\client: Permission denied`, 'Cannot write …: Permission denied'],
])('preserves diagnostics while redacting unquoted paths: %s', (line, expected) => {
  for (const format of [installerDetail, installerOutput]) {
    const shown = format(line)
    expect(shown).toBe(expected)
    expect(shown).not.toMatch(/John|Smith|jsmith|Work/u)
  }
})

it.each(['"', '<', '>', '|', '?', '*'])('ends a Windows path at the forbidden character %s', delimiter => {
  const line = String.raw`C:\Users\John Smith\codex.exe` + delimiter + ' Permission denied'
  expect(installerDetail(line)).toBe(`…${delimiter} Permission denied`)
  expect(installerOutput(line)).toBe(`…${delimiter} Permission denied`)
})

it.each([
  String.raw`C:\Users\John Smith\AppData\Local\npm-cache`,
  'C:/Users/John Smith/AppData/Local/npm-cache',
  String.raw`\\server\People\John Smith\tools`,
  '//server/People/John Smith/tools',
  '/home/John Smith/.cache/tools',
  '/Users/John Smith/.cache/tools',
  '/private/var/John Smith/tools',
  '/opt/tools/client',
  String.raw`C:\Users\Smith, John\AppData\Local\npm-cache`,
  String.raw`C:\Users\John O'Neil\AppData\Local\npm-cache`,
  String.raw`C:\Users\Chris' Work\AppData\Local\npm-cache`,
])('redacts the whole installer path %s in both presentations', path => {
  expect(installerDetail(`Cannot write ${path}`)).toBe('Cannot write …')
  expect(installerOutput(`First line\nCannot write "${path}"; permission denied`))
    .toBe('First line\nCannot write "…"; permission denied')
  expect(installerDetail(`Cannot write '${path}'`)).toBe("Cannot write '…'")
  expect(installerOutput(`First line\nCannot write '${path}'`))
    .toBe("First line\nCannot write '…'")
})

it('keeps the operation and separators around multiple quoted or unquoted paths', () => {
  expect(installerDetail(String.raw`rename C:\Users\John Smith\old -> C:/Users/Jane Doe/new`))
    .toBe('rename … -> …')
  expect(installerDetail(String.raw`rename 'C:\Users\John Smith\old' -> '/home/Jane Doe/new'`))
    .toBe("rename '…' -> '…'")
  expect(installerDetail(String.raw`rename 'C:\Users\John O'Neil\old' -> '/home/Smith, John/new'`))
    .toBe("rename '…' -> '…'")
})

it.each([
  [String.raw`rename 'C:\Users\John Smith\old' -> C:\Users\Chris' Work\new`, "rename '…' -> …"],
  [String.raw`Copy 'C:\Users\John Smith\old' to "C:\Users\Chris' Work\new"`, "Copy '…' to \"…\""],
  [String.raw`rename C:\Users\Chris' Work\old -> '/home/John Smith/new'`, "rename … -> '…'"],
])('keeps mixed path formats private: %s', (line, expected) => {
  expect(installerDetail(line)).toBe(expected)
  expect(installerOutput(line)).toBe(expected)
})

it('leaves URLs, package names and ordinary diagnostic text readable', () => {
  const line = 'Failed aqua:openai/codex@1.0 from https://example.com/releases: permission denied'
  expect(installerDetail(line)).toBe(line)
})

it.each([
  'Failed to download https://registry.npmjs.org/@openai/codex/-/codex-1.0.tgz: connection reset',
  'Cannot write /home/John Smith/codex: see https://registry.npmjs.org/@openai/codex/-/codex-1.0.tgz',
  'Cannot write "/home/John Smith/codex": see https://registry.npmjs.org/@openai/codex/-/codex-1.0.tgz',
  String.raw`Cannot write "C:\Users\John Smith\codex.exe": see https://registry.npmjs.org/@openai/codex/-/codex-1.0.tgz`,
])('preserves npm tarball URLs: %s', line => {
  const expected = line.replace('/home/John Smith/codex', '…').replace(String.raw`C:\Users\John Smith\codex.exe`, '…')
  expect(installerDetail(line)).toBe(expected)
  expect(installerOutput(line)).toBe(expected)
})

it.each([
  String.raw`C:\Users\John Smith\AppData\Local\npm-cache`,
  String.raw`\\server\People\John Smith\tools`,
  '/home/John Smith/.cache/tools',
])('redacts a path immediately after a diagnostic label: %s', path => {
  expect(installerDetail(`npm ERR! path:${path}`)).toBe('npm ERR! path:…')
  expect(installerOutput(`npm ERR! path:${path}`)).toBe('npm ERR! path:…')
})
