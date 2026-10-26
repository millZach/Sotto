// Beat 5: the Tools beside the thread. The agent checks the switch in Sotto's browser through the browser
// tools Sotto gave its session; then the terminal, Files, and a comment on lines in Changes.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { claude, sleep, until } from '../lib/rig.mjs'
import { connectMcp } from '../lib/mcp.mjs'
import { paths, stageEnvironment } from '../lib/stage.mjs'
import { deskTake, threadIds } from './common.mjs'
import * as darkMode from '../scenes/darkMode.mjs'
import { cwdOf, runTests } from '../scenes/exchanges.mjs'

/** pantry's dev server on the thread's folder, as `npm run dev` would start it there. */
export async function devServer(cwd) {
  const server = spawn(process.execPath, [join(paths.project, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '5173', '--strictPort'], { cwd, env: stageEnvironment(), stdio: 'ignore' })
  await until(async () => { try { return (await fetch('http://localhost:5173/settings')).ok } catch { return false } }, { what: 'the dev server', timeout: 30_000 })
  return server
}

/** One browser tool call, shown in the thread as Claude Code shows it, and made through Sotto's MCP endpoint. */
async function browserCall(threadId, mcp, server, name, args) {
  const toolId = `toolu_${randomUUID().replaceAll('-', '').slice(0, 20)}`
  await claude.frame(threadId, { type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: `mcp__${server}__${name}`, input: args }] } }, true)
  const result = await mcp.call(name, args)
  await claude.frame(threadId, { type: 'user', uuid: randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: typeof result === 'string' ? result : JSON.stringify(result).slice(0, 2000) }] } }, true)
  return result
}

