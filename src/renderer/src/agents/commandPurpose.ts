import { plural, t } from '@lingui/core/macro'

import { shownCount } from '../state/interfaceNumbers'

/**
 * What a command did, in Sotto's words, for a provider that sends no description with its commands (Codex, Grok, Devin), so
 * every row among the opened steps reads as what it did, as Claude's described rows do (ADR-0134, November 6 amendment). It
 * reads only the command's own words, the program and the files it names, and never guesses past them: `cat a.md` reads as
 * "Read a.md", and a program it does not know as "Run" and the program's name. The command itself shows once the row opens.
 */
export function commandPurpose(command: string, folder?: string): string {
  const segment = firstSegment(command)
  if (segment === null) return ''
  return purposeOf(segment.program, segment.args, segment.writes, folder)
}

interface Segment {
  /** The program as written, without its folder or `.exe`. */
  readonly program: string
  readonly args: readonly string[]
  /** The file a `>` or `>>` sends the output to, when it is a file. */
  readonly writes: string | undefined
}

/** Words that change how a command runs but are not what it does. */
const PREFIXES = new Set(['sudo', 'time', 'command', 'exec', 'env', 'nohup', 'nice'])
/** A step into a folder before the work, which says nothing of what the work is. */
const MOVES = new Set(['cd', 'pushd', 'popd', 'set-location', 'sl', 'chdir', 'export', 'set', 'source', '.'])

/** The command's first piece of real work: the first part of a pipeline or a list that is not a change of folder. */
function firstSegment(command: string): Segment | null {
  for (const words of segments(command)) {
    const rest = words.filter(word => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word))
    while (rest.length && PREFIXES.has(rest[0]!.toLowerCase())) rest.shift()
    if (!rest.length) continue
    const program = programName(rest[0]!)
    if (MOVES.has(program.toLowerCase())) continue
    let writes: string | undefined
    const args: string[] = []
    for (let index = 1; index < rest.length; index++) {
      const word = rest[index]!
      const redirect = /^(\d*|&)(>>?|<<?<?)(.*)$/u.exec(word)
      if (redirect === null) { args.push(word); continue }
      const target = redirect[3] || (rest[++index] ?? '')
      if (redirect[2]!.startsWith('>') && !target.startsWith('&') && !/^(?:\/dev\/null|nul|\$null)$/iu.test(target)) writes = target
      // A heredoc's lines follow its marker on the same line once the command is read as one; only a redirect straight after
      // the marker is the command's own.
      if (redirect[2] === '<<' || redirect[2] === '<<<') {
        const next = rest[index + 1] === undefined ? null : /^(\d*)(>>?)(.*)$/u.exec(rest[index + 1]!)
        if (next) writes = next[3] || rest[index + 2]
        break
      }
    }
    return { program, args, writes }
  }
  return null
}

/** The command's words, split into the parts of its pipelines and lists, with quotes taken off. */
function segments(command: string): string[][] {
  const all: string[][] = []
  let words: string[] = [], word = '', inWord = false, quote = ''
  const endWord = (): void => { if (inWord) words.push(word); word = ''; inWord = false }
  const endSegment = (): void => { endWord(); if (words.length) all.push(words); words = [] }
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (quote) {
      if (char === quote) quote = ''
      else if (char === '\\' && quote === '"' && index + 1 < command.length) word += command[++index]
      else word += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; inWord = true; continue }
    if (/\s/u.test(char)) { endWord(); continue }
    if (char === '|' || char === ';' || (char === '&' && command[index + 1] === '&')) {
      if (char !== ';' && command[index + 1] === char) index++
      endSegment()
      continue
    }
    word += char
    inWord = true
  }
  endSegment()
  return all
}

const programName = (word: string): string => word.split(/[\\/]/u).at(-1)!.replace(/\.(?:exe|cmd|bat|ps1)$/iu, '')

