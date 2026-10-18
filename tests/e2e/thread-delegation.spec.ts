/**
 * Delegation between threads as the window shows it (#1029, design A; ADR-0081), on the Owl track, with the real Claude
 * and Codex adapters over the fake CLIs in `tests/fixtures/` (`SOTTO_E2E_NATIVE_FIXTURE_ROOT` in `src/main/index.ts`).
 * A Claude Code thread delegates a review to a Codex thread through `sotto_delegate`, called as the thread's agent would
 * call it (`sottoE2E.delegationTool`): the card appears in the Claude thread with the thread as a link, Codex, This
 * computer and the wait, and its outcome moves to Answered when Codex answers; a delegation wider than the Claude
 * thread's own permission is refused, and its card says so with no link; the Codex thread keeps the name it was given,
 * has no row in the sidebar and is listed in the Claude thread's Tools › Agents instead (October 17, 2026), where its
 * request rolls up to the Claude thread's row and Open to answer shows it in the pane with Tools kept on the Claude
 * thread; it says "Delegated by" with a link back; the line under its composer speaks only while the user's own turn
 * there runs; Stop on the Claude thread names the delegated thread still working, and a press stops both. Stable offers
 * neither the bridge nor the tool.
 *
 *   npm run build && npx playwright test tests/e2e/thread-delegation.spec.ts
 */
import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { contrastRatio, parseThemeRgb } from '../../src/shared/themes/color'
import { evidenceDirectory } from '../fixtures/evidence'
import { fakeClaudePrompts } from '../fixtures/fakeClaudeRecords'
import { parseProviderRecords, writeProviderAction } from '../fixtures/providerRecords'
import { pageBoundProblems } from './support/designCapture'
import { onReleaseTrack } from './support/releaseTrack'
import { closeSotto, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/thread-delegation')
/** The roster's captures, which the verification note for delegated threads in Tools › Agents cites. */
const rosterEvidence = evidenceDirectory('artifacts/delegated-threads-in-agents')
const PARENT = 'Tailnet reconnect fix'
const REVIEW = 'Review the reconnect diff'
const JOURNEYS = 'Linux journeys for the fix'

/** A fresh profile whose app finds the fake CLIs under its `native-fixture` folder, and how to put everything back. */
async function nativeFixtureProfile() {
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-thread-delegation-' })).directory
  const root = join(profile, 'native-fixture')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  // No scripted reply: each fake holds every turn open until the journey completes it.
  for (const folder of ['claude', 'codex']) await writeFile(join(root, folder, 'script.json'), '{}')
  const previous = { SOTTO_E2E_NATIVE_FIXTURE_ROOT: process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT, SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE: process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE }
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = root
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  const restore = async (): Promise<void> => {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    await removeOwnedE2EProfile(profile)
  }
  return { profile, root, project: join(root, 'project'), restore }
}

/** Claude and Codex connected, a project, and a Claude thread whose turn on the user's message is still running. */
async function delegatingThread(page: Page, project: string): Promise<string> {
  return page.evaluate(async ({ path, title }) => {
    await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark' })
    const agents = window.sotto!.agents!
    const configured = await agents.command({ type: 'configure', patch: { provider: 'claude', enabled: true, enabledProviders: ['claude', 'codex'], checkClientUpdates: false } })
    if (configured.error) throw new Error(configured.error)
    for (const provider of ['claude', 'codex'] as const) {
      const connected = await agents.command({ type: 'connect', provider })
      if (connected.error) throw new Error(connected.error)
    }
    const created = await agents.command({ type: 'create-project', provider: 'claude', title: 'Harbour', path, useExisting: true })
    if (created.error) throw new Error(created.error)
    const projectId = created.host.projects.find(item => item.title === 'Harbour')!.id
    const model = (await agents.get()).host.models.find(item => item.providerId === 'claude' && item.ready)
    if (!model) throw new Error('No ready Claude model.')
    const thread = await agents.command({ type: 'create-thread', projectId, title, titleSource: 'user', modelId: model.id, workingCopy: 'shared', runtimeMode: 'approval-required' })
    if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'No thread was created.')
    const sent = await agents.command({ type: 'manual-send', threadId: thread.activeThreadId, text: 'Fix the tailnet reconnect flake. Have Codex review the diff.' })
    if (sent.error) throw new Error(sent.error)
    return thread.activeThreadId
  }, { path: project, title: PARENT })
}

