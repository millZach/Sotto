import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { AgentCommand, AgentState } from '../../src/shared/agents'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { agentState } from './support/agentAccess'
import { closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'
import { textContrast } from './support/textContrast'
import { evidenceDirectory } from '../fixtures/evidence'

// Desktop notifications (ADR-0112): Sotto tells the user when a thread needs them or has finished everything, while the
// window does not show it. The app is real end to end; only the system notification is a stand-in (fakeNotification),
// which records each one shown on `globalThis.sottoNotifications` and can be pressed as the user would.
test.skip(process.platform !== 'darwin', 'Notifications are macOS only (ADR-0112).')

const evidence = evidenceDirectory('artifacts/desktop-notifications')
const HELP_LINE = 'If nothing appears, allow Sotto in System Settings → Notifications.'
const TEST_SENT = 'Sent. If you did not see it, allow Sotto in System Settings → Notifications.'

type Shown = { readonly id: string; readonly groupId: string; readonly title: string; readonly body: string }
type AgentEvent = Parameters<NonNullable<SottoE2EBridge['agentEvent']>>[0]

/** Every notification the stand-in has shown, oldest first. */
const shown = (app: ElectronApplication): Promise<Shown[]> => app.evaluate(() =>
  ((globalThis as { sottoNotifications?: { options: Shown }[] }).sottoNotifications ?? []).map(item => item.options))

/** The user pressing the newest notification. */
const pressNewest = (app: ElectronApplication): Promise<void> => app.evaluate(() => {
  (globalThis as unknown as { sottoNotifications: { press(): void }[] }).sottoNotifications.at(-1)!.press()
})

const command = (page: Page, input: AgentCommand): Promise<AgentState> =>
  page.evaluate(async input => window.sotto!.agents!.command(input) as unknown as Promise<AgentState>, input)
const agentEvent = (page: Page, event: AgentEvent): Promise<void> => page.evaluate(async event => window.sottoE2E!.agentEvent!(event), event)
const settings = (page: Page) => page.evaluate(async () => window.sotto!.getSettings())

/** Opens Settings → Application, where the Notifications group lives, and returns the group. */
async function notificationsGroup(page: Page): Promise<Locator> {
  const sections = page.getByRole('tablist', { name: 'Settings sections' })
  if (!(await sections.isVisible())) await openPage(page, 'Settings')
  await sections.getByRole('tab', { name: 'Application', exact: true }).click()
  const group = page.getByRole('region', { name: 'Notifications', exact: true })
  await expect(group).toBeVisible()
  return group
}

async function resize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [width, height]) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.setContentSize(width, height)
  }, [width, height] as const)
  await expect.poll(() => page.evaluate(([width, height]) => window.innerWidth === width && Math.abs(window.innerHeight - height) <= 2, [width, height] as const)).toBe(true)
}

/** Asserts the stand-in shows nothing new for `ms`: a quiet period cannot be polled for, only sampled. */
async function staysQuiet(app: ElectronApplication, count: number, ms: number): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    expect(await shown(app)).toHaveLength(count)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  expect(await shown(app)).toHaveLength(count)
}

let launched: LaunchedSotto | undefined
test.afterEach(async () => { if (launched) await closeSotto(launched); launched = undefined })

