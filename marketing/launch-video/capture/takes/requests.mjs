// Beat 4: a permission request answered with Allow, then a question with choices answered.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { claude, codex, sleep, until } from '../lib/rig.mjs'
import { paths, stageEnvironment } from '../lib/stage.mjs'
import { deskTake, threadIds } from './common.mjs'
import * as darkMode from '../scenes/darkMode.mjs'
import { cwdOf } from '../scenes/exchanges.mjs'

/** pantry's real `npm run build` in a thread's folder, using the project's installed tools. */
export function build(cwd) {
  const tools = join(paths.project, 'node_modules')
  const env = stageEnvironment()
  try {
    execFileSync(process.execPath, [join(tools, 'typescript', 'bin', 'tsc'), '--noEmit', '-p', cwd], { cwd, env, encoding: 'utf8' })
    const out = execFileSync(process.execPath, [join(tools, 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'info'], { cwd, env: { ...env, NO_COLOR: '1' }, encoding: 'utf8' })
    return `> pantry@1.1.0 build\n> tsc --noEmit && vite build\n\n${out.trim()}`
  } catch (error) { return `${error.stdout ?? ''}${error.stderr ?? ''}` }
}

export async function requests() {
  const rig = await deskTake()
  const t = threadIds()
  try {
    await rig.command({ type: 'select-thread', threadId: t.claude })
    darkMode.beforeSend()
    await rig.command({ type: 'manual-send', threadId: t.claude, text: darkMode.PROMPT })
    await darkMode.afterSend(rig, t.claude)
    await darkMode.work(rig, t.claude, { pace: 0.15, withAgents: false })
    await rig.command({ type: 'manual-send', threadId: t.codex, text: 'Also mark items that expire within three days.' })
    await until(() => codex.turn(t.codex)?.status === 'inProgress', { what: 'the Codex turn' })
    const cwd = await cwdOf(rig, t.claude)
    await sleep(1500)
    await rig.record('requests')
    await sleep(600)
    await claude.act(t.claude, { type: 'permission', text: 'Build the app to check the toggle compiles' })
    rig.mark('permission')
    const allow = rig.main.getByRole('button', { name: /^Allow/u }).first()
    await allow.waitFor()
    await sleep(500)
    await rig.click(allow, { ms: 550 })
    rig.mark('allowed')
    await sleep(300)
    await claude.tool(t.claude, 'Bash', { command: 'npm run build', description: 'Build the app to check the toggle compiles' }, build(cwd), { runMs: 900 })
    await sleep(900)
    // Codex asks, in its own thread.
    await codex.act(t.codex, { type: 'question', text: 'How should items that expire soon be marked?', method: 'item/tool/requestUserInput', params: { isBlocking: true, questions: [{
      id: 'marking', header: 'Expiring soon', question: 'How should items that expire soon be marked?',
      options: [{ label: 'A badge beside the name', description: 'Keeps the list in the order you chose.' }, { label: 'Move them to the top', description: 'Changes the order while they are close to expiring.' }],
    }] } })
    const sidebar = rig.main.getByRole('complementary', { name: 'Thread sidebar', exact: true })
    await rig.click(sidebar.getByRole('button', { name: 'Fix expiry dates in the import', exact: true }), { ms: 600 })
    rig.mark('question')
    const option = rig.main.getByText('A badge beside the name', { exact: true }).first()
    await option.waitFor()
    await sleep(700)
    await rig.click(option, { ms: 500 })
    rig.mark('chosen')
    await sleep(250)
    await rig.click(rig.main.getByRole('button', { name: 'Send answer', exact: true }), { ms: 350 })
    rig.mark('answered')
    await sleep(600)
    await codex.say(t.codex, 'A badge it is. I’ll add one beside the name for anything with three days or fewer left.', { wordMs: 45 })
    await sleep(1200)
    await rig.stop()
  } finally { await rig.close() }
}