type ToolResult = { status: string; delegation?: { id: string; thread: string; outcome: string; reply?: { text: string } }; models?: { provider: string; model: string; efforts: string[]; permissions: string[] }[]; code?: string; message?: string }
/** One of `sotto_delegate`'s tools, called for `threadId` as its agent would; the call's JSON result. */
const tool = (page: Page, threadId: string, name: 'delegate' | 'read_delegation' | 'cancel_delegation', args: Record<string, unknown>): Promise<ToolResult> =>
  page.evaluate(async ({ threadId, name, args }) => {
    const result = await window.sottoE2E!.delegationTool!({ threadId, name, arguments: args })
    const text = result.content.find(item => item.type === 'text')
    return JSON.parse(text && 'text' in text ? text.text : '{}') as ToolResult
  }, { threadId, name, args })

/** Codex's own thread IDs, in the order the fake app-server holds them. */
const codexThreads = async (codex: string): Promise<string[]> => {
  const state = JSON.parse(await readFile(join(codex, 'state.json'), 'utf8').catch(() => '{"threads":{}}')) as { threads: Record<string, unknown> }
  return Object.keys(state.threads)
}
const codexPrompts = async (codex: string): Promise<number> =>
  parseProviderRecords<{ method?: string }>(await readFile(join(codex, 'requests.jsonl'), 'utf8').catch(() => '')).filter(request => request.method === 'turn/start').length

/**
 * The thread `parentId` delegated to most recently, once it exists, which keeps the `title` the delegating thread gave
 * it: neither first-message naming nor generated naming writes over it.
 */
async function delegatedThread(page: Page, parentId: string, known: readonly string[], title: string): Promise<string> {
  let id: string | undefined
  await expect.poll(async () => {
    id = await page.evaluate(async ({ parentId, known }) => (await window.sotto!.agents!.get()).host.threads
      .find(thread => thread.delegatedBy === parentId && !known.includes(thread.id))?.id, { parentId, known: [...known] })
    return id
  }, { timeout: 30_000 }).toBeDefined()
  const named = async (): Promise<string | undefined> => page.evaluate(async threadId => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === threadId)?.title, id!)
  expect(await named()).toBe(title)
  return id!
}

