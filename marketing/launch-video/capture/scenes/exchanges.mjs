// The four threads in pantry, and the first exchange each has had before the film starts.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { paths, stageEnvironment } from '../lib/stage.mjs'
import { codex, devin, grok, sideAnswer, sleep, until } from '../lib/rig.mjs'
import { expiryDates, readme, storeTests } from '../demo/edits.mjs'

/** The folder a thread works in, once its worktree (if it has one) exists. */
export async function cwdOf(rig, threadId) {
  return until(async () => {
    const thread = (await rig.state()).host.threads.find(t => t.id === threadId)
    if (thread?.worktree?.mode === 'independent') return thread.worktree.status === 'ready' ? thread.worktree.path : undefined
    return thread?.workingDirectory ?? paths.project
  }, { what: 'the thread’s folder', timeout: 60_000 })
}

/** The real output of pantry's tests in a folder, as the terminal or a command activity shows it. */
export function runTests(cwd) {
  try { return execFileSync(process.execPath, ['--test'], { cwd, env: stageEnvironment(), encoding: 'utf8' }) }
  catch (error) { return `${error.stdout ?? ''}${error.stderr ?? ''}` }
}
const summary = output => output.split(/\r?\n/u).filter(line => /^ℹ (tests|pass|fail)/u.test(line)).join('\n')

async function send(rig, threadId, text) { await rig.command({ type: 'manual-send', threadId, text }) }

async function waitForBranch(rig, threadId) {
  await until(async () => {
    const worktree = (await rig.state()).host.threads.find(t => t.id === threadId)?.worktree
    return worktree?.status === 'ready' && worktree.branch && !worktree.temporaryBranch
  }, { what: 'the generated branch name', timeout: 30_000 }).catch(() => undefined)
}

export const exchanges = [
  {
    key: 'claude', provider: 'claude', worktree: true, runtimeMode: 'auto-accept-edits', effort: 'high',
    // The hook's thread: open, never written in, set to start its own worktree on the first send.
  },
  {
    key: 'codex', provider: 'codex', worktree: true,
    async prepare(rig, threadId) {
      sideAnswer('codex', 'fix-expiry-dates')
      await send(rig, threadId, 'Imported dates like 2026-10-4 come through empty. Make the CSV import accept single-digit days and months.')
      await waitForBranch(rig, threadId)
      sideAnswer('codex', 'Fix expiry dates in the import')
      const cwd = await cwdOf(rig, threadId)
      await until(() => codex.turn(threadId), { what: 'the Codex turn' })
      await codex.say(threadId, 'I’ll check how the import reads dates first.')
      await codex.command(threadId, 'rg -n "parseExpiry" src', 'src/dates.ts:2:export function parseExpiry(text: string): Date | null {\nsrc/importCsv.ts:9:    const date = expires ? parseExpiry(expires) : null')
      expiryDates.dates(cwd); await codex.edit(threadId, `${cwd}\\src\\dates.ts`, '-  const iso = /^(\\d{4})-(\\d{2})-(\\d{2})$/\n+  const iso = /^(\\d{4})-(\\d{1,2})-(\\d{1,2})$/')
      expiryDates.test(cwd); await codex.edit(threadId, `${cwd}\\test\\dates.test.ts`, "+test('reads single-digit days and months', () => {")
      await codex.command(threadId, 'npm test', summary(runTests(cwd)), { runMs: 1400 })
      await codex.complete(threadId, 'Single-digit days and months import now: `2026-10-4` and `4/9/2026` both read as dates. I widened both patterns in `src/dates.ts` and added a test for each form. All 5 tests pass.')
    },
  },
  {
    key: 'grok', provider: 'grok', worktree: true,
    async prepare(rig, threadId) {
      sideAnswer('grok', 'store-tests')
      await send(rig, threadId, 'Write tests for the pantry store: adding, saving and loading items.')
      await waitForBranch(rig, threadId)
      sideAnswer('grok', 'Tests for the pantry store')
      const cwd = await cwdOf(rig, threadId)
      await sleep(800)
      await grok.say(threadId, 'I’ll give the store an in-memory storage so the tests don’t need a browser.\n\n')
      const write = randomUUID()
      await grok.tool(threadId, { sessionUpdate: 'tool_call', toolCallId: write, title: 'Write test/store.test.ts', kind: 'edit', status: 'in_progress', locations: [{ path: `${cwd}\\test\\store.test.ts` }] })
      storeTests.test(cwd)
      await grok.tool(threadId, { sessionUpdate: 'tool_call_update', toolCallId: write, status: 'completed' })
      const run = randomUUID()
      await grok.tool(threadId, { sessionUpdate: 'tool_call', toolCallId: run, title: 'npm test', kind: 'execute', status: 'in_progress', rawInput: { command: 'npm test' } })
      const output = summary(runTests(cwd))
      await grok.tool(threadId, { sessionUpdate: 'tool_call_update', toolCallId: run, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: output } }] })
      await grok.say(threadId, 'Four tests cover adding, the expiry date, saving and loading, and an empty pantry. All 8 tests pass.')
      await grok.act(threadId, { type: 'complete', text: '' })
    },
  },
  {
    key: 'devin', provider: 'devin', worktree: true,
    async prepare(rig, threadId) {
      // Devin writes no titles or branch names (ADR-0026), so this one was named by hand.
      await rig.command({ type: 'rename-thread', threadId, title: 'Tidy the README' })
      await send(rig, threadId, 'Tidy the README: add how to run the tests.')
      const cwd = await cwdOf(rig, threadId)
      await sleep(1500)
      readme.write(cwd)
      await devin.complete(threadId, 'The README now has a Test it section with `npm test`, and says which date formats the import reads.')
    },
  },
]
