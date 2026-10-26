// Beat 7: a new thread on its own worktree, the sidebar widened to show each thread's branch,
// and the working copy's Remove worktree.
import { input, sideAnswer, sleep, until } from '../lib/rig.mjs'
import { deskTake, threadIds } from './common.mjs'

const PROMPT = 'Show how many items expire this week at the top of the list.'

export async function worktrees() {
  const rig = await deskTake()
  const t = threadIds()
  try {
    await rig.command({ type: 'select-thread', threadId: t.codex })
    await sleep(1500)
    for (const provider of ['claude', 'codex', 'grok']) sideAnswer(provider, 'expiring-this-week')

    await rig.record('worktrees')
    await sleep(600)
    await rig.press('ctrl+shift+n')
    rig.mark('new-thread')
    const pane = rig.main.locator('section.thread-pane[data-focused]')
    const workspace = pane.getByRole('combobox', { name: 'Choose workspace' })
    await workspace.waitFor()
    await sleep(900)
    await rig.click(workspace, { ms: 600 })
    const option = rig.main.getByRole('listbox', { name: 'Workspace' }).getByRole('option', { name: /New worktree/u })
    await option.waitFor()
    await sleep(500)
    await rig.click(option, { ms: 400 })
    rig.mark('new-worktree')
    await sleep(500)
    await rig.click(pane.getByRole('textbox', { name: 'Prompt', exact: true }), { ms: 400 })
    await rig.type(PROMPT, 28)
    await sleep(300)
    await rig.press('enter', { cap: false })
    rig.mark('sent')
    await until(async () => (await rig.state()).host.threads.some(th => th.worktree?.branch?.includes('expiring-this-week')), { what: 'the new branch', timeout: 30_000 })
    for (const provider of ['claude', 'codex', 'grok']) sideAnswer(provider, 'Items expiring this week')
    await sleep(1200)

    // Widen the sidebar so each row shows its branch.
    const divider = rig.main.getByRole('separator', { name: /Resize (the )?(thread )?sidebar/iu }).first()
    const from = await rig.point(divider)
    rig.mark('widen')
    input('move', from.x, from.y, 500); await sleep(200)
    input('drag', from.x + 420, from.y, 900)
    await sleep(1600)

    // The working copy, and giving its folder back.
    const copy = pane.getByRole('button', { name: /^Working copy:/u }).first()
    await rig.click(copy, { ms: 600 })
    rig.mark('working-copy')
    const remove = rig.main.getByRole('button', { name: 'Remove worktree folder, keeping its branch' })
    await remove.waitFor()
    await sleep(400)
    await rig.moveTo(remove, 600)
    await sleep(2200)
    await rig.stop()
  } finally { await rig.close() }
}
