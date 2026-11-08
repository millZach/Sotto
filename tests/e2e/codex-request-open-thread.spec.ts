import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { APP_WINDOW_VISIBLE } from '../../src/shared/channels'
import { evidenceDirectory } from '../fixtures/evidence'
import { writeProviderAction } from '../fixtures/providerRecords'
import { startCodexThread, withNativeCodexFixture } from './support/nativeCodexFixture'
import { openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

const evidence = evidenceDirectory('artifacts/hidden-window-requests')

/** A thread's status line in the sidebar, by the thread's title. */
const status = (page: Page, title: string) =>
  page.locator('.thread-nav__row', { has: page.getByRole('button', { name: title, exact: true }) }).locator('.thread-nav__status')

/**
 * Tells the page what main tells it when the window hides or shows (`sotto:app:window-visible`), and leaves the window on
 * screen, so the page can still be pictured: main's word is what the page holds broadcasts by on every platform, and
 * hiding the window itself, which stops it drawing, changes nothing more on Linux.
 */
const sayWindowShown = (launched: LaunchedSotto, shown: boolean) => launched.app.evaluate(({ BrowserWindow }, { channel, shown }) => {
  BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!.webContents.send(channel, shown)
}, { channel: APP_WINDOW_VISIBLE, shown })

// Issue #2156: a Codex question and two approvals, seen in the open thread only after a visit to Settings and back.
test('A Codex question or approval raised in the open thread shows at once, the window shown or hidden', async () => {
  test.setTimeout(120_000)
  // No reply: the turn stays in progress, as Codex's does while it waits on a request.
  await withNativeCodexFixture('sotto-e2e-codex-open-request-', {}, async ({ launched, root }) => {
    const { page } = launched
    await startCodexThread(page, root, { project: 'Open requests', thread: 'Asks while open', prompt: 'Write the test file.', runtimeMode: 'approval-required' })
    await page.reload(); await openThreads(page)
    await page.getByRole('button', { name: 'Asks while open', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('Write the test file.')
    await resizeContentWindow(launched, 1280, 800)
    // At this width the sidebar sits beside the pane, each row with its status line.
    await expect(status(page, 'Asks while open')).toContainText('Working')
    await expect(page.locator('.agent-request')).toHaveCount(0)
    const native = Object.values(JSON.parse(await readFile(join(root, 'codex', 'state.json'), 'utf8')).threads)[0] as { id: string }
    const control = join(root, 'codex', 'control.json')

    // Shown: the question, then two approvals, as the issue raised them. Nothing here navigates or sends a command until
    // the card is on screen.
    for (const [kind, text, label] of [['question', 'Which colour should the file use?', 'Needs your answer'],
      ['permission', "printf 'one' > probe-one.txt", 'Needs your approval'], ['permission', "printf 'two' > probe-two.txt", 'Needs your approval']] as const) {
      await writeProviderAction(control, { type: kind, threadId: native.id, text })
      await expect(page.locator('.agent-request')).toContainText(text)
      await expect(status(page, 'Asks while open')).toContainText(label)
      if (kind === 'question') await page.locator('.agent-request').getByRole('radio', { name: /Blue/u }).check()
      await page.locator('.agent-request').getByRole('button', { name: kind === 'question' ? 'Send answer' : 'Allow once' }).click()
      await expect(page.locator('.agent-request')).toHaveCount(0)
      await expect(status(page, 'Asks while open')).toContainText('Working')
    }

    // Hidden: main says nobody can see the window, which held every broadcast until the window showed again or a command
    // answered, such as the one going back to Threads sends. Whatever reads the page while the system calls the window
    // hidden, such as a computer-use agent, saw the thread still working while main held the request (#2156).
    await sayWindowShown(launched, false)
    await expect(page.locator('html')).toHaveAttribute('data-window-hidden', '')
    const asked = "printf 'three' > probe-three.txt"
    await writeProviderAction(control, { type: 'permission', threadId: native.id, text: asked })
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.some(thread => thread.requests.length > 0))).toBe(true)
    // Long enough for a broadcast to have reached the page; the picture shows what it did with it.
    await page.waitForTimeout(1_000)
    await page.screenshot({ path: join(evidence, 'hidden-request-1280.png'), animations: 'disabled' })
    await expect(page.locator('.agent-request')).toContainText(asked)
    await expect(status(page, 'Asks while open')).toContainText('Needs your approval')
    // Answered while main still says hidden, and the turn that goes on ends: the reply and the finished turn reach the page
    // too, with no visit to another page.
    await page.locator('.agent-request').getByRole('button', { name: 'Allow once' }).click()
    await expect(page.locator('.agent-request')).toHaveCount(0)
    await writeProviderAction(control, { type: 'complete', threadId: native.id, text: 'Wrote probe-three.txt.' })
    await expect(page.getByLabel('Thread transcript')).toContainText('Wrote probe-three.txt.')
    await expect(status(page, 'Asks while open')).not.toContainText('Working')
    await page.screenshot({ path: join(evidence, 'hidden-finished-1280.png'), animations: 'disabled' })
    await sayWindowShown(launched, true)
    await expect(page.locator('html')).not.toHaveAttribute('data-window-hidden', '')
    await expect(page.getByLabel('Thread transcript')).toContainText('Wrote probe-three.txt.')
  })
})
