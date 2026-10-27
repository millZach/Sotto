import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentMessage } from '../../src/shared/agents'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import { evidenceDirectory } from '../fixtures/evidence'
import { agentState } from './support/agentAccess'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

// Needs you in the Threads sidebar (ADR-0135), on Owl: the threads that need the user stand under the search across
// projects, and a short approval and an unseen failure settle there through the same answer and dismissal their
// panes use. Only the provider's effects come from the unpackaged E2E host.

const evidence = evidenceDirectory('artifacts/needs-you-queue')
const at = (minute: number): string => new Date(Date.UTC(2026, 9, 19, 9, minute)).toISOString()
const messages = (prefix: string, prompt: string, reply: string): AgentMessage[] => [
  { id: `${prefix}-1`, role: 'user', text: prompt, createdAt: at(1) },
  { id: `${prefix}-2`, role: 'assistant', text: reply, createdAt: at(4) },
]
const failedTurn = (prefix: string): AgentActivity => ({ id: `claude-turn-${prefix}-1`, turnId: `${prefix}-1`, sequence: 0, kind: 'turn', status: 'failed',
  title: 'Turn failed', startedAt: at(1), completedAt: at(5), timingSource: 'observed', afterMessageId: `${prefix}-1` })

async function launchOn(): Promise<LaunchedSotto> {
  const previous = process.env['SOTTO_OWL_FEATURES']
  process.env['SOTTO_OWL_FEATURES'] = 'needs-you-queue=1'
  try { return await launchSotto() } finally { if (previous === undefined) delete process.env['SOTTO_OWL_FEATURES']; else process.env['SOTTO_OWL_FEATURES'] = previous }
}
async function prepare(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await page.reload()
  await openThreads(page)
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
async function report(page: Page, threadId: string, history: AgentMessage[], activities: AgentActivity[]): Promise<void> {
  await page.evaluate(async ([threadId, history, activities]) => window.sottoE2E!.agentEvent!({ type: 'history', threadId, text: '', messages: history, activities, status: 'error' }),
    [threadId, history, activities] as const)
}
const sidebar = (page: Page): Locator => page.getByRole('complementary', { name: 'Thread sidebar' })
const queue = (page: Page): Locator => sidebar(page).locator('.needs-you')

let launched: LaunchedSotto | undefined
test.afterEach(async () => { if (launched) await closeSotto(launched); launched = undefined })

test('the queue gathers what needs you and settles a short approval and a failure in place', async () => {
  test.setTimeout(240_000)
  launched = await launchOn()
  const { page, app } = launched
  await prepare(page)
  await resize(app, page, 1280, 800)
  await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'permission', threadId: 'workshop', requestId: 'queue-permission', text: 'Run the build?', status: 'running' }))
  await report(page, 'docs', messages('docs-queue', 'Tidy the docs index', 'Reordering the index now.'), [failedTurn('docs-queue')])

  await expect(queue(page)).toBeVisible()
  await expect(queue(page).getByRole('heading', { name: 'Needs you', exact: true })).toBeVisible()
  await expect(queue(page).getByRole('button', { name: 'Allow in Workshop', exact: true })).toBeVisible()
  await expect(queue(page).getByRole('button', { name: 'Dismiss Needs attention on Tidy the docs index', exact: true })).toBeVisible()
  expect(sidebar(page).locator('.thread-nav__indicators')).toHaveCount(0)
  expect(sidebar(page).locator('.thread-nav__attention')).toHaveCount(0)
  // The host stamped both waits, so the queue may say them (ADR-0135).
  const standing = await agentState(page)
  const workshop = standing.host.threads.find(thread => thread.id === hostEntityKey(standing.hostId, 'workshop'))!
  expect(workshop.requests[0]?.since).toBeDefined()
  expect(Number.isFinite(Date.parse(workshop.requests[0]!.since!))).toBe(true)
  expect(standing.host.threads.find(thread => thread.id === hostEntityKey(standing.hostId, 'docs'))?.failureSince).toBeDefined()

  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
    await resize(app, page, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await theme(page, appearance)
      await expect(queue(page)).toBeVisible()
      expect(await queue(page).evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      await page.screenshot({ path: join(evidence, `queue-${width}x${height}-${appearance}.png`), animations: 'disabled' })
    }
  }
  await resize(app, page, 1280, 800)
  await theme(page, 'dark')

  await queue(page).getByRole('button', { name: 'Allow in Workshop', exact: true }).click()
  await expect.poll(async () => (await agentState(page)).host.threads.find(thread => thread.title === 'Workshop')?.requests.length).toBe(0)
  await expect(queue(page).getByRole('button', { name: 'Allow in Workshop', exact: true })).toHaveCount(0)

  await queue(page).getByRole('button', { name: 'Dismiss Needs attention on Tidy the docs index', exact: true }).click()
  await expect.poll(async () => (await agentState(page)).host.threads.find(thread => thread.title === 'Tidy the docs index')?.failureSeen).toBe(true)
  await expect(queue(page)).toHaveCount(0)
})

test('with the Owl feature off there is no queue and the dots stand', async () => {
  test.setTimeout(240_000)
  launched = await launchSotto()
  const { page } = launched
  await prepare(page)
  await page.evaluate(async () => window.sottoE2E!.agentEvent!({ type: 'permission', threadId: 'workshop', requestId: 'off-permission', text: 'Run the build?', status: 'running' }))
  await expect(sidebar(page).getByRole('button', { name: 'Workshop', exact: true })).toBeVisible()
  expect(queue(page)).toHaveCount(0)
  // The dots speak for a closed folder; this page opens its project, so close it and hear them.
  await sidebar(page).getByRole('button', { name: 'Sotto test 2 threads', exact: true }).click()
  await expect(sidebar(page).locator('.thread-nav__indicators').first()).toBeVisible()
})
