import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { AgentRequest, AgentState } from '../../src/shared/agents'
import { closeSotto, launchSotto, launchSottoWithVoice, openThreads, type LaunchedSotto } from './support/sottoLaunch'

// A provider's question or permission on a thread with no assignment never enters the coordinator's attention
// queue, which holds requests only for threads with one. The sidebar row still has to say the thread is waiting on you,
// with the voice coordinator on or off, and stop saying so once you answer. The app is real end to end; only
// the provider's effects come from the unpackaged E2E host.

const question: AgentRequest = {
  id: 'report-choice', kind: 'question', text: 'Which report should I keep?', options: [], questions: [{
    id: 'report', question: 'Which report should I keep?', multiSelect: false, allowFreeText: false,
    options: [{ id: 'weekly', label: 'The weekly report' }, { id: 'monthly', label: 'The monthly report' }],
  }],
}
const permission: AgentRequest = {
  id: 'run-build', kind: 'permission', text: 'Run the build', options: [],
  context: { toolName: 'Bash', toolCallId: 'tool-1', command: 'npm run build' },
  permissionChoices: [{ id: 'once', label: 'Allow once', kind: 'allow-once' }, { id: 'reject', label: 'Deny', kind: 'deny' }],
}

async function prepare(page: Page, appearance: 'dark' | 'light'): Promise<void> {
  await page.evaluate(async appearance => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
    await window.sotto!.agents!.command({ type: 'connect' })
  }, appearance)
  await page.reload()
  await openThreads(page)
}

async function resize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [width, height]) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(width, height)
  }, [width, height] as const)
  // The window's own 820 × 560 minimum can round the content height up by a pixel or two.
  await expect.poll(() => page.evaluate(([width, height]) => window.innerWidth === width && Math.abs(window.innerHeight - height) <= 2, [width, height] as const)).toBe(true)
}

const state = (page: Page): Promise<AgentState> => page.evaluate(() => window.sotto!.agents!.get())
const row = (page: Page, title: string): Locator => page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: title, exact: true })
const pending = async (page: Page, threadId: string): Promise<string[] | undefined> =>
  (await state(page)).host.threads.find(thread => thread.id === threadId)?.requests.map(request => request.id)

async function emit(page: Page, threadId: string, request: AgentRequest): Promise<void> {
  await page.evaluate(async ([threadId, request]) => window.sottoE2E!.agentEvent!({ type: request.kind, threadId, text: request.text, request, status: 'running' }), [threadId, request] as const)
}

async function open(page: Page, title: string): Promise<void> {
  await row(page, title).click()
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
}

/** The row, and the collapsed rail's button for it, both say what the thread waits on; the rail carries it in its title. */
async function expectWaiting(page: Page, title: string, waiting: 'question' | 'approval', label: string, capture: string): Promise<void> {
  const status = row(page, title).locator('.thread-nav__status')
  // The visible words, after the provider's name that only a screen reader hears.
  await expect(status).toHaveAttribute('title', label)
  await expect(status).toHaveText(`Claude, ${label}`)
  await expect(status).toHaveAttribute('data-state', 'needs')
  await expect(status).toHaveAttribute('data-waiting', waiting)
  await expect(row(page, title).locator('.thread-nav__ring')).toHaveAttribute('data-waiting', waiting)
  await page.screenshot({ path: `artifacts/sidebar-question/${capture}.png`, animations: 'disabled' })
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  const rail = page.locator(`.thread-nav__rail-thread[aria-label="${title}"]`)
  await expect(rail).toHaveAttribute('title', `${title} · ${label}`)
  await expect(rail.locator('.thread-nav__ring')).toHaveAttribute('data-state', 'needs')
  await expect(rail.locator('.thread-nav__ring')).toHaveAttribute('data-waiting', waiting)
  await page.screenshot({ path: `artifacts/sidebar-question/${capture}-rail.png`, animations: 'disabled' })
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
  await expect(row(page, title)).toBeVisible()
}

async function expectClear(page: Page, title: string): Promise<void> {
  const status = row(page, title).locator('.thread-nav__status')
  await expect(status).not.toHaveAttribute('data-state', 'needs')
  await expect(status).not.toHaveAttribute('data-waiting')
  await expect(status).not.toHaveText(/Needs your/u)
}

let launched: LaunchedSotto | undefined
test.afterEach(async () => { if (launched) await closeSotto(launched); launched = undefined })

test('shows a question on a thread you run in its sidebar row until you answer it, with the voice coordinator off', async () => {
  test.setTimeout(120_000)
  launched = await launchSotto()
  const { page, app } = launched
  await prepare(page, 'dark')
  await resize(app, page, 1280, 800)
  await open(page, 'Docs')
  await emit(page, 'workshop', question)
  await expect.poll(() => pending(page, 'workshop')).toEqual([question.id])
  // The cause of the report: nothing about this thread is in the attention queue.
  expect((await state(page)).queue.filter(item => item.threadId === 'workshop')).toEqual([])
  await expectWaiting(page, 'Workshop', 'question', 'Needs your answer', 'question-1280x800-dark')

  await open(page, 'Workshop')
  const form = page.locator('.thread-workspace__compose .thread-questions .agent-request')
  await form.getByRole('radio', { name: /The weekly report/u }).click()
  await form.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect(form).toHaveCount(0)
  await expect.poll(() => pending(page, 'workshop')).toEqual([])
  await expectClear(page, 'Workshop')
  await page.screenshot({ path: 'artifacts/sidebar-question/question-answered-1280x800-dark.png', animations: 'disabled' })
})

test('shows a permission the same way with the voice coordinator on, at the minimum window in light', async () => {
  test.setTimeout(120_000)
  launched = await launchSottoWithVoice()
  const { page, app } = launched
  await prepare(page, 'light')
  await resize(app, page, 820, 560)
  await open(page, 'Docs')
  await emit(page, 'workshop', permission)
  await expect.poll(() => pending(page, 'workshop')).toEqual([permission.id])
  await expectWaiting(page, 'Workshop', 'approval', 'Needs your approval', 'permission-820x560-light')

  await open(page, 'Workshop')
  const approval = page.locator('.agent-request[data-kind="permission"]')
  await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect(approval).toHaveCount(0)
  await expect.poll(() => pending(page, 'workshop')).toEqual([])
  await expectClear(page, 'Workshop')
})
