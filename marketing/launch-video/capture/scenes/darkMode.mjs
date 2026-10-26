// The Claude Code thread the film follows: a dark mode toggle for pantry's settings page, in its own worktree.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claude, sideAnswer, sleep, until } from '../lib/rig.mjs'
import { darkMode } from '../demo/edits.mjs'
import { cwdOf } from './exchanges.mjs'

export const PROMPT = 'Add a dark mode toggle to the settings page.'
export const BRANCH = 'dark-mode-toggle'
export const TITLE = 'Dark mode toggle in settings'
export const COMMIT = `Add a dark mode toggle to settings

Settings gains a darkMode switch under Appearance. Turning it on sets
data-theme="dark" on the page, and theme.css gives that theme its own
surface, text and accent colours.`
export const PULL_REQUEST = `Add a dark mode toggle to settings

## What changed

- A \`darkMode\` setting, off by default, saved with the other settings.
- A Dark mode switch in the Appearance section of the settings page.
- A dark palette in \`theme.css\`, applied through \`data-theme\` on the page.

## How it was checked

- \`npm test\` passes.
- Turned the switch on and off on /settings in the browser.`

/** Before the first send: the name its new worktree's branch will get from the thread's own provider. */
export function beforeSend() { sideAnswer('claude', BRANCH) }

/** After the first send: once the branch is named, the answer the title request will get. */
export async function afterSend(rig, threadId) {
  await until(async () => {
    const worktree = (await rig.state()).host.threads.find(t => t.id === threadId)?.worktree
    return worktree?.status === 'ready' && worktree.branch?.includes(BRANCH)
  }, { what: 'the dark-mode branch', timeout: 30_000 }).catch(() => undefined)
  sideAnswer('claude', TITLE)
}

const read = (cwd, path) => readFileSync(join(cwd, path), 'utf8')
const agents = [
  { task: randomUUID(), tool: `toolu_${randomUUID().replaceAll('-', '').slice(0, 20)}`, description: 'Find every colour the dark palette needs' },
  { task: randomUUID(), tool: `toolu_${randomUUID().replaceAll('-', '').slice(0, 20)}`, description: 'Check the settings page for other theme styles' },
]

async function startAgents(threadId) {
  for (const agent of agents) {
    await claude.frame(threadId, { type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null, message: { id: randomUUID(), role: 'assistant',
      content: [{ type: 'tool_use', id: agent.tool, name: 'Agent', input: { description: agent.description, prompt: agent.description, subagent_type: 'Explore', run_in_background: true } }] } }, true)
    await claude.frame(threadId, { type: 'system', subtype: 'task_started', uuid: randomUUID(), task_id: agent.task, tool_use_id: agent.tool, description: agent.description,
      subagent_type: 'Explore', is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent' })
    await claude.frame(threadId, { type: 'user', uuid: randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: agent.tool, content: 'Launched in the background.' }] } }, true)
    await sleep(250)
  }
}
export async function endAgents(threadId) {
  for (const agent of agents) {
    await claude.frame(threadId, { type: 'system', subtype: 'task_notification', uuid: randomUUID(), task_id: agent.task, tool_use_id: agent.tool, status: 'completed', summary: agent.description })
  }
}

/** The thread's work, from its first words to its last edit. `pace` stretches every pause. */
export async function work(rig, threadId, { pace = 1, withAgents = true } = {}) {
  const cwd = await cwdOf(rig, threadId)
  await until(() => claude.session(threadId), { what: 'the Claude session' })
  await sleep(500 * pace)
  await claude.say(threadId, 'I’ll add a `darkMode` setting, a switch in the Appearance section, and a dark palette for the switch to turn on.', { wordMs: 55 * pace })
  if (withAgents) await startAgents(threadId)
  await sleep(600 * pace)
  const settingsPath = 'src/settings/settings.ts'
  await claude.tool(threadId, 'Read', { file_path: join(cwd, settingsPath) }, read(cwd, settingsPath), { runMs: 300 * pace })
  darkMode.settings(cwd)
  await claude.tool(threadId, 'Edit', { file_path: join(cwd, settingsPath), old_string: "  sortBy: 'name' | 'expiry'\n}", new_string: "  sortBy: 'name' | 'expiry'\n  darkMode: boolean\n}" }, `The file ${join(cwd, settingsPath)} has been updated.`, { runMs: 500 * pace })
  darkMode.page(cwd)
  await claude.tool(threadId, 'Edit', { file_path: join(cwd, 'src/settings/SettingsPage.ts'), old_string: '<p class="hint">More options are on the way.</p>', new_string: '<label class="toggle">Dark mode' }, `The file ${join(cwd, 'src/settings/SettingsPage.ts')} has been updated.`, { runMs: 600 * pace })
  darkMode.theme(cwd)
  await claude.tool(threadId, 'Write', { file_path: join(cwd, 'src/theme.ts'), content: read(cwd, 'src/theme.ts') }, `File created successfully at: ${join(cwd, 'src/theme.ts')}`, { runMs: 400 * pace })
  darkMode.css(cwd)
  await claude.tool(threadId, 'Edit', { file_path: join(cwd, 'src/styles/theme.css'), old_string: ':root {', new_string: ":root[data-theme='dark'] {" }, `The file ${join(cwd, 'src/styles/theme.css')} has been updated.`, { runMs: 500 * pace })
}

export async function finish(rig, threadId, { tests } = {}) {
  if (tests) await claude.tool(threadId, 'Bash', { command: 'npm test', description: 'Run the tests' }, tests, { runMs: 900 })
  await endAgents(threadId)
  const text = 'The settings page has a Dark mode switch under Appearance. It saves with the other settings and sets `data-theme="dark"` on the page, which switches `theme.css` to its dark palette. All tests pass.'
  await claude.say(threadId, text, { wordMs: 25 })
  await claude.end(threadId, text)
}
