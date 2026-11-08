import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { writeProviderAction } from '../fixtures/providerRecords'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

/** A thread's status line in the sidebar, by the thread's title. */
const status = (page: Page, title: string) =>
  page.locator('.thread-nav__row', { has: page.getByRole('button', { name: title, exact: true }) }).locator('.thread-nav__status')

/** Does something to the main window in main. */
const mainWindow = (app: ElectronApplication, action: 'hide' | 'show' | 'size') => app.evaluate(({ BrowserWindow }, act) => {
  const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!
  if (act === 'size') window.setContentSize(1280, 800); else window[act]()
}, action)

// Issue #2156: a Codex question and two approvals, seen in the open thread only after a visit to Settings and back.
test('A Codex question or approval raised in the open thread shows at once, the window shown or hidden', async () => {
  test.setTimeout(120_000)
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-codex-open-request-' })).directory
  const root = join(profile, 'native-fixture')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  // No reply: the turn stays in progress, as Codex's does while it waits on a request.
  await writeFile(join(root, 'codex', 'script.json'), JSON.stringify({}))
  const previous = { root: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, executable: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto('success', profile)
    const { page } = launched
    await page.evaluate(async project => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { provider: 'codex', enabled: true, enabledProviders: ['codex'], checkClientUpdates: false } })
      await agents.command({ type: 'connect', provider: 'codex' })
      const created = await agents.command({ type: 'create-project', provider: 'codex', title: 'Open requests', path: project, useExisting: true })
      const projectId = created.host.projects.find(p => p.title === 'Open requests')!.id
      const modelId = (await agents.get()).host.models.find(m => m.providerId === 'codex' && m.ready)!.id
      const thread = await agents.command({ type: 'create-thread', projectId, title: 'Asks while open', titleSource: 'user', modelId, workingCopy: 'shared', runtimeMode: 'approval-required' })
      if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'Missing thread')
      await agents.command({ type: 'manual-send', threadId: thread.activeThreadId, text: 'Write the test file.' })
    }, join(root, 'project'))
    await page.reload(); await openThreads(page)
    await page.getByRole('button', { name: 'Asks while open', exact: true }).click()
    await expect(page.getByLabel('Thread transcript')).toContainText('Write the test file.')
    await mainWindow(launched.app, 'size')
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1280)
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
    await mainWindow(launched.app, 'hide')
    await expect(page.locator('html')).toHaveAttribute('data-window-hidden', '')
    await writeProviderAction(control, { type: 'permission', threadId: native.id, text: "printf 'three' > probe-three.txt" })
    await expect(page.locator('.agent-request')).toContainText("printf 'three' > probe-three.txt")
    await expect(status(page, 'Asks while open')).toContainText('Needs your approval')
    await mainWindow(launched.app, 'show')
    await expect(page.locator('html')).not.toHaveAttribute('data-window-hidden', '')
    await expect(page.locator('.agent-request')).toContainText("printf 'three' > probe-three.txt")
  } finally {
    if (launched) await closeSotto(launched)
    if (previous.root === undefined) delete process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT
    else process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = previous.root
    if (previous.executable === undefined) delete process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE
    else process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = previous.executable
    await removeOwnedE2EProfile(profile)
  }
})