/** A path as the row says it: inside the thread's folder it reads from there, and the folder itself reads as no path. */
function place(path: string, folder: string | undefined): string {
  let shown = path.replace(/^\.[\\/]/u, '')
  if (folder) {
    const key = (value: string): string => value.replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
    const root = key(folder)
    if (key(shown) === root) return ''
    if (key(shown).startsWith(`${root}/`)) shown = shown.slice(root.length + 1)
  }
  return shown === '.' || shown === '' ? '' : isolated(shown)
}

/** A path, a pattern or a program kept in its own direction inside a sentence of either direction (ADR-0123). */
const isolated = (text: string): string => `⁨${text}⁩`

/**
 * The words a command was given that are not its flags, nor the values of the flags in `values` (named without their dashes:
 * `n` for `-n 80`, `max-count` for `--max-count 2`). After `--`, everything counts.
 */
function positionals(args: readonly string[], values: ReadonlySet<string> = new Set()): string[] {
  const found: string[] = []
  let flags = true
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!
    if (flags && word === '--') { flags = false; continue }
    if (word === '-') continue
    if (flags && word.length > 1 && word.startsWith('-')) {
      // A one-letter flag keeps its case, since -c and -C are different flags; longer ones and PowerShell's do not.
      const bare = word.replace(/^-+/u, '')
      const name = bare.length === 1 ? bare : bare.toLowerCase()
      if (!name.includes('=') && values.has(name)) index++
      continue
    }
    found.push(word)
  }
  return found
}

/** The value given to a named flag, such as PowerShell's `-Path x`, or undefined. */
function flagValue(args: readonly string[], names: readonly string[]): string | undefined {
  const at = args.findIndex(word => names.includes(word.replace(/^-+/u, '').toLowerCase()) && word.startsWith('-'))
  return at < 0 ? undefined : args[at + 1]
}
const hasFlag = (args: readonly string[], pattern: RegExp): boolean => args.some(word => word.startsWith('-') && pattern.test(word))

const READERS = new Set(['cat', 'type', 'get-content', 'gc', 'bat', 'less', 'more', 'head', 'tail', 'nl'])
/** head and tail take a count after -n and -c; cat's -n takes none. PowerShell's named parameters take a value. */
const HEAD_VALUES = new Set(['n', 'c', 'lines', 'bytes'])
const READ_VALUES = new Set(['totalcount', 'tail', 'head', 'first', 'encoding', 'delimiter', 'readcount', 'path', 'literalpath'])
const SEARCHERS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'select-string', 'sls', 'findstr'])
const SEARCH_VALUES = new Set(['e', 'f', 'g', 't', 'T', 'A', 'B', 'C', 'm', 'M', 'j', 'glob', 'type', 'type-not', 'max-count', 'context', 'after-context',
  'before-context', 'max-depth', 'sort', 'replace', 'include', 'exclude', 'exclude-dir', 'pattern', 'path', 'literalpath', 'encoding'])
const LISTERS = new Set(['ls', 'dir', 'get-childitem', 'gci', 'tree'])
const FINDERS = new Set(['find', 'fd', 'fdfind'])
const TESTERS = new Set(['vitest', 'jest', 'pytest', 'mocha'])
const PACKAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const SCRIPTS = new Set(['node', 'python', 'python3', 'py', 'deno', 'ruby', 'bash', 'sh', 'zsh', 'pwsh', 'powershell', 'tsx', 'ts-node'])

