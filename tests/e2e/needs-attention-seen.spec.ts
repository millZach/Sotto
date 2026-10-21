import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentMessage } from '../../src/shared/agents'
import { evidenceDirectory } from '../fixtures/evidence'
import { agentState } from './support/agentAccess'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

// A failed turn is attention until a client shows it (ADR-0092). The app is real end to end; only the provider's effects
// come from the unpackaged E2E host. A failed row says Needs attention, opening it makes it Done while its pane still says
// why the turn failed, and Dismiss all under the search marks every unseen failure seen without opening each.

const evidence = evidenceDirectory('artifacts/needs-attention-seen')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const THEMES = ['dark', 'light'] as const
/** The thread's first message, which the fixture names the thread after. */
const TITLE = 'Rename the settings keys'
const REASON = 'Claude returned an error: the API was overloaded. Nothing in the transcript was lost. Send a message to try again.'

const at = (minute: number): string => new Date(Date.UTC(2026, 9, 19, 9, minute)).toISOString()
const messages = (prefix: string, prompt: string, reply: string): AgentMessage[] => [
  { id: `${prefix}-1`, role: 'user', text: prompt, createdAt: at(1) },
  { id: `${prefix}-2`, role: 'assistant', text: reply, createdAt: at(4) },
]
const failedTurn = (prefix: string, error?: string): AgentActivity => ({ id: `claude-turn-${prefix}-1`, turnId: `${prefix}-1`, sequence: 0, kind: 'turn', status: 'failed',
  title: 'Turn failed', startedAt: at(1), completedAt: at(5), timingSource: 'observed', afterMessageId: `${prefix}-1`, ...(error ? { error } : {}) })

async function prepare(page: Page, appearance: 'dark' | 'light'): Promise<void> {
  await page.evaluate(async appearance => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance, reducedMotion: 'on' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
    await window.sotto!.agents!.command({ type: 'connect' })
  }, appearance)
  await page.reload()
  await openThreads(page)
}
/**
 * The window's panes show their threads only while it has the focus (ADR-0046), and a Playwright window starts without
 * it, so a journey about opening a thread gives the window the focus first and checks that it took.
 */
