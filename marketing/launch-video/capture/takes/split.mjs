// Beat 3: three threads side by side, all working at once.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { codex, grok, sleep, until } from '../lib/rig.mjs'
import { deskTake, threadIds } from './common.mjs'
import * as darkMode from '../scenes/darkMode.mjs'
import { cwdOf, runTests } from '../scenes/exchanges.mjs'

export async function openBeside(rig, title) {
  const sidebar = rig.main.getByRole('complementary', { name: 'Thread sidebar', exact: true })
  await sidebar.getByRole('button', { name: title, exact: true }).hover()
  await sidebar.getByRole('button', { name: `Open ${title} beside`, exact: true }).click({ force: true })
  await sleep(600)
}

const SOON = `
/** True when an item runs out within the next three days. */
export function expiresSoon(expiry: Date, today = new Date()): boolean {
  return daysLeft(expiry, today) <= 3
}
`
const IMPORT_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importCsv } from '../src/importCsv.ts'

test('imports a row with no expiry date', () => {
  const [item] = importCsv('name,quantity,expires\\nRice,2,')
  assert.equal(item.name, 'Rice')
  assert.equal(item.expires, undefined)
})
`

export async function split() {
  const rig = await deskTake()
  const t = threadIds()
  try {
    await rig.command({ type: 'select-thread', threadId: t.claude })
    darkMode.beforeSend()
    await rig.command({ type: 'manual-send', threadId: t.claude, text: darkMode.PROMPT })
    await darkMode.afterSend(rig, t.claude)
    await until(async () => (await rig.main.getByRole('button', { name: /sotto\/dark-mode-toggle/u }).count()) > 0, { what: 'the renamed branch on screen', timeout: 20_000 }).catch(() => undefined)
    await openBeside(rig, 'Fix expiry dates in the import')
    await openBeside(rig, 'Tests for the pantry store')
    await rig.main.getByRole('button', { name: 'Collapse sidebar', exact: true }).first().click()
    await rig.command({ type: 'manual-send', threadId: t.codex, text: 'Also mark items that expire within three days.' })
    await rig.command({ type: 'manual-send', threadId: t.grok, text: 'Add a test for a CSV row with no expiry date.' })
    await sleep(2500)
    const codexCwd = await cwdOf(rig, t.codex), grokCwd = await cwdOf(rig, t.grok)
    await rig.record('split')
    rig.mark('start')
    await Promise.all([
      darkMode.work(rig, t.claude, { pace: 0.9 }),
      (async () => {
        await sleep(300)
        await codex.say(t.codex, 'I’ll add an `expiresSoon` check beside `daysLeft` and use it on the list.', { wordMs: 60 })
        await codex.command(t.codex, 'rg -n "daysLeft" src', 'src/dates.ts:11:export function daysLeft(expiry: Date, today = new Date()): number {\nsrc/pages/ListPage.ts:15:        const left = expiry ? `${daysLeft(expiry)} days` : \'\'', { runMs: 700 })
        writeFileSync(join(codexCwd, 'src', 'dates.ts'), (await import('node:fs')).readFileSync(join(codexCwd, 'src', 'dates.ts'), 'utf8') + SOON)
        await codex.edit(t.codex, join(codexCwd, 'src', 'dates.ts'), `+export function expiresSoon(expiry: Date, today = new Date()): boolean {`)
        await codex.command(t.codex, 'npm test', runTests(codexCwd).split(/\r?\n/u).filter(line => /^ℹ (tests|pass|fail)/u.test(line)).join('\n'), { runMs: 1800 })
      })(),
      (async () => {
        await sleep(700)
        await grok.say(t.grok, 'A row with an empty expiry field should import with no date. I’ll add that case.\n\n', { wordMs: 60 })
        const write = randomUUID()
        await grok.tool(t.grok, { sessionUpdate: 'tool_call', toolCallId: write, title: 'Write test/importCsv.test.ts', kind: 'edit', status: 'in_progress', locations: [{ path: join(grokCwd, 'test', 'importCsv.test.ts') }] })
        writeFileSync(join(grokCwd, 'test', 'importCsv.test.ts'), IMPORT_TEST)
        await sleep(600)
        await grok.tool(t.grok, { sessionUpdate: 'tool_call_update', toolCallId: write, status: 'completed' })
        const run = randomUUID()
        await grok.tool(t.grok, { sessionUpdate: 'tool_call', toolCallId: run, title: 'npm test', kind: 'execute', status: 'in_progress', rawInput: { command: 'npm test' } })
      })(),
    ])
    await sleep(1500)
    await rig.stop()
  } finally { await rig.close() }
}