function purposeOf(program: string, args: readonly string[], writes: string | undefined, folder: string | undefined): string {
  const name = program.toLowerCase()
  if (writes && (READERS.has(name) || ['echo', 'printf', 'set-content', 'out-file', 'write-output'].includes(name)) && place(writes, folder)) {
    const file = place(writes, folder)
    return t({ message: `Write ${file}`, comment: 'A step that wrote a file, in Sotto\'s words for a command its provider did not describe; {file} is its path.' })
  }
  if (READERS.has(name)) {
    const named = flagValue(args, ['path', 'literalpath'])
    const files = named === undefined ? positionals(args, name === 'head' || name === 'tail' ? HEAD_VALUES : READ_VALUES) : [named]
    const count = files.length
    if (count > 1) return plural(count, { one: `Read ${{ files: shownCount(count) }} file`, other: `Read ${{ files: shownCount(count) }} files` })
    const file = files[0] === undefined ? '' : place(files[0], folder)
    if (file) return t({ message: `Read ${file}`, comment: 'A step that read a file, in Sotto\'s words for a command its provider did not describe; {file} is its path.' })
    return fallback(program)
  }
  if (name === 'sed' || name === 'perl') {
    const words = positionals(args, new Set(['e', 'f']))
    const script = flagValue(args, ['e']) === undefined ? 1 : 0
    const file = words[script] === undefined ? '' : place(words[script], folder)
    if (!file) return fallback(program)
    return hasFlag(args, /^-[a-z]*i/u)
      ? t({ message: `Edit ${file}`, comment: 'A step that changed a file in place, in Sotto\'s words for a command its provider did not describe; {file} is its path.' })
      : t({ message: `Read ${file}`, comment: 'A step that read a file, in Sotto\'s words for a command its provider did not describe; {file} is its path.' })
  }
  if (name === 'rg' && hasFlag(args, /^--files$/u)) return find(positionals(args, SEARCH_VALUES)[0], folder)
  if (SEARCHERS.has(name)) return search(name, args, folder)
  if (LISTERS.has(name)) {
    const where = flagValue(args, ['path', 'literalpath']) ?? positionals(args, new Set(['path', 'literalpath', 'filter', 'include', 'exclude', 'depth']))[0]
    // ls -R and Get-ChildItem -Recurse look through every folder under it; ls -r only reverses the order.
    if (hasFlag(args, /^-[A-Za-z]*R[A-Za-z]*$/u) && name !== 'tree') return find(where, folder)
    const shown = where === undefined ? '' : place(where, folder)
    return shown
      ? t({ message: `List ${shown}`, comment: 'A step that listed a folder, in Sotto\'s words for a command its provider did not describe; {shown} is the folder.' })
      : t({ message: 'List the folder', comment: 'A step that listed the thread\'s own folder, in Sotto\'s words for a command its provider did not describe.' })
  }
  if (FINDERS.has(name)) {
    // find names its folders before its first test; fd takes a pattern first, then the folder.
    const first = args.findIndex(word => word.startsWith('-'))
    const words = name === 'find' ? first < 0 ? args : args.slice(0, first) : positionals(args, new Set(['e', 't', 'd', 'extension', 'type', 'max-depth', 'exclude']))
    return find(name === 'find' ? words[0] : words[1], folder)
  }
  if (name === 'wc') {
    const files = positionals(args)
    const file = files.length === 1 && !/[*?]/u.test(files[0]!) ? place(files[0]!, folder) : ''
    return file
      ? t({ message: `Count the lines in ${file}`, comment: 'A step that counted a file\'s lines, in Sotto\'s words for a command its provider did not describe; {file} is its path.' })
      : t({ message: 'Count lines', comment: 'A step that counted the lines of several files, in Sotto\'s words for a command its provider did not describe.' })
  }
  if (name === 'git') return git(args, folder)
  if (TESTERS.has(name)) return tests(args, folder)
  if (name === 'npx' || name === 'pnpx' || name === 'bunx') {
    const words = positionals(args, new Set(['p', 'package']))
    return words.length ? purposeOf(programName(words[0]!), args.slice(args.indexOf(words[0]!) + 1), undefined, folder) : fallback(program)
  }
  if (PACKAGERS.has(name)) return packaged(program, args, folder)
  if (['cargo', 'go', 'dotnet'].includes(name) && positionals(args)[0] === 'test') return tests([], folder)
  if (name === 'mkdir' || name === 'md') {
    const where = positionals(args)[0]
    const shown = where === undefined ? '' : place(where, folder)
    if (shown) return t({ message: `Make the folder ${shown}`, comment: 'A step that made a folder, in Sotto\'s words for a command its provider did not describe; {shown} is the folder.' })
  }
  if (['rm', 'del', 'remove-item', 'rmdir', 'rd', 'ri'].includes(name)) {
    const where = flagValue(args, ['path', 'literalpath']) ?? positionals(args, new Set(['path', 'literalpath']))[0]
    const shown = where === undefined ? '' : place(where, folder)
    if (shown) return t({ message: `Remove ${shown}`, comment: 'A step that removed a file or folder, in Sotto\'s words for a command its provider did not describe; {shown} is its path.' })
  }
  if (['mv', 'move', 'move-item', 'mi', 'ren', 'rename-item'].includes(name)) {
    const where = positionals(args)[0]
    const shown = where === undefined ? '' : place(where, folder)
    if (shown) return t({ message: `Move ${shown}`, comment: 'A step that moved or renamed a file, in Sotto\'s words for a command its provider did not describe; {shown} is its path.' })
  }
  if (['cp', 'copy', 'copy-item', 'cpi'].includes(name)) {
    const where = positionals(args)[0]
    const shown = where === undefined ? '' : place(where, folder)
    if (shown) return t({ message: `Copy ${shown}`, comment: 'A step that copied a file, in Sotto\'s words for a command its provider did not describe; {shown} is its path.' })
  }
  if (name === 'apply_patch' || name === 'applypatch') return t({ message: 'Edit files', comment: 'A step that patched files, in Sotto\'s words for a command its provider did not describe.' })
  if (SCRIPTS.has(name)) {
    const words = positionals(args, new Set(['m', 'file', 'r', 'require', 'import', 'loader']))
    const module = flagValue(args, ['m'])
    if (module === 'pytest') return tests([], folder)
    const script = flagValue(args, ['file']) ?? words[0]
    if (module === undefined && script !== undefined && /\.[A-Za-z0-9]+$/u.test(script) && !hasFlag(args, /^-(?:c|e|command|eval)$/iu)) {
      return fallback(script.split(/[\\/]/u).at(-1)!)
    }
  }
  return fallback(program)
}

