import { accessSync, constants, mkdirSync, promises as fsPromises, readlinkSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { i18n } from '@lingui/core'
import { compileMessage } from '@lingui/message-utils/compileMessage'
import { afterEach, vi } from 'vitest'
import { installGitGuard, scrubRedirectingGitVariables } from './fixtures/gitGuard'

// Tests read English whatever this computer's language is (ADR-0123): nothing here asks the system, and every
// message shows its English source, extracted or not, compiled the way a catalog would compile it.
i18n.setMessagesCompiler(compileMessage)
i18n.loadAndActivate({ locale: 'en', messages: {} })

// macOS: /var/folders is a symlink to /private/var/folders. Git, fs.realpath and PATH
// lookups return the physical path, so a test that builds expected paths from os.tmpdir()
// never matches — the same class of mismatch as the Windows runner's 8.3 TEMP
// (see .github/workflows/ci.yml). Point TMPDIR at the real path before any fixture runs.
if (process.platform === 'darwin') {
  process.env.TMPDIR = realpathSync(tmpdir())
  putGitFirstOnPath()
}

// A test may change only repositories it made under the temporary folder (`fixtures/gitGuard.ts`). Variables a Git
// hook or alias that ran the tests left behind would point every child Git at that repository, so they go first; the
// guard then refuses a commit, reset, checkout or any other change to a repository outside the temporary folder.
// It is installed after the macOS TMPDIR above, so it guards the folder the fixtures actually use.
scrubRedirectingGitVariables()
installGitGuard()

// macOS: a spawn by bare name tries each PATH folder in turn, and from a test worker every folder that
// holds no match costs a few milliseconds. npx's node_modules/.bin folders and a developer's own PATH put
// /usr/bin twenty folders down, so each `git` cost about 100 ms before it ran, and the Git-backed files,
// which start hundreds of them, ran past their deadline on a loaded machine. A folder holding only a link
// to the same Git, put first, finds it at once. Nothing else on PATH moves.
function putGitFirstOnPath(): void {
  const path = process.env.PATH ?? ''
  const folders = path.split(delimiter)
  const folder = join(process.env.TMPDIR!, `sotto-test-git-${process.getuid?.() ?? 0}`)
  if (folders[0] === folder) return
  const git = folders.map(entry => join(entry, 'git')).find(candidate => {
    try { accessSync(candidate, constants.X_OK); return true } catch { return false }
  })
  if (!git) return
  const target = realpathSync(git), link = join(folder, 'git')
  mkdirSync(folder, { recursive: true })
  // Another worker may have made the link already; one left from a Git that has since moved is replaced.
  try { if (readlinkSync(link) !== target) { unlinkSync(link); symlinkSync(target, link) } }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; try { symlinkSync(target, link) } catch (raced) { if ((raced as NodeJS.ErrnoException).code !== 'EEXIST') throw raced } }
  process.env.PATH = [folder, ...folders].join(delimiter)
}

// jsdom keeps one web storage per test file, so whatever a test leaves behind is read by the next one.
// The renderer paints the cached agent shell on its first frame, so a leftover shell makes the first
// assertion after mounting a race between that stale paint and the bridge's first answer — a race a
// loaded machine loses. Every test starts from empty storage instead.
// Testing Library's findBy and waitFor give up after one second, the same machine-describing deadline that
// `vitest.config.ts` raises for `expect.poll`. A render that waits on a resolved command can take longer than
// that on a loaded runner, so they get the same five seconds; something genuinely missing still fails.
// Only DOM files need renderer cleanup and matchers. Loading React for every Node fixture
// paid that module setup again in hundreds of files without exercising a renderer.
if (typeof document !== 'undefined') {
  const { configure } = await import('@testing-library/react')
  await import('@testing-library/jest-dom/vitest')
  configure({ asyncUtilTimeout: 5_000 })
  // The turns whose working line Escape folded are kept for the window's life, so each test starts with none.
  const { foldedTurns } = await import('../src/renderer/src/agents/stepsOpen')
  afterEach(() => foldedTurns.clear())
}

// ProseMirror measures selections to scroll the caret; jsdom has no layout or hit testing.
if (typeof Range !== 'undefined') {
  Range.prototype.getBoundingClientRect ??= () => new DOMRect()
  Range.prototype.getClientRects ??= () => Object.assign([], { item: () => null })
  document.elementFromPoint ??= () => null
}

// vitest's own `vi.waitFor` and `vi.waitUntil` give up after one second as well, and no setting raises them, so a
// call that names no deadline gets the same five seconds here. A call that passes its own timeout keeps it, and one that
// passes only an interval keeps that interval. Under fake timers a wait advances the fake clock while it waits, so
// there the wait keeps vitest's one second rather than moving fake time five. The five seconds sit well inside the
// suite's 15 s test deadline; a test that sets its own deadline of five seconds or less passes its waits a shorter one,
// or it reports "Test timed out" instead of the wait's own failure.
const SUITE_WAIT_MS = 5_000
type WaitOptions = number | { timeout?: number; interval?: number } | undefined
const withSuiteDeadline = (options: WaitOptions) => typeof options === 'number' || options?.timeout !== undefined || vi.isFakeTimers()
  ? options : { ...options, timeout: SUITE_WAIT_MS }
const vitestWaitFor = vi.waitFor, vitestWaitUntil = vi.waitUntil
vi.waitFor = ((callback, options) => vitestWaitFor(callback, withSuiteDeadline(options))) as typeof vi.waitFor
vi.waitUntil = ((callback, options) => vitestWaitUntil(callback, withSuiteDeadline(options))) as typeof vi.waitUntil

afterEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear()
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear()
})

// Windows keeps a directory entry alive for a moment after the last handle on it closes, so deleting a
// fixture's temporary folder right after the child process that used it exited fails with ENOTEMPTY or
// EBUSY — on a loaded machine often enough to redden CI, from a `finally` that is only tidying up.
// Node already retries such a delete when asked; every recursive delete in a test run asks by default.
// A caller that passes its own `maxRetries` still wins.
const removeTree = fsPromises.rm
fsPromises.rm = function rmWithWindowsRetries(path, options) {
  return options?.recursive === true
    ? removeTree(path, { maxRetries: 10, retryDelay: 50, ...options })
    : removeTree(path, options)
} as typeof fsPromises.rm
// `import { rm } from 'node:fs/promises'` binds the builtin's exports as they were; this republishes them.
syncBuiltinESMExports()