const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Thread sidebar' })
const pane = (page: Page) => page.locator('section.thread-pane:not([data-hidden])')
async function openThread(page: Page, title: string): Promise<Locator> {
  await sidebar(page).getByRole('button', { name: title, exact: true }).click()
  const opened = pane(page)
  await expect(opened.locator('.thread-workspace__head h2')).toHaveText(title)
  return opened
}
/** Nothing in the pane wider than the pane, and every card inside the transcript's column. */
async function fits(page: Page, where: string): Promise<void> {
  expect(await pageBoundProblems(page), where).toEqual([])
  const overflow = await pane(page).evaluate(element => [...element.querySelectorAll<HTMLElement>('.thread-workspace__transcript, .delegation-card, .delegated-by, .delegation-note')]
    .filter(item => item.scrollWidth > item.clientWidth + 1).map(item => item.className))
  expect(overflow, where).toEqual([])
}
/** Every piece of delegation's text on screen against what it sits on, as Watcher's room measures its own. */
async function readable(page: Page, where: string): Promise<void> {
  const pairs = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const hex = (value: string): string => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = 'rgba(0, 0, 0, 0)'; context.fillStyle = value; context.fillRect(0, 0, 1, 1)
      return `#${[...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
    }
    const background = (element: Element): string => {
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor
        if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return hex(color)
      }
      return hex(getComputedStyle(document.body).backgroundColor)
    }
    const selectors = ['.delegation-card__lead', '.delegation-card__link', '.delegation-card__name', '.delegation-card__outcome', '.delegation-card__meta', '.delegation-card__wait', '.delegated-by > span',
      '.delegated-by .delegation-card__outcome', '.delegation-note', '.thread-message[data-from="delegation"] .thread-message__who']
    return selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length > 0)
      .map((element, index) => ({ name: `${selector} ${index}`, ink: hex(getComputedStyle(element).color), on: background(element) })))
  })
  const black = { r: 0, g: 0, b: 0 }
  for (const { name, ink, on } of pairs) expect(contrastRatio(parseThemeRgb(ink, black), parseThemeRgb(on, black)), `${name}, ${where}`).toBeGreaterThanOrEqual(4.5)
}
async function capture(launched: LaunchedSotto, name: string, directory = evidence): Promise<void> {
  await mkdir(directory, { recursive: true })
  await launched.page.mouse.move(0, 0)
  await launched.page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' })
}

const tools = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true })
async function openAgents(page: Page): Promise<Locator> {
  if (await tools(page).count() === 0) await pane(page).getByRole('button', { name: 'Tools', exact: true }).click()
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
  return tools(page).getByRole('list', { name: 'Delegated threads and agents, newest first' })
}
/**
 * The roster in Tools › Agents fits its panel at every size, and its text is 4.5:1 on what it sits on, a needs-you row's
 * tint and the opened row's tone included: translucent layers are laid over the opaque one under them, as drawn.
 */
async function rosterFits(page: Page, where: string): Promise<void> {
  // Beside Tools at the minimum size, the card's link in the pane gives way to an ellipsis, as it is drawn to; its full
  // name stays its title and its accessible name.
  expect((await pageBoundProblems(page)).filter(problem => problem !== `button-Open ${REVIEW}-content-clipped`), where).toEqual([])
  const problems = await tools(page).evaluate(panel => {
    const found: string[] = []
    const roster = panel.querySelector<HTMLElement>('.subagents-roster')
    if (roster && roster.scrollWidth > roster.clientWidth + 1) found.push('roster scrolls sideways')
    for (const row of panel.querySelectorAll<HTMLElement>('.delegated-row')) {
      const box = row.getBoundingClientRect()
      const control = row.querySelector<HTMLElement>('.delegated-row__open, .delegated-row__shown')?.getBoundingClientRect()
      const status = row.querySelector<HTMLElement>('.delegated-row__status')?.getBoundingClientRect()
      const meta = row.querySelector<HTMLElement>('.subagent-meta > span')?.getBoundingClientRect()
      if (control && (control.right > box.right + 1 || control.left < box.left)) found.push('open control outside its row')
      for (const [name, other] of [['status', status], ['meta', meta]] as const) {
        if (control && other && other.width > 0 && control.left < other.right && other.left < control.right && control.top < other.bottom && other.top < control.bottom) found.push(`open control over the ${name}`)
      }
    }
    return found
  })
  expect(problems, where).toEqual([])
  const pairs = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1; canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const pixel = (): string => `#${[...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
    const backdrop = (element: Element): string => {
      const layers: string[] = []
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor
        if (color === 'rgba(0, 0, 0, 0)' || color === 'transparent') continue
        layers.push(color)
        context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1)
        if (context.getImageData(0, 0, 1, 1).data[3] === 255) break
      }
      if (!layers.length || layers.length && (() => { context.clearRect(0, 0, 1, 1); context.fillStyle = layers.at(-1)!; context.fillRect(0, 0, 1, 1); return context.getImageData(0, 0, 1, 1).data[3] !== 255 })()) layers.push(getComputedStyle(document.body).backgroundColor)
      context.clearRect(0, 0, 1, 1)
      for (const layer of layers.reverse()) { context.fillStyle = layer; context.fillRect(0, 0, 1, 1) }
      return pixel()
    }
    const ink = (element: Element): string => { context.clearRect(0, 0, 1, 1); context.fillStyle = getComputedStyle(element).color; context.fillRect(0, 0, 1, 1); return pixel() }
    const selectors = ['.delegated-row .subagent-title', '.delegated-row__marker', '.delegated-row .subagent-description', '.delegated-row .subagent-meta', '.delegated-row .subagent-time',
      '.delegated-row__status', '.delegated-row__open', '.delegated-row__shown', '.tools-chrome__title', '.tools-chrome__detail']
    return selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length > 0)
      .map((element, index) => ({ name: `${selector} ${index}`, ink: ink(element), on: backdrop(element) })))
  })
  const black = { r: 0, g: 0, b: 0 }
  expect(pairs.length, where).toBeGreaterThan(0)
  for (const { name, ink, on } of pairs) expect(contrastRatio(parseThemeRgb(ink, black), parseThemeRgb(on, black)), `${name}, ${where}`).toBeGreaterThanOrEqual(4.5)
}