/**
 * What ran, by its name: a program Sotto has no other words for, a script, a package script or a git command. The row still
 * says what happened rather than showing the command.
 */
function fallback(program: string): string {
  const name = isolated(program)
  return t({ message: `Run ${name}`, comment: 'A step that ran something, in Sotto\'s words for a command its provider did not describe; {name} is what ran: a program such as node, a script such as build.mjs, a package script such as typecheck, or git and its subcommand, such as git push.' })
}

/** A search pattern short and plain enough to read inside a sentence: letters and words, with no pattern syntax. */
function plainPattern(pattern: string): string {
  const text = pattern.replace(/\\([.\-/ ])/gu, '$1')
  return text.length <= 40 && /^[\p{L}\p{N} _.:@#/-]+$/u.test(text) && /\p{L}/u.test(text) ? isolated(text) : ''
}

function search(name: string, args: readonly string[], folder: string | undefined): string {
  const named = flagValue(args, name === 'select-string' || name === 'sls' ? ['pattern'] : ['e', 'regexp'])
  const words = positionals(args, SEARCH_VALUES)
  const pattern = named ?? words.shift()
  const path = flagValue(args, ['path', 'literalpath'])
  const where = path === undefined ? words : [path]
  const shown = where.length === 1 ? place(where[0]!, folder) : ''
  const plain = pattern === undefined ? '' : plainPattern(pattern)
  if (shown && plain) return t({ message: `Search ${shown} for “${plain}”`, comment: 'A step that searched files, in Sotto\'s words for a command its provider did not describe; {shown} is where, {plain} what for.' })
  if (plain) return t({ message: `Search for “${plain}”`, comment: 'A step that searched the files, in Sotto\'s words for a command its provider did not describe; {plain} is what for.' })
  if (shown) return t({ message: `Search ${shown}`, comment: 'A step that searched files, in Sotto\'s words for a command its provider did not describe; {shown} is where.' })
  return t({ message: 'Search the files', comment: 'A step that searched files, in Sotto\'s words for a command its provider did not describe.' })
}

function find(where: string | undefined, folder: string | undefined): string {
  const shown = where === undefined ? '' : place(where, folder)
  return shown
    ? t({ message: `Find files in ${shown}`, comment: 'A step that looked for files, in Sotto\'s words for a command its provider did not describe; {shown} is the folder.' })
    : t({ message: 'Find files', comment: 'A step that looked for files, in Sotto\'s words for a command its provider did not describe.' })
}

function git(args: readonly string[], folder: string | undefined): string {
  const words = positionals(args, new Set(['c', 'C', 'git-dir', 'work-tree']))
  const sub = words[0]?.toLowerCase()
  switch (sub) {
    case undefined: return fallback('git')
    case 'status': return t({ message: 'Check git status', comment: 'A step that ran git status, in Sotto\'s words for a command its provider did not describe.' })
    case 'diff': {
      // A file is what follows `--`, or a name with an extension; origin/main and HEAD~1 are what it compares against.
      const split = args.indexOf('--')
      const files = split >= 0 ? args.slice(split + 1) : words.slice(1).filter(word => /\.[A-Za-z0-9]+$/u.test(word) && !word.includes('..'))
      const shown = files.length === 1 ? place(files[0]!, folder) : ''
      return shown
        ? t({ message: `Read the changes to ${shown}`, comment: 'A step that ran git diff on one file, in Sotto\'s words for a command its provider did not describe; {shown} is the file.' })
        : t({ message: 'Read the changes', comment: 'A step that ran git diff, in Sotto\'s words for a command its provider did not describe.' })
    }
    case 'log': return t({ message: 'Read the git history', comment: 'A step that ran git log, in Sotto\'s words for a command its provider did not describe.' })
    case 'show': return t({ message: 'Read a commit', comment: 'A step that ran git show, in Sotto\'s words for a command its provider did not describe.' })
    case 'grep': return search('grep', words.slice(1), folder)
    default: return fallback(`git ${words[0]!}`)
  }
}

/** Tests by any runner: one file named reads as that file's tests. */
function tests(args: readonly string[], folder: string | undefined): string {
  const files = positionals(args, new Set(['t', 'reporter', 'config', 'c', 'project', 'k', 'max-workers', 'maxworkers'])).filter(word => /[\\/]|\.(?:test|spec)\./u.test(word))
  const shown = files.length === 1 ? place(files[0]!, folder) : ''
  return shown
    ? t({ message: `Run the tests in ${shown}`, comment: 'A step that ran one file\'s tests, in Sotto\'s words for a command its provider did not describe; {shown} is the file.' })
    : t({ message: 'Run the tests', comment: 'A step that ran tests, in Sotto\'s words for a command its provider did not describe.' })
}

/** npm, pnpm, yarn and bun: tests, installs, and a script by its name. */
function packaged(program: string, args: readonly string[], folder: string | undefined): string {
  const words = positionals(args, new Set(['w', 'workspace', 'filter', 'prefix', 'c']))
  const sub = words[0]?.toLowerCase()
  if (sub === undefined) return program.toLowerCase() === 'yarn' ? installs() : fallback(program)
  if (sub === 'test' || sub === 't' || sub === 'tst') return tests(words.slice(1), folder)
  if (['install', 'i', 'ci', 'add'].includes(sub)) return installs()
  const script = sub === 'run' || sub === 'run-script' ? words[1] : program.toLowerCase() === 'npm' ? undefined : words[0]
  if (script === undefined) return fallback(program)
  if (/^test(?:$|[:-])/iu.test(script)) return tests(words.slice(sub === 'run' || sub === 'run-script' ? 2 : 1), folder)
  return fallback(script)
}

const installs = (): string => t({ message: 'Install packages', comment: 'A step that installed packages, in Sotto\'s words for a command its provider did not describe.' })
