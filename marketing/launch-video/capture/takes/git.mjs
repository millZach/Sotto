// Beat 6: Commit, push & PR from one press, with the message left for the thread's provider to write,
// then the pull request's merge checklist and Merge. GitHub is the repository's fake gh throughout.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fake } from '../lib/stage.mjs'
import { sideAnswer, sleep, until } from '../lib/rig.mjs'
import { deskTake, threadIds } from './common.mjs'
import * as darkMode from '../scenes/darkMode.mjs'
import { cwdOf, runTests } from '../scenes/exchanges.mjs'

const sideCalls = () => { try { return readFileSync(join(fake.claude, 'oneshot.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length } catch { return 0 } }

export async function git() {
  const rig = await deskTake()
  const t = threadIds()
  try {
    await rig.command({ type: 'select-thread', threadId: t.claude })
    darkMode.beforeSend()
    await rig.command({ type: 'manual-send', threadId: t.claude, text: darkMode.PROMPT })
    await darkMode.afterSend(rig, t.claude)
    await darkMode.work(rig, t.claude, { pace: 0.15, withAgents: false })
    const cwd = await cwdOf(rig, t.claude)
    await darkMode.finish(rig, t.claude, { tests: runTests(cwd).split(/\r?\n/u).filter(line => /^ℹ (tests|pass|fail)/u.test(line)).join('\n') })
    const pane = rig.main.locator('section.thread-pane[data-focused]')
    const quick = pane.locator('.git-action__quick')
    await until(async () => (await pane.locator('.git-action__label').textContent().catch(() => ''))?.includes('Commit, push & PR'), { what: 'the Git action to read Commit, push & PR', timeout: 30_000 })
    await sleep(1200)

    await rig.record('git')
    await sleep(700)
    rig.mark('action')
    await rig.click(quick, { ms: 700 })
    const dialog = rig.main.getByRole('dialog', { name: 'Commit changes' })
    await dialog.waitFor()
    rig.mark('dialog')
    await sleep(1600)
    // The provider writes the commit message, then the pull request text, one side call each.
    const before = sideCalls()
    sideAnswer('claude', darkMode.COMMIT)
    const swap = (async () => { await until(() => sideCalls() > before, { what: 'the commit message request', timeout: 60_000 }); sideAnswer('claude', darkMode.PULL_REQUEST) })()
    await rig.click(dialog.getByRole('button', { name: 'Commit, push & PR', exact: true }), { ms: 600 })
    rig.mark('committing')
    await swap
    const notice = pane.locator('.git-action-notice')
    await until(async () => (await notice.textContent().catch(() => ''))?.includes('#74'), { what: 'the pull request', timeout: 60_000 })
    rig.mark('created')
    // A teammate approves on GitHub while the notice is read.
    const state = JSON.parse(readFileSync(fake.ghState, 'utf8'))
    Object.assign(state.pulls[0], { reviewDecision: 'APPROVED', reviews: [{ state: 'APPROVED', url: `${state.pulls[0].url}#pullrequestreview-1`, author: { login: 'mira' } }] })
    writeFileSync(fake.ghState, JSON.stringify(state, null, 2))
    await sleep(1800)
    // Sotto's own Pull request surface in Tools. (View PR opens the pull request on GitHub in the browser.)
    await rig.click(rig.main.getByRole('button', { name: 'Tools', exact: true }), { ms: 600 })
    const tools = rig.main.getByRole('complementary', { name: 'Tools', exact: true })
    await rig.click(tools.getByRole('tab', { name: 'Pull request', exact: true }), { ms: 500 })
    rig.mark('checklist')
    const checklist = rig.main.getByRole('list', { name: 'Merge checklist' })
    await checklist.waitFor({ timeout: 60_000 })
    await sleep(2200)
    await rig.click(rig.main.getByRole('button', { name: 'Merge #74', exact: true }), { ms: 600 })
    const confirm = rig.main.getByRole('dialog', { name: 'Merge pull request?' })
    await confirm.waitFor()
    await sleep(900)
    await rig.click(confirm.getByRole('button', { name: /^Merge/u }).last(), { ms: 500 })
    rig.mark('merged')
    await sleep(2500)
    await rig.stop()
  } finally { await rig.close() }
}
