import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { SottoE2EBridge } from '../../src/shared/e2e'
import { bareEntityId, closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'

// Babysitting a pull request, variant C of ADR-0061 (#825), over the built app, the scripted provider and a scripted gh
// (tests/fixtures/fakeGh.mjs) that answers babysitting's reads: Babysit pull request from the Pull request surface's ···
// menu by keyboard, the line docked above Merge, the sidebar's Babysitting #74 and the creature's pose, a check failing
// on GitHub bringing a wake-up into the thread as Sotto's, a later one waiting in the follow-up queue and removed there,
// Stop, and a merge ending babysitting with the line saying why. The Settings switch closes it. A babysitting pass runs
// when the journey asks (src/main/e2e/babysitPass.ts) rather than on its two-minute timer.
const SHOTS = process.env.SOTTO_E2E_CAPTURES ?? resolve('artifacts/babysitting-surfaces-run')
const REPOSITORY = 'https://github.com/sotto-fixture/owned'
const URL = `${REPOSITORY}/pull/74`

type Check = { __typename: 'CheckRun'; name: string; workflowName: string; status: string; conclusion: string | null; detailsUrl: string }
interface GhState { calls: string[]; pulls: Array<Record<string, unknown> & { number: number; state: string; checks: Check[] }> }
const check = (name: string, status: string, conclusion: string | null): Check =>
  ({ __typename: 'CheckRun', name, workflowName: 'CI', status, conclusion, detailsUrl: `${REPOSITORY}/actions/runs/4182/job/${name === 'Lint' ? 9922 : 9921}` })

async function resize(launched: LaunchedSotto, width: number, height: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
    window.setMinimumSize(800, 540)
    window.setContentSize(size.width, size.height)
  }, { width, height })
  await expect.poll(() => launched.page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe(`${width}x${height}`)
}
/** The whole window, or only the part `subject` names, so each capture shows its own state. */
async function capture(page: Page, name: string, subject?: Locator): Promise<void> {
  await mkdir(SHOTS, { recursive: true })
  const path = join(SHOTS, `${name}.png`)
  if (subject) await subject.screenshot({ path, animations: 'disabled' })
  else await page.screenshot({ path, animations: 'disabled' })
}
/**
 * Where the pose's "since" sits in its readout: whole on its line, dropped whole below it, or cut short. `since`, when
 * given, stands in for the time the host stamped while it is measured, so the widest times are measured too.
 */
async function sinceFits(pose: Locator, since?: string): Promise<'whole' | 'dropped' | 'cut' | 'absent'> {
  return pose.locator('.thread-monitor__status').evaluate((status, replacement) => {
    const node = status.querySelector('.thread-monitor__since')?.firstChild
    if (!node) return 'absent'
    const before = node.nodeValue
    if (replacement) node.nodeValue = replacement
    const box = status.getBoundingClientRect(), part = node.parentElement!.getBoundingClientRect()
    const fit = part.top >= box.bottom - 0.5 ? 'dropped' : part.right <= box.right + 0.5 && part.bottom <= box.bottom + 0.5 ? 'whole' : 'cut'
    node.nodeValue = before
    return fit
  }, since)
}
/**
 * The pose and a follow-up queue above the composer at once: the queue whole above the pose, neither over the other,
 * the pose's readout inside its width, and the queue's Resume queue in view.
 */
async function expectPoseClearOfQueue(page: Page, pose: Locator, queue: Locator): Promise<void> {
  const [poseBox, queueBox, paneBox] = [(await pose.boundingBox())!, (await queue.boundingBox())!, (await pane(page).boundingBox())!]
  expect(poseBox.y, 'the pose starts below the queue').toBeGreaterThanOrEqual(queueBox.y + queueBox.height - 0.5)
  expect(queueBox.y, 'the queue starts inside the pane').toBeGreaterThanOrEqual(paneBox.y)
  expect(poseBox.x + poseBox.width, 'the pose stays inside the pane').toBeLessThanOrEqual(paneBox.x + paneBox.width + 0.5)
  expect(await pose.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'the pose readout fits its width').toBe(true)
  expect(await pose.locator('.thread-monitor__label').evaluate(element => element.getBoundingClientRect().height > 0)).toBe(true)
  await expect(queue.getByRole('button', { name: 'Resume queue', exact: true })).toBeInViewport()
}
/** The widest times the pose says: today's, and an earlier day's. */
const WIDEST_TODAY = ' since 12:55 pm', WIDEST_EARLIER = ' since Oct 17, 12:55 pm'
async function theme(page: Page, appearance: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: appearance })
  await page.evaluate(async value => { await window.sotto!.updateSettings({ appearance: value }) }, appearance)
  await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
}
const pane = (page: Page) => page.locator('section.thread-pane[data-focused]')
const event = (page: Page, value: Parameters<NonNullable<SottoE2EBridge['agentEvent']>>[0]) =>
  page.evaluate(async item => { await (globalThis as unknown as { sottoE2E: SottoE2EBridge }).sottoE2E.agentEvent!(item) }, value)