async function focusWindow(app: ElectronApplication): Promise<void> {
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
    if (!main.isFocused()) { main.show(); main.focus() }
    return main.isFocused()
  })).toBe(true)
}
async function resize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [width, height]) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => page.evaluate(([width, height]) => window.innerWidth === width && Math.abs(window.innerHeight - height) <= 2, [width, height] as const)).toBe(true)
}
async function theme(page: Page, appearance: 'dark' | 'light'): Promise<void> {
  await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, appearance)
  await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
}
/** The provider reports the thread's history and where it stands: a running turn, or one that failed. */
async function report(page: Page, threadId: string, status: 'running' | 'error', history: AgentMessage[], activities: AgentActivity[] = []): Promise<void> {
  await page.evaluate(async ([threadId, status, history, activities]) => window.sottoE2E!.agentEvent!({ type: 'history', threadId, text: '', messages: history, activities, status }),
    [threadId, status, history, activities] as const)
}
const sidebar = (page: Page): Locator => page.getByRole('complementary', { name: 'Thread sidebar' })
const row = (page: Page, title: string): Locator => sidebar(page).getByRole('button', { name: title, exact: true })
const status = (page: Page, title: string): Locator => row(page, title).locator('.thread-nav__status')
const line = (page: Page): Locator => sidebar(page).locator('.thread-nav__attention')
async function open(page: Page, title: string): Promise<void> {
  await row(page, title).click()
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
}
/** The line keeps one row and clips nothing, whatever the window's size. */
async function expectWhole(locator: Locator): Promise<void> {
  expect(await locator.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  expect(await locator.locator('.thread-nav__attention-dismiss').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
}
async function captureAll(app: ElectronApplication, page: Page, name: string, check: () => Promise<void>): Promise<void> {
  for (const [width, height] of SIZES) {
    await resize(app, page, width, height)
    for (const appearance of THEMES) {
      await theme(page, appearance)
      await check()
      await page.screenshot({ path: join(evidence, `${name}-${width}x${height}-${appearance}.png`), animations: 'disabled' })
    }
  }
}

let launched: LaunchedSotto | undefined
test.afterEach(async () => { if (launched) await closeSotto(launched); launched = undefined })

test('a failed row says Needs attention until it is opened, then Done, and the pane still says why', async () => {
  test.setTimeout(240_000)
  launched = await launchSotto()
  const { page, app } = launched
  await prepare(page, 'dark')
  await resize(app, page, 1280, 800)
  await open(page, 'Docs')
  await report(page, 'workshop', 'error', messages('wk', TITLE, 'Renaming the keys now. The settings test is next.'), [failedTurn('wk', REASON)])
  await expect(status(page, TITLE)).toHaveText('Claude, Needs attention')
  await expect(line(page)).toHaveText('1 needs attention' + 'Dismiss all')
  await expect(line(page).getByRole('button', { name: 'Dismiss Needs attention on 1 thread', exact: true })).toBeVisible()
  await captureAll(app, page, 'failed-row', async () => {
    await expect(status(page, TITLE)).toHaveAttribute('data-state', 'needs')
    await expectWhole(line(page))
  })

  await resize(app, page, 1280, 800)
  await focusWindow(app)
  await open(page, TITLE)
  await expect(status(page, TITLE)).toHaveText('Claude, Done')
  await expect(line(page)).toHaveCount(0)
  // The reason is said once: on the failed turn's line, not again in a banner or a notice.
  await expect(page.getByText(REASON, { exact: true })).toHaveCount(1)
  await expect(page.locator('.thread-failed-notice')).toHaveCount(0)
  await captureAll(app, page, 'opened', async () => {
    await expect(page.getByText(REASON, { exact: true })).toBeVisible()
  })
  await resize(app, page, 1280, 800)
  // Seen is the host's record, so it holds when the thread is opened again later.
  await open(page, 'Docs')
  await open(page, TITLE)
  await expect(status(page, TITLE)).toHaveText('Claude, Done')
  await expect(page.getByText(REASON, { exact: true })).toHaveCount(1)
  const snapshot = await agentState(page)
  expect(snapshot.host.threads.find(thread => thread.title === TITLE)?.failureSeen).toBe(true)

  // A failure with no reason on record is explained above the composer instead.
  const retried = [...messages('wk', TITLE, 'Renaming the keys now. The settings test is next.'), ...messages('wk2', 'Carry on with the settings test.', 'Running the settings test.')]
  await report(page, 'workshop', 'running', retried, [failedTurn('wk', REASON)])
  await report(page, 'workshop', 'error', retried, [failedTurn('wk', REASON), failedTurn('wk2')])
  const notice = page.locator('.thread-failed-notice')
  await expect(notice).toHaveText('The last turn failed. Nothing in the transcript was lost. Send a message to try again.')
  await expect(status(page, TITLE)).toHaveText('Claude, Done')
  for (const appearance of THEMES) {
    await theme(page, appearance)
    await page.screenshot({ path: join(evidence, `notice-1280x800-${appearance}.png`), animations: 'disabled' })
  }
})

test('Dismiss all marks every unseen failure seen without opening it, from the keyboard', async () => {
  test.setTimeout(240_000)
  launched = await launchSotto()
  const { page, app } = launched
  await prepare(page, 'dark')
  await resize(app, page, 1280, 800)
  await open(page, 'Docs')
  // A permission waiting on Docs is the user's to answer: it is never counted or dismissed.
  await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'permission', threadId: 'docs', text: 'Run the build', status: 'running',
    request: { id: 'run-build', kind: 'permission', text: 'Run the build', options: [] } }))
  await report(page, 'workshop', 'error', messages('wk', TITLE, 'Renaming the keys now.'), [failedTurn('wk', REASON)])
  await expect(status(page, TITLE)).toHaveText('Claude, Needs attention')
  await expect(status(page, 'Docs')).toHaveText('Claude, Needs your approval')
  await expect(line(page)).toContainText('1 needs attention')
  await captureAll(app, page, 'count-line', async () => { await expectWhole(line(page)) })

  await resize(app, page, 1280, 800)
  await theme(page, 'dark')
  // Search, then Dismiss all: the line is the next stop after the search field.
  const search = sidebar(page).getByRole('searchbox', { name: 'Search threads' })
  await search.focus()
  await page.keyboard.press('Tab')
  const dismiss = line(page).getByRole('button', { name: 'Dismiss Needs attention on 1 thread', exact: true })
  await expect(dismiss).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(line(page)).toHaveCount(0)
  await expect(search).toBeFocused()
  await expect(status(page, TITLE)).toHaveText('Claude, Done')
  await expect(status(page, 'Docs')).toHaveText('Claude, Needs your approval')
  for (const appearance of THEMES) {
    await theme(page, appearance)
    await page.screenshot({ path: join(evidence, `dismissed-1280x800-${appearance}.png`), animations: 'disabled' })
  }

  // The thread's next failure is news again.
  await report(page, 'workshop', 'running', messages('wk', TITLE, 'Renaming the keys now.'))
  await expect(status(page, TITLE)).toHaveText(/Claude, Working/u)
  await report(page, 'workshop', 'error', messages('wk', TITLE, 'Renaming the keys now.'), [failedTurn('wk', REASON)])
  await expect(status(page, TITLE)).toHaveText('Claude, Needs attention')
  await expect(line(page)).toContainText('1 needs attention')
})