async function start(): Promise<LaunchedSotto> {
  // An E2E run counts as stable, where the Owl list keeps the feature off, so the run turns it on as other specs do.
  const previous = process.env.SOTTO_OWL_FEATURES
  process.env.SOTTO_OWL_FEATURES = 'desktop-notifications=1'
  try { launched = await launchSotto() } finally { if (previous === undefined) delete process.env.SOTTO_OWL_FEATURES; else process.env.SOTTO_OWL_FEATURES = previous }
  await launched.page.evaluate(async () => window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' }))
  // First-run setup only gives way to the app on the next load.
  await launched.page.reload()
  return launched
}

test('Settings → Application → Notifications saves both switches, sends a test notification and reads well at every size', async () => {
  test.setTimeout(120_000)
  await mkdir(evidence, { recursive: true })
  const { page, app } = await start()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))

  let group = await notificationsGroup(page)
  const needsYou = () => group.getByRole('switch', { name: 'When a thread needs you', exact: true })
  const finished = () => group.getByRole('switch', { name: 'When a thread has finished everything', exact: true })
  await expect(needsYou()).toHaveAttribute('aria-checked', 'true')
  await expect(finished()).toHaveAttribute('aria-checked', 'true')
  await expect(group.getByText(HELP_LINE, { exact: true })).toBeVisible()

  // Each switch saves on its own, and the saved choice is what the window shows after a reload.
  await needsYou().click()
  await expect.poll(async () => (await settings(page)).notifyNeedsYou).toBe(false)
  await finished().click()
  await expect.poll(async () => (await settings(page)).notifyFinished).toBe(false)
  await page.reload()
  group = await notificationsGroup(page)
  await expect(needsYou()).toHaveAttribute('aria-checked', 'false')
  await expect(finished()).toHaveAttribute('aria-checked', 'false')
  await needsYou().click()
  await finished().click()
  await expect.poll(async () => { const current = await settings(page); return [current.notifyNeedsYou, current.notifyFinished] }).toEqual([true, true])

  await group.getByRole('button', { name: 'Send a test notification', exact: true }).click()
  await expect(group.getByRole('status')).toHaveText(TEST_SENT)
  expect(await shown(app)).toEqual([{ id: 'test/1', groupId: 'test', title: 'Sotto', body: 'Notifications are on.' }])

  for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
    await resize(app, page, width, height)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
      await group.scrollIntoViewIfNeeded()
      await expect(group).toBeInViewport()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${width} ${appearance} page`).toBeLessThanOrEqual(0)
      expect(await group.evaluate(element => element.scrollWidth - element.clientWidth), `${width} ${appearance} group`).toBeLessThanOrEqual(1)
      for (const { text, ratio } of await textContrast(group, 'h3, strong, .tt-field__description, p:not(:empty), button:not([role=switch])')) {
        expect(ratio, `${text} at ${width} ${appearance}`).toBeGreaterThanOrEqual(4.5)
      }
      await page.mouse.move(1, 1)
      await page.screenshot({ path: join(evidence, `notifications-${appearance}-${width}x${height}.png`), animations: 'disabled', caret: 'hide' })
    }
  }
  expect(errors).toEqual([])
})

test('a thread that needs you or has finished everything is told while the window does not show it, and a press opens it', async () => {
  test.setTimeout(180_000)
  const { page, app, userData } = await start()
  await page.evaluate(async () => {
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, defaultModelId: 'claude:test' } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  const folder = join(userData, 'notes-project')
  await mkdir(folder, { recursive: true })
  let state = await command(page, { type: 'create-project', title: 'Notes', path: folder, useExisting: true })
  expect(state.error).toBeNull()
  const projectId = state.host.projects.find(item => item.title === 'Notes')!.id
  // Two threads: the one that asks keeps its question open, which would hold the other's finish back.
  const threads: Record<'asks' | 'finishes', { id: string; title: string }> = {
    asks: { id: '', title: 'Plan the release notes' },
    finishes: { id: '', title: 'Tidy the changelog' },
  }
  for (const thread of Object.values(threads)) {
    state = await command(page, { type: 'create-thread', title: thread.title, projectId, modelId: 'claude:test' })
    expect(state.error).toBeNull()
    thread.id = state.host.threads.find(item => item.title === thread.title)!.id
    // The provider's session starts with the first send (ADR-0057).
    state = await command(page, { type: 'manual-send', threadId: thread.id, text: `${thread.title}, please.` })
    expect(state.error).toBeNull()
  }
  // The first message can name the thread, so the title a notification should carry is the one the state holds now.
  state = await agentState(page)
  for (const thread of Object.values(threads)) thread.title = state.host.threads.find(item => item.id === thread.id)!.title
  // The words name the thread's provider; the E2E host's threads name none, so they read "The agent".
  expect(state.host.threads.find(item => item.id === threads.asks.id)!.providerId).toBeUndefined()
  const agent = 'The agent'

  // Settings shows no thread, so nothing on screen answers for them.
  await notificationsGroup(page)
  const before = (await shown(app)).length

  // Needs you: one notification, the thread's title and the agent's plain sentence, never the question itself.
  await agentEvent(page, { type: 'question', threadId: threads.asks.id, requestId: 'audience', text: 'Who reads the release notes?', status: 'running' })
  await expect.poll(async () => (await shown(app)).slice(before)).toEqual([
    { id: `${threads.asks.id}/request/audience`, groupId: threads.asks.id, title: threads.asks.title, body: `${agent} is asking a question.` },
  ])
  expect(JSON.stringify((await shown(app)).slice(before))).not.toContain('release notes?')

  // A press brings the thread up on Threads, selected.
  await pressNewest(app)
  await expect(page.locator('.threads-view')).toBeVisible()
  await expect.poll(async () => (await agentState(page)).activeThreadId).toBe(threads.asks.id)
  await expect(page.getByText(threads.asks.title, { exact: true }).first()).toBeVisible()

  await notificationsGroup(page)
  await agentEvent(page, { type: 'permission', threadId: threads.asks.id, requestId: 'delete-draft', text: 'Delete the old draft?', status: 'running' })
  await expect.poll(async () => (await shown(app)).slice(before + 1).map(item => item.body)).toEqual([`${agent} is asking for permission.`])

  // Finished: the host marks the finish at once, but Sotto waits ALERT_SETTLE_MS in case more work follows.
  const finish = async (): Promise<void> => {
    await agentEvent(page, { type: 'ready', threadId: threads.finishes.id, status: 'running', text: '' })
    await agentEvent(page, { type: 'ready', threadId: threads.finishes.id, status: 'idle', text: 'Done.' })
    await expect.poll(async () => (await agentState(page)).host.threads.find(item => item.id === threads.finishes.id)?.finishedUnread, { message: 'the host marks the finish' }).toBe(true)
  }
  let count = before + 2
  await finish()
  await staysQuiet(app, count, 1_500)
  // A finished id carries a per-run token, so the system never merges two runs' notifications.
  const escaped = threads.finishes.id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  await expect.poll(async () => (await shown(app)).slice(count), { timeout: 8_000 }).toEqual([
    { id: expect.stringMatching(new RegExp(`^${escaped}/finished/[0-9a-f]{8}-1$`, 'u')), groupId: threads.finishes.id, title: threads.finishes.title, body: `${agent} finished.` },
  ])
  count += 1

  // With the switch off a finish is told to no one, and turning it back on does not replay it.
  const group = await notificationsGroup(page)
  const finishedSwitch = group.getByRole('switch', { name: 'When a thread has finished everything', exact: true })
  await finishedSwitch.click()
  await expect.poll(async () => (await settings(page)).notifyFinished).toBe(false)
  await finish()
  await staysQuiet(app, count, 8_000)
  await finishedSwitch.click()
  await expect.poll(async () => (await settings(page)).notifyFinished).toBe(true)
  await staysQuiet(app, count, 4_000)
  // The pipeline still works with the switch on again: the next finish is told, and only that one.
  await finish()
  await expect.poll(async () => (await shown(app)).slice(count).map(item => item.body), { timeout: 8_000 }).toEqual([`${agent} finished.`])
  await staysQuiet(app, count + 1, 1_500)
})