/**
 * A text's contrast with what it sits on: its colour over the backgrounds of every element under it, composited from the
 * window up, so a wash of the accent counts with the panel beneath it.
 */
async function contrast(target: Locator): Promise<number> {
  return target.evaluate(element => {
    const context = document.createElement('canvas').getContext('2d')!
    const layers: string[] = []
    for (let node: Element | null = element; node; node = node.parentElement) {
      const fill = getComputedStyle(node).backgroundColor
      if (fill && fill !== 'transparent' && fill !== 'rgba(0, 0, 0, 0)') layers.unshift(fill)
    }
    const paint = (fills: string[]): number[] => {
      context.globalCompositeOperation = 'source-over'
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = getComputedStyle(document.documentElement).backgroundColor || '#000'
      context.fillRect(0, 0, 1, 1)
      for (const fill of fills) { context.fillStyle = fill; context.fillRect(0, 0, 1, 1) }
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
    }
    const luminance = (channels: number[]): number => {
      const [r, g, b] = channels.map(value => { const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4 })
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    const under = luminance(paint(layers)), text = luminance(paint([...layers, getComputedStyle(element).color]))
    return (Math.max(under, text) + 0.05) / (Math.min(under, text) + 0.05)
  })
}
async function expectReadable(targets: Record<string, Locator>): Promise<void> {
  for (const [name, target] of Object.entries(targets)) expect(await contrast(target), name).toBeGreaterThanOrEqual(4.5)
}

test('a thread babysits its pull request from the surface, gets a wake-up as Sotto’s, and stops', async () => {
  test.setTimeout(240_000)
  const directory = await mkdtemp(join(tmpdir(), 'sotto-e2e-babysitting-'))
  const ghState = join(directory, 'gh-state.json')
  const readState = async (): Promise<GhState> => JSON.parse(await readFile(ghState, 'utf8')) as GhState
  const changeState = async (change: (state: GhState) => void): Promise<void> => { const state = await readState(); change(state); await writeFile(ghState, JSON.stringify(state)) }
  await writeFile(ghState, JSON.stringify({ calls: [], pulls: [{ number: 74, title: 'Greet the reviewer', url: URL, state: 'OPEN', isDraft: false, baseRefName: 'main',
    headRefName: 'feat/greeting', head: '9f3c2ab', body: 'Says hello to whoever reviews this.', reviewDecision: 'REVIEW_REQUIRED',
    checks: [check('Owned build', 'IN_PROGRESS', null)] }] } satisfies GhState))
  const previous = { script: process.env.SOTTO_E2E_GH_SCRIPT, executable: process.env.SOTTO_E2E_GH_EXECUTABLE, state: process.env.FAKE_GH_STATE }
  process.env.SOTTO_E2E_GH_SCRIPT = resolve('tests/fixtures/fakeGh.mjs')
  process.env.SOTTO_E2E_GH_EXECUTABLE = process.execPath
  process.env.FAKE_GH_STATE = ghState
  let launched: LaunchedSotto | undefined
  try {
    launched = await launchSotto()
    const { page, app } = launched
    const pass = () => app.evaluate(async () => {
      if (!globalThis.sottoBabysitE2E) throw new Error('The unpackaged babysitting harness is unavailable.')
      await globalThis.sottoBabysitE2E.pass()
    })
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
      const agents = window.sotto!.agents!
      await agents.command({ type: 'configure', patch: { enabled: true } })
      await agents.command({ type: 'connect' })
    })
    await page.reload()
    await openThreads(page)
    await resize(launched, 1280, 800)
    await theme(page, 'dark')

    // The thread opened the pull request in an earlier turn, and it is linked to the thread.
    await event(page, { type: 'manual', threadId: 'workshop', text: 'Add a greeting for reviewers, open a pull request and see it through CI.' })
    await event(page, { type: 'ready', threadId: 'workshop', text: 'Added a greeting for reviewers in `src/greeting.ts` with a test, and opened #74 Greet the reviewer. CI is running.' })
    const threadId = await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => /(^|:)workshop$/u.test(thread.id))!.id)
    expect(bareEntityId(threadId)).toBe('workshop')
    await page.evaluate(async ({ id, url }) => {
      const agents = window.sotto!.agents!
      await agents.command({ type: 'rename-thread', threadId: id, title: 'Greeting for reviewers' })
      await agents.command({ type: 'git-link-pull-request', threadId: id, reference: url })
    }, { id: threadId, url: URL })

    const row = page.getByRole('button', { name: 'Greeting for reviewers', exact: true })
    const status = row.locator('.thread-nav__status')
    await row.click()
    await expect(status).toHaveText(/(Done|Just finished)$/u)
    await page.getByRole('button', { name: 'Tools', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    await panel.getByRole('tab', { name: 'Pull request', exact: true }).click()
    await expect(panel.getByRole('heading', { name: '#74 Greet the reviewer' })).toBeVisible({ timeout: 30_000 })
    await expect(panel.getByRole('list', { name: 'Merge checklist' })).toContainText('CI / Owned build is still running')

    // Babysit pull request is in ···, after the merge items; the menu answers Escape and is driven from the keyboard.
    const more = panel.getByRole('button', { name: 'More pull request actions' })
    const menuItem = page.getByRole('menuitem', { name: 'Babysit pull request' })
    await more.focus()
    await page.keyboard.press('Enter')
    await expect(menuItem).toBeVisible()
    expect(await page.getByRole('menuitem').allTextContents()).toEqual(['Convert to draft', 'Merge when ready (auto-merge)', 'Babysit pull request', 'Copy link', 'Link pull request', 'Unlink from thread', 'Close pull request'])
    await capture(page, 'c-menu-item-1280x800-dark')
    await page.keyboard.press('Escape')
    await expect(menuItem).toHaveCount(0)
    await expect(more).toBeFocused()
    await page.keyboard.press('Enter')
    for (let step = 0; step < 6 && !await menuItem.evaluate(item => item === document.activeElement); step++) await page.keyboard.press('ArrowDown')
    await expect(menuItem).toBeFocused()
    await page.keyboard.press('Enter')
    // The line coming says it started; the panel says so in passing, and nothing above the checklist holds it down.
    const passing = panel.locator('.tools-panel__status')
    await expect(passing).toHaveText('Babysitting #74', { timeout: 30_000 })
    await expect(panel.locator('.pr-surface__notice')).toHaveCount(0)

    // The line above Merge, the sidebar's state word and the creature's pose.
    const line = panel.getByRole('group', { name: /^Babysitting since \d/u })
    await expect(line).toContainText('Started by you. Sotto sends this thread a wake-up when #74 needs it.')
    const merge = panel.getByRole('button', { name: 'Merge #74', exact: true })
    expect((await line.boundingBox())!.y).toBeLessThan((await merge.boundingBox())!.y)
    await expect(status).toHaveText(/Babysitting #74$/u)
    const pose = pane(page).locator('.thread-monitor[data-ornament="babysitting"]')
    await expect(pose).toContainText('#74 Greet the reviewer')
    await expect(pose).toContainText(/Babysitting since \d/u)
    // The pose says the whole time beside Tools at 1280x800, the widest of today's too; an earlier day's drops whole.
    expect(await sinceFits(pose)).toBe('whole')
    expect(await sinceFits(pose, WIDEST_TODAY)).toBe('whole')
    expect(['whole', 'dropped']).toContain(await sinceFits(pose, WIDEST_EARLIER))
    await expect(pose).toHaveAttribute('role', 'img')
    await expect(pose).toHaveAccessibleName(/^Babysitting #74 Greet the reviewer since \d/u)
    await expect(pose).not.toHaveAttribute('aria-live')
    await expect(passing).toBeEmpty()
    await capture(page, 'c-babysitting-1280x800-dark')
    await capture(page, 'c-surface-line-1280x800-dark', panel)
    await capture(page, 'c-sidebar-1280x800-dark', page.locator('.thread-nav').first())
    // The collapsed rail names the thread's state as the row does, in the title it gives the thread.
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    const rail = page.locator('.thread-nav__rail-thread[aria-label="Greeting for reviewers"]')
    await expect(rail).toHaveAttribute('title', 'Greeting for reviewers · Babysitting #74')
    await capture(page, 'c-sidebar-collapsed-1280x800-dark')
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await expect(status).toHaveText(/Babysitting #74$/u)
    // The pose's hover title keeps the time, which its visible line drops whole where it does not fit.
    await expect(pose.locator('.thread-monitor__task')).toHaveAttribute('title', /^#74 Greet the reviewer\nBabysitting since \d/u)
    // Linked pull requests marks the one the thread babysits.
    const linkedFold = panel.getByRole('button', { name: /^Linked pull requests/u })
    await linkedFold.click()
    const linkedRow = panel.getByRole('list', { name: 'Linked pull requests' }).getByRole('button', { name: 'PR #74, Open: Greet the reviewer. Linked by you. Babysitting', exact: true })
    await linkedRow.scrollIntoViewIfNeeded()
    await expect(linkedRow.locator('.pr-surface__link-babysat')).toHaveText('Babysitting')
    await expectReadable({ 'linked mark': linkedRow.locator('.pr-surface__link-babysat') })
    await capture(page, 'c-linked-babysitting-1280x800-dark', panel)
    await linkedFold.click()
    // The pose stands above the composer, outside its box, so its capture is the pane from a little above the pose down.
    const [poseBox, paneBox] = [(await pose.boundingBox())!, (await pane(page).boundingBox())!]
    const top = Math.max(paneBox.y, poseBox.y - 96)
    await page.screenshot({ path: join(SHOTS, 'c-pose-1280x800-dark.png'), animations: 'disabled',
      clip: { x: paneBox.x, y: top, width: paneBox.width, height: paneBox.y + paneBox.height - top } })
    const readable = {
      'line title': line.locator('strong'), 'line words': line.locator('.pr-surface__babysit-text span'), stop: line.getByRole('button', { name: 'Stop babysitting #74' }),
      'row state': status, 'pose label': pose.locator('.thread-monitor__label'), 'pose state': pose.locator('.thread-monitor__status'),
    }
    await expectReadable(readable)
    await theme(page, 'light')
    await expectReadable(readable)
    await capture(page, 'c-babysitting-1280x800-light')
    await theme(page, 'dark')
    // Reduced motion: the pose was never moving, and stays.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(pose).toBeVisible()
    expect(await pose.locator('.thread-monitor__actor').getAttribute('style')).toBeNull()
    await page.emulateMedia({ reducedMotion: 'no-preference' })

    // The minimum window: nothing overflows, and the line keeps its words and its Stop.
    await resize(launched, 820, 560)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(line.getByRole('button', { name: 'Stop babysitting #74' })).toBeVisible()
    expect(await line.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    for (const since of [undefined, WIDEST_TODAY, WIDEST_EARLIER]) expect(['whole', 'dropped']).toContain(await sinceFits(pose, since))
    await capture(page, 'c-babysitting-820x560-dark')
    await resize(launched, 1600, 1000)
    expect(await sinceFits(pose, WIDEST_TODAY)).toBe('whole')
    await capture(page, 'c-babysitting-1600x1000-dark')
    await resize(launched, 1280, 800)

    // The first pass looks while the build is running: nothing to tell. The build then fails on GitHub: a wake-up.
    await pass()
    await changeState(state => { state.pulls[0]!.checks = [check('Owned build', 'COMPLETED', 'FAILURE')] })
    await pass()
    // Wake-ups the provider has, as against the echo of one still waiting in the queue.
    const sentWakeUps = pane(page).locator('.thread-message[data-from="sotto"]:not(.thread-message--pending)')
    const wakeUp = sentWakeUps.first()
    await expect(sentWakeUps).toHaveCount(1, { timeout: 30_000 })
    await expect(wakeUp.locator('header')).toContainText('SottoWake-up')
    await expect(wakeUp).toContainText('Sotto is babysitting a pull request for this thread, and it needs you.')
    await expect(wakeUp).toContainText(`Pull request #74 "Greet the reviewer": ${URL}`)
    await expect(wakeUp).toContainText('- Check CI / Owned build failed')
    await expect(wakeUp.getByRole('link', { name: URL, exact: true })).toBeVisible()
    // The provider is working on it: the row says so, and the pose steps aside while the turn runs.
    await expect(status).toHaveText(/Working$/u)
    await expect(pose).toHaveCount(0)
    // The surface reads GitHub when asked; Refresh shows the failure the wake-up told of.
    await panel.getByRole('button', { name: 'Refresh pull request', exact: true }).click()
    await expect(panel.getByRole('list', { name: 'Merge checklist' })).toContainText('CI / Owned build failed', { timeout: 30_000 })
    await wakeUp.scrollIntoViewIfNeeded()
    await expectReadable({ 'wake-up tag': wakeUp.locator('.thread-message__tag'), 'wake-up text': wakeUp.locator('.rich-message p').first() })
    await capture(page, 'c-wake-up-1280x800-dark')
    await event(page, { type: 'ready', threadId: 'workshop', text: 'Reading the failed build log with gh.' })
    // A turn that ends while the window is not in front earns Just finished, which outranks Babysitting (ADR-0046).
    await expect(status).toHaveText(/(Babysitting #74|Just finished)$/u)
    await expect(pose).toBeVisible()

    // A later failure while the thread is busy waits in the follow-up queue after the user's own, as Sotto's.
    await event(page, { type: 'manual', threadId: 'workshop', text: 'Also mention the greeting in the README.' })
    const prompt = pane(page).getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Then add a changelog entry.')
    await prompt.press('Enter')
    const queue = pane(page).getByRole('region', { name: 'Queued messages' })
    await expect(queue).toContainText('Then add a changelog entry.')
    await changeState(state => { state.pulls[0]!.checks = [check('Owned build', 'COMPLETED', 'FAILURE'), check('Lint', 'COMPLETED', 'FAILURE')] })
    await pass()
    const waiting = queue.locator('.thread-followup[data-wake-up]')
    await expect(waiting).toContainText('Sotto · Wake-up', { timeout: 30_000 })
    await expect(waiting.getByRole('button', { name: /Edit/u })).toHaveCount(0)
    await expect(queue.getByRole('button', { name: 'Move queued message 1 down' })).toHaveCount(0)
    await expectReadable({ 'queued label': waiting.locator('.thread-followup__sotto') })
    await panel.getByRole('button', { name: 'Refresh pull request', exact: true }).click()
    await expect(panel.getByRole('list', { name: 'Merge checklist' })).toContainText('CI / Owned build failed, and 1 more', { timeout: 30_000 })
    // The transcript echoes it where it will go, as Sotto's and word for word.
    const echo = pane(page).getByRole('article', { name: 'Queued wake-up from Sotto' })
    await expect(echo).toContainText('- Check CI / Lint failed')
    await expect(echo.locator('ul')).toHaveCount(0)
    await capture(page, 'c-queued-wake-up-1280x800-dark')
    await waiting.getByRole('button', { name: 'Remove the wake-up from the queue' }).click()
    await expect(waiting).toHaveCount(0)
    await expect(line).toBeVisible()
    await event(page, { type: 'ready', threadId: 'workshop', text: 'Mentioned it in README.md.' })
    await expect(sentWakeUps).toHaveCount(1)
    // The thread rests with its queue paused: the pose and the queue stand above the composer together, clear of each other.
    await expect(queue.getByRole('button', { name: 'Resume queue', exact: true })).toBeVisible()
    await expect(pose).toBeVisible()
    await expectPoseClearOfQueue(page, pose, queue)
    const composeShot = async (name: string): Promise<void> => {
      const [queueBox, paneBox] = [(await queue.boundingBox())!, (await pane(page).boundingBox())!]
      const top = Math.max(paneBox.y, queueBox.y - 24)
      await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled',
        clip: { x: paneBox.x, y: top, width: paneBox.width, height: paneBox.y + paneBox.height - top } })
    }
    await mkdir(SHOTS, { recursive: true })
    await composeShot('c-pose-beside-queue-1280x800-dark')
    await resize(launched, 820, 560)
    await expectPoseClearOfQueue(page, pose, queue)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await composeShot('c-pose-beside-queue-820x560-dark')
    await resize(launched, 1280, 800)
    // The scripted provider's turn reports no completion, so the queue pauses on it; Resume queue sends the user's own.
    await queue.getByRole('button', { name: 'Resume queue', exact: true }).click()
    await expect(queue).toHaveCount(0, { timeout: 30_000 })
    await expect(status).toHaveText(/Working$/u, { timeout: 30_000 })
    await event(page, { type: 'ready', threadId: 'workshop', text: 'Added a changelog entry.' })
    await expect(status).toHaveText(/(Babysitting #74|Just finished)$/u)
    await expect(sentWakeUps).toHaveCount(1)

    // Stop: the host says so, the line goes, and Babysit pull request is back in ···, where focus waits.
    await line.getByRole('button', { name: 'Stop babysitting #74' }).click()
    await expect(passing).toHaveText('Stopped babysitting #74', { timeout: 30_000 })
    await expect(line).toHaveCount(0)
    await expect(more).toBeFocused()
    await expect(status).toHaveText(/(Done|Just finished)$/u)
    await expect(pose).toHaveCount(0)

    // Started again, then merged on GitHub: the last wake-up says so, and the line says babysitting ended and why.
    await more.click()
    await menuItem.click()
    await expect(line).toBeVisible({ timeout: 30_000 })
    await changeState(state => { Object.assign(state.pulls[0]!, { state: 'MERGED', mergedAt: new Date().toISOString(), checks: [check('Owned build', 'COMPLETED', 'SUCCESS'), check('Lint', 'COMPLETED', 'SUCCESS')] }) })
    await pass()
    await expect(sentWakeUps).toHaveCount(2, { timeout: 30_000 })
    await expect(sentWakeUps.last()).toContainText('It merged, so Sotto has stopped babysitting it.')
    await expect(status).toHaveText(/Working$/u)
    await event(page, { type: 'ready', threadId: 'workshop', text: '#74 is merged. Nothing left to do on this thread.' })
    await panel.getByRole('button', { name: 'Refresh pull request', exact: true }).click()
    const ended = panel.getByRole('group', { name: 'Babysitting ended' })
    await expect(ended).toContainText(/Ended at \d.+, after #74 merged\./u, { timeout: 30_000 })
    await expect(status).toHaveText(/(Done|Just finished)$/u)
    await expectReadable({ 'ended words': ended.locator('.pr-surface__babysit-text span') })
    // The passing word from starting again has gone by the time anyone reads why it ended.
    await expect(passing).toBeEmpty()
    await capture(page, 'c-ended-1280x800-dark')
    // Once read, Dismiss puts the ending away and focus goes back to the pull request; Refresh does not bring it back.
    await ended.getByRole('button', { name: 'Dismiss why babysitting #74 ended', exact: true }).click()
    await expect(ended).toHaveCount(0)
    await expect(panel.getByRole('heading', { name: '#74 Greet the reviewer' })).toBeFocused()
    await panel.getByRole('button', { name: 'Refresh pull request', exact: true }).click()
    await expect(panel.locator('.pr-surface__finished[data-state="merged"]')).toBeVisible()
    await expect(ended).toHaveCount(0)

    // Settings → Application: the switch beside the other agent switches, saying what each value does.
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Application', exact: true }).click()
    const toggle = page.getByRole('switch', { name: 'Let agents babysit pull requests' })
    await toggle.scrollIntoViewIfNeeded()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(toggle).toHaveAccessibleDescription(/^An agent can ask Sotto to babysit its pull request/u)
    await capture(page, 'c-settings-row-1280x800-dark')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(toggle).toHaveAccessibleDescription(/^Agents cannot start babysitting, and Sotto stops what they started\./u)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect((await readState()).calls.some(call => call.includes('BabysitFingerprint'))).toBe(true)
    expect(errors).toEqual([])
  } finally {
    if (launched) await closeSotto(launched)
    for (const [key, value] of [['SOTTO_E2E_GH_SCRIPT', previous.script], ['SOTTO_E2E_GH_EXECUTABLE', previous.executable], ['FAKE_GH_STATE', previous.state]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
  }
})