export async function tools() {
  const rig = await deskTake()
  const t = threadIds()
  let server
  try {
    await rig.command({ type: 'select-thread', threadId: t.claude })
    darkMode.beforeSend()
    await rig.command({ type: 'manual-send', threadId: t.claude, text: darkMode.PROMPT })
    await darkMode.afterSend(rig, t.claude)
    await darkMode.work(rig, t.claude, { pace: 0.15, withAgents: false })
    const cwd = await cwdOf(rig, t.claude)
    await darkMode.finish(rig, t.claude, { tests: runTests(cwd).split(/\r?\n/u).filter(line => /^ℹ (tests|pass|fail)/u.test(line)).join('\n') })
    server = await devServer(cwd)
    await rig.command({ type: 'manual-send', threadId: t.claude, text: 'Check the switch in the browser.' })
    await until(() => claude.browserServer(t.claude), { what: 'the browser endpoint' })
    const endpoint = claude.browserServer(t.claude)
    const mcp = await connectMcp(endpoint)
    await sleep(1500)

    await rig.record('tools')
    // The browser: open the settings page, find the switch, press it.
    await claude.say(t.claude, 'I’ll open the settings page and turn the switch on.', { wordMs: 50 })
    rig.mark('browser')
    const opened = await browserCall(t.claude, mcp, endpoint.name, 'browser_open', { url: 'http://localhost:5173/settings', description: 'Turn dark mode on from the settings page' })
    const taskId = opened.task.id, pageId = opened.task.pageId
    // The page opens in the floating player; it goes into Tools, where the agent's clicks land (an agent's click
    // on a page shown in the player finds no element there today: see the launch video's report).
    await sleep(1600)
    rig.mark('move-into-tools')
    await rig.click(rig.main.getByRole('button', { name: 'Move the browser into Tools' }), { ms: 600 })
    await sleep(1200)
    let target = findSwitch(await browserCall(t.claude, mcp, endpoint.name, 'browser_action', { pageId, taskId, action: { type: 'inspect' } }))
    if (target.y > 220) {
      await browserCall(t.claude, mcp, endpoint.name, 'browser_action', { pageId, taskId, action: { type: 'scroll', x: 120, y: 120, deltaX: 0, deltaY: target.y - 180 } })
      await sleep(700)
      target = findSwitch(await browserCall(t.claude, mcp, endpoint.name, 'browser_action', { pageId, taskId, action: { type: 'inspect' } }))
    }
    await sleep(500)
    await browserCall(t.claude, mcp, endpoint.name, 'browser_action', { pageId, taskId, action: { type: 'click', ...target } })
    rig.mark('dark')
    await sleep(2200)
    await browserCall(t.claude, mcp, endpoint.name, 'browser_finish', { pageId, taskId, status: 'completed', summary: 'Turned Dark mode on at /settings; the page switched to the dark palette.', unchecked: ['Other pages after a reload'] })
    await claude.say(t.claude, 'The switch works: the page turns dark at once.', { wordMs: 40 })
    await claude.end(t.claude, 'The switch works: the page turns dark at once.')

    // The terminal.
    const panel = rig.main.getByRole('complementary', { name: 'Tools', exact: true })
    await rig.click(panel.getByRole('tab', { name: 'Terminal', exact: true }), { ms: 500 })
    rig.mark('terminal')
    // The page went into Tools, so leaving Browser brings the player back over the thread; hide it.
    await rig.main.getByRole('button', { name: 'Hide the browser; the agent keeps working' }).click().catch(() => undefined)
    const start = panel.getByRole('button', { name: 'Start terminal', exact: true })
    await start.waitFor({ timeout: 10_000 })
    await rig.click(start, { ms: 400 })
    const terminal = panel.locator('.xterm').first()
    await terminal.waitFor({ timeout: 20_000 })
    await sleep(1800)
    await rig.click(terminal, { ms: 300 })
    await rig.type('npm test', 70)
    await rig.press('enter', { cap: false })
    await sleep(3500)

    // Files.
    await rig.click(panel.getByRole('tab', { name: 'Files', exact: true }), { ms: 500 })
    rig.mark('files')
    for (const name of ['src', 'settings', 'SettingsPage.ts']) {
      const item = panel.getByRole('treeitem', { name, exact: true }).first()
      await item.waitFor({ timeout: 10_000 })
      await sleep(300)
      await rig.click(item, { ms: 350 })
    }
    rig.mark('file-open')
    await sleep(2400)

    // Changes, and a comment on lines.
    await rig.click(panel.getByRole('tab', { name: 'Changes', exact: true }), { ms: 500 })
    rig.mark('changes')
    const expand = panel.getByRole('button', { name: 'Expand src/styles/theme.css', exact: true })
    await expand.waitFor({ timeout: 15_000 })
    await sleep(500)
    await rig.click(expand, { ms: 400 })
    const lines = panel.getByRole('grid', { name: 'Lines of src/styles/theme.css' })
    await lines.waitFor({ timeout: 15_000 })
    const first = lines.locator('[data-position][data-new-line="12"]'), last = lines.locator('[data-position][data-new-line="13"]')
    await first.scrollIntoViewIfNeeded()
    await sleep(700)
    await rig.click(first, { ms: 500 })
    await sleep(250)
    await rig.click(last, { ms: 300, shift: true })
    await sleep(400)
    await rig.click(panel.getByRole('button', { name: /^Comment on theme\.css L/u }).first(), { ms: 500 })
    await sleep(300)
    await rig.type('Check these two against the card colours.', 40)
    await sleep(400)
    await rig.click(panel.getByRole('button', { name: 'Comment', exact: true }), { ms: 400 })
    rig.mark('commented')
    await sleep(2200)
    await rig.stop()
  } finally { server?.kill(); await rig.close() }
}

/** The Dark mode switch's centre in page pixels, from the page inspection the browser tool returns. */
function findSwitch(inspected) {
  const page = JSON.parse(inspected.output)
  const element = page.elements.find(e => e.tag === 'input' && (e.role === 'switch' || /dark/iu.test(e.name ?? '')))
    ?? page.elements.find(e => e.tag === 'input')
  if (!element) throw new Error(`No Dark mode switch in the page inspection: ${JSON.stringify(page.elements).slice(0, 800)}`)
  return { x: Math.round(element.x + element.width / 2), y: Math.round(element.y + element.height / 2) }
}