test('a Claude thread delegates to a Codex thread: the card, the sidebar, Delegated by and Stop', async () => {
  test.setTimeout(240_000)
  const { profile, root, project, restore } = await nativeFixtureProfile()
  const codex = join(root, 'codex')
  let launched: LaunchedSotto | undefined
  try {
    await onReleaseTrack('owl', async () => {
      launched = await launchSotto('success', profile)
      const { page } = launched
      const parentId = await delegatingThread(page, project)
      await expect.poll(() => fakeClaudePrompts(join(root, 'claude')), { timeout: 30_000 }).toBe(1)
      await page.reload()
      await resizeWindow(launched, 1280, 800)
      await openThreads(page)
      const parent = await openThread(page, PARENT)
      expect(await page.evaluate(() => window.sotto!.delegations !== undefined)).toBe(true)

      // The agent reads what it can delegate to, then hands the review to Codex and waits for it.
      const listing = await tool(page, parentId, 'read_delegation', {})
      const model = listing.models?.find(item => item.provider === 'codex')
      expect(model, JSON.stringify(listing)).toBeDefined()
      await page.evaluate(({ threadId, args }) => {
        (window as unknown as { delegating: Promise<unknown> }).delegating = window.sottoE2E!.delegationTool!({ threadId, name: 'delegate', arguments: args })
      }, { threadId: parentId, args: { work: 'code-review', title: REVIEW, brief: 'Review the diff on the reconnect fix. Say what blocks a merge.', provider: 'codex', model: model!.model,
        ...model!.efforts.length ? { effort: model!.efforts[0] } : {}, permission: 'approval-required', wait_seconds: 300 } })

      // The card: the thread as a link, Codex on This computer, Working, and the wait.
      const reviewId = await delegatedThread(page, parentId, [], REVIEW)
      const card = parent.getByRole('group', { name: `Delegated to ${REVIEW}` })
      await expect(card).toBeVisible({ timeout: 30_000 })
      await expect(card.getByRole('button', { name: `Open ${REVIEW}` })).toBeVisible()
      await expect(card.locator('.delegation-card__meta')).toContainText('Codex')
      await expect(card.locator('.delegation-card__meta')).toContainText('This computer')
      await expect(card.locator('.delegation-card__outcome')).toHaveText('Working')
      await expect(card.locator('.delegation-card__wait')).toHaveText(/^This thread waits up to 5 min for it\. \d+ s so far\.$/u, { timeout: 30_000 })

      // The delegated thread has no row in the sidebar: the Claude thread's row stands for it.
      const parentRow = sidebar(page).getByRole('button', { name: PARENT, exact: true })
      await expect(parentRow).toBeVisible()
      await expect(sidebar(page).getByRole('button', { name: REVIEW, exact: true })).toHaveCount(0)
      await capture(launched, 'card-working-dark-1280x800')

      // Tools › Agents lists it as a thread: its provider, a Thread marker, its brief, what the record knows, its outcome.
      const roster = await openAgents(page)
      const reviewRow = roster.locator(`li[data-thread-id="${reviewId}"]`)
      await expect(reviewRow.locator('.delegated-row__marker')).toHaveText('Thread')
      await expect(reviewRow.locator('.delegated-row__status')).toHaveText('Working', { timeout: 30_000 })
      await expect(reviewRow.locator('.subagent-description')).toHaveText('Review the diff on the reconnect fix. Say what blocks a merge.')
      await expect(reviewRow.locator('.subagent-meta')).toContainText('Codex · Code review')
      await expect(reviewRow.getByRole('button', { name: `Open ${REVIEW} as a thread` })).toBeVisible()
      await expect(tools(page).locator('.tools-chrome__title')).toHaveText('1 delegated thread')
      // Its details: the whole brief, read from main, and the latest outcome; Escape closes them.
      const head = reviewRow.getByRole('button', { name: `${REVIEW}, delegated thread on Codex, Working` })
      await head.click()
      await expect(reviewRow.locator('.subagent-details')).toContainText('Review the diff on the reconnect fix. Say what blocks a merge.')
      await expect(reviewRow.locator('.subagent-details h3').nth(1)).toHaveText('Latest outcome')
      await head.press('Escape')
      await expect(head).toHaveAttribute('aria-expanded', 'false')
      await expect(tools(page).locator('.tools-chrome__detail')).toHaveText('1 working')
      for (const [width, height] of [[1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          await rosterFits(page, `roster working ${appearance} ${width}x${height}`)
          await capture(launched, `roster-working-${appearance}-${width}x${height}`, rosterEvidence)
        }
      }
      await resizeWindow(launched, 1280, 800)
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))

      // Codex asks for a permission: the Claude thread's row says so, and so do the roster and the Agents tab.
      await expect.poll(() => codexPrompts(codex), { timeout: 30_000 }).toBe(1)
      const [reviewNative] = await codexThreads(codex)
      await writeProviderAction(join(codex, 'control.json'), { type: 'permission', threadId: reviewNative, text: 'gh pr merge 1150 --squash' })
      const answer = reviewRow.getByRole('button', { name: `Open ${REVIEW} to answer its request` })
      await expect(answer).toBeVisible({ timeout: 30_000 })
      await expect(reviewRow.locator('.delegated-row')).toHaveAttribute('data-needs', 'true')
      await expect(reviewRow.locator('.delegated-row__status')).toHaveText('Needs your approval')
      await expect(sidebar(page).locator('.thread-nav__row', { has: page.getByRole('button', { name: PARENT, exact: true }) }).locator('.thread-nav__status')).toContainText('Needs your approval')
      await expect(parentRow).toHaveAccessibleDescription(new RegExp(`Waiting in ${REVIEW}`, 'u'))
      await expect(tools(page).locator('.tools-chrome__detail')).toHaveText('1 needs you')
      await expect(page.locator('#tools-tab-agents .tools-rail__live')).toHaveAttribute('data-needs', 'true')
      await expect(pane(page).locator('.tools-toggle__agents-dot')).toHaveAttribute('data-needs', 'true')
      for (const [width, height] of [[1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          await reviewRow.scrollIntoViewIfNeeded()
          await rosterFits(page, `roster needs ${appearance} ${width}x${height}`)
          await capture(launched, `roster-needs-${appearance}-${width}x${height}`, rosterEvidence)
        }
      }
      await resizeWindow(launched, 1280, 800)
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))

      // Open to answer, by keyboard: the thread is in the pane, the sidebar still marks the Claude thread, and Tools stays
      // on the Claude thread's roster, pinned, where the row says In the pane.
      await answer.focus()
      await page.keyboard.press('Enter')
      await expect(pane(page).locator('.thread-workspace__head h2')).toHaveText(REVIEW)
      await expect(pane(page).locator('.delegated-by')).toContainText(`Delegated by ${PARENT}`)
      await expect(parentRow).toHaveAttribute('aria-current', 'page')
      await expect(sidebar(page).getByRole('button', { name: REVIEW, exact: true })).toHaveCount(0)
      await expect(reviewRow.locator('.delegated-row__shown')).toHaveText('In the pane')
      await expect(tools(page).getByRole('button', { name: `Unpin from ${PARENT}` })).toHaveAttribute('aria-pressed', 'true')
      for (const [width, height] of [[1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          await rosterFits(page, `opened ${appearance} ${width}x${height}`)
          await capture(launched, `opened-${appearance}-${width}x${height}`, rosterEvidence)
        }
      }
      await resizeWindow(launched, 1280, 800)
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
      // The request is answered in the delegated thread, by the user; then back to the Claude thread, with Tools closed.
      await page.evaluate(async threadId => {
        const thread = (await window.sotto!.agents!.get()).host.threads.find(item => item.id === threadId)!
        const answered = await window.sotto!.agents!.command({ type: 'answer', threadId, requestId: thread.requests[0]!.id, answer: 'Allow', approved: true })
        if (answered.error) throw new Error(answered.error)
      }, reviewId)
      await expect(reviewRow.locator('.delegated-row__status')).toHaveText('Working', { timeout: 30_000 })
      await pane(page).locator('.delegated-by').getByRole('button', { name: `Open ${PARENT}, the thread that delegated to this one` }).click()
      await expect(pane(page).locator('.thread-workspace__head h2')).toHaveText(PARENT)
      await tools(page).getByRole('button', { name: 'Close tools panel' }).click()
      await expect(tools(page)).toHaveCount(0)

      // Codex answers: the outcome moves to Answered, and the waiting call returns the reply as the delegated thread's.
      await writeProviderAction(join(codex, 'control.json'), { type: 'complete', threadId: reviewNative, text: 'Two small nits and nothing that blocks a merge.' })
      await expect(card.locator('.delegation-card__outcome')).toHaveText('Answered', { timeout: 30_000 })
      await expect(card.locator('.delegation-card__wait')).toHaveText(/^Answered in (\d+ min )?\d+ s, while this thread waited for it\.$|^Answered in \d+ min, while this thread waited for it\.$/u)
      const answered = await page.evaluate(async () => {
        const result = await (window as unknown as { delegating: Promise<{ content: { type: string; text?: string }[] }> }).delegating
        return JSON.parse(result.content[0]!.text!) as ToolResult
      })
      expect(answered.delegation).toMatchObject({ outcome: 'answered', reply: { text: 'Two small nits and nothing that blocks a merge.' } })

      // A second delegation the agent does not wait for: it keeps working, and the card says the answer comes later.
      const second = await tool(page, parentId, 'delegate', { work: 'building', title: JOURNEYS, brief: 'Run the Linux journeys against the fix and report which fail.', provider: 'codex', model: model!.model,
        ...model!.efforts.length ? { effort: model!.efforts[0] } : {}, permission: 'approval-required', wait_seconds: 0 })
      expect(second.delegation?.outcome, JSON.stringify(second)).toBe('working')
      const journeysId = await delegatedThread(page, parentId, [reviewId], JOURNEYS)
      const journeys = parent.getByRole('group', { name: `Delegated to ${JOURNEYS}` })
      await expect(journeys.locator('.delegation-card__wait')).toHaveText('This thread did not wait for it. The answer comes back as a wake-up.', { timeout: 30_000 })
      await expect.poll(() => codexPrompts(codex), { timeout: 30_000 }).toBe(2)

      // A delegation wider than this thread's own permission is refused: its card says what and why, and links nowhere.
      expect(model!.permissions).toContain('full-access')
      const wider = await tool(page, parentId, 'delegate', { work: 'research', brief: 'Draft the release notes for the reconnect fix.', provider: 'codex', model: model!.model,
        ...model!.efforts.length ? { effort: model!.efforts[0] } : {}, permission: 'full-access', wait_seconds: 0 })
      expect(wider, JSON.stringify(wider)).toMatchObject({ status: 'refused', code: 'PERMISSION_TOO_WIDE' })
      const refused = parent.getByRole('note', { name: 'Not delegated: Research' })
      await expect(refused).toBeVisible({ timeout: 30_000 })
      await expect(refused).toHaveAttribute('data-outcome', 'refused')
      await expect(refused.locator('.delegation-card__meta')).toContainText('Codex')
      await expect(refused.locator('.delegation-card__meta')).toContainText('This computer')
      await expect(refused.locator('.delegation-card__wait')).toHaveText('It asked for more permission than this thread has, or than your new-thread default allows. '
        + 'A delegated thread gets no more than either. Nothing was started. To give it more, raise the lower of the two first.')
      await expect(refused.getByRole('button')).toHaveCount(0)
      // Nothing was started for it.
      expect(await page.evaluate(async parentId => (await window.sotto!.agents!.get()).host.threads.filter(thread => thread.delegatedBy === parentId).length, parentId)).toBe(2)

      // Stop names the delegated thread still working, by its name and by the line under the composer.
      const stop = parent.getByRole('button', { name: 'Stop agent and the thread it delegated that is working' })
      await expect(stop).toBeVisible({ timeout: 30_000 })
      await expect(parent.locator('.delegation-note')).toHaveText('Stop also stops the thread it delegated that is working.')

      for (const [width, height] of [[1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          await journeys.scrollIntoViewIfNeeded()
          await fits(page, `parent ${appearance} ${width}x${height}`)
          await readable(page, `parent ${appearance} ${width}x${height}`)
          await capture(launched, `parent-${appearance}-${width}x${height}`)
          await refused.scrollIntoViewIfNeeded()
          await fits(page, `refused ${appearance} ${width}x${height}`)
          await readable(page, `refused ${appearance} ${width}x${height}`)
          await capture(launched, `refused-${appearance}-${width}x${height}`)
        }
      }
      await resizeWindow(launched, 1280, 800)
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))

      // By keyboard: the card's link opens the delegated thread, whose "Delegated by" links back.
      const link = card.getByRole('button', { name: `Open ${REVIEW}` })
      await link.focus()
      await expect(link).toBeFocused()
      await page.keyboard.press('Enter')
      const delegated = pane(page)
      await expect(delegated.locator('.thread-workspace__head h2')).toHaveText(REVIEW)
      const by = delegated.locator('.delegated-by')
      await expect(by).toContainText(`Delegated by ${PARENT}`)
      await expect(by.locator('.delegation-card__outcome')).toHaveText('Answered')
      // The brief is the delegating thread's words, not the user's.
      const brief = delegated.locator('.thread-message[data-from="delegation"]')
      await expect(brief.locator('header')).toContainText(`${PARENT}delegated`)
      await expect(brief).toContainText('Review the diff on the reconnect fix. Say what blocks a merge.')
      await expect(delegated.locator('.thread-message[data-role="user"] .thread-message__who', { hasText: /^You$/u })).toHaveCount(0)
      // Done, with no turn of the user's running there: nothing holds either thread back, so nothing is said.
      await expect(delegated.locator('.delegation-note')).toHaveCount(0)
      for (const [width, height] of [[1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(appearance => window.sotto!.updateSettings({ appearance }), appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          await fits(page, `delegated ${appearance} ${width}x${height}`)
          await readable(page, `delegated ${appearance} ${width}x${height}`)
          await capture(launched, `delegated-${appearance}-${width}x${height}`)
        }
      }
      await resizeWindow(launched, 1280, 800)
      await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))

      // The user's own turn there: while it runs, the thread that delegated waits it out, and the line says so.
      await page.evaluate(async threadId => {
        const sent = await window.sotto!.agents!.command({ type: 'manual-send', threadId, text: 'Also check the reconnect on a sleeping laptop.' })
        if (sent.error) throw new Error(sent.error)
      }, reviewId)
      await expect.poll(() => codexPrompts(codex), { timeout: 30_000 }).toBe(3)
      await expect(delegated.locator('.delegation-note')).toHaveText(`Your turn is running. ${PARENT} sends nothing here until it ends.`, { timeout: 30_000 })
      await fits(page, 'delegated your turn dark 1280x800')
      await readable(page, 'delegated your turn dark 1280x800')
      await capture(launched, 'delegated-your-turn-dark-1280x800')
      await writeProviderAction(join(codex, 'control.json'), { type: 'complete', threadId: reviewNative, text: 'It reconnects after sleep too.' })
      await expect(delegated.locator('.delegation-note')).toHaveCount(0, { timeout: 30_000 })
      const back = by.getByRole('button', { name: `Open ${PARENT}, the thread that delegated to this one` })
      await back.focus()
      await page.keyboard.press('Enter')
      await expect(pane(page).locator('.thread-workspace__head h2')).toHaveText(PARENT)

      // One press stops the Claude thread and the Codex thread it delegated that is still working.
      await pane(page).getByRole('button', { name: 'Stop agent and the thread it delegated that is working' }).click()
      await expect(journeys.locator('.delegation-card__outcome')).toHaveText('Stopped', { timeout: 30_000 })
      await expect(pane(page).getByRole('button', { name: /^Stop agent/ })).toHaveCount(0, { timeout: 30_000 })
      await expect(pane(page).locator('.delegation-note')).toHaveCount(0)
      const threads = await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.map(thread => ({ title: thread.title, status: thread.status })))
      expect(threads.find(thread => thread.title === JOURNEYS)?.status).not.toBe('running')
      expect(await page.evaluate(async threadId => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === threadId)?.title, journeysId)).toBe(JOURNEYS)
      await capture(launched, 'parent-stopped-dark-1280x800')
      expect(await readFile(join(root, 'claude', 'violations.jsonl'), 'utf8').catch(() => '')).toBe('')
    })
  } finally {
    if (launched) await closeSotto(launched)
    await restore()
  }
})

test('stable offers no delegation bridge and no delegation tool', async () => {
  test.setTimeout(120_000)
  const { profile, project, restore } = await nativeFixtureProfile()
  let launched: LaunchedSotto | undefined
  try {
    await onReleaseTrack('stable', async () => {
      launched = await launchSotto('success', profile)
      const { page } = launched
      const parentId = await delegatingThread(page, project)
      expect(await page.evaluate(() => window.sotto!.delegations === undefined)).toBe(true)
      await expect(page.evaluate(({ threadId }) => window.sottoE2E!.delegationTool!({ threadId, name: 'read_delegation', arguments: {} }), { threadId: parentId }))
        .rejects.toThrow(/Delegation is off in this build/u)
      await page.reload()
      await openThreads(page)
      await sidebar(page).getByRole('button', { name: PARENT, exact: true }).click()
      await expect(pane(page).getByRole('button', { name: 'Stop agent', exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('.delegation-card, .delegated-by, .delegation-note, [data-delegation-level]')).toHaveCount(0)
    })
  } finally {
    if (launched) await closeSotto(launched)
    await restore()
  }
})
