import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'
import sharp from 'sharp'

import { E2E_THREADS_NOW } from '../../src/shared/e2e'
import { populatedHistory, withSotto } from '../fixtures/designCaptureProfile'
import { EVIDENCE_THREADS, PERMISSION_REQUEST, placeCommandsIn, STREAM_MESSAGE_ID, STREAM_MOMENTS, STREAM_REPLY, STREAM_SHOWN, STREAM_THREAD_ID, evidenceThread, minutesAgo, streamActivities } from '../fixtures/reviewEvidence/content'
import { buildEvidenceRepository, EVIDENCE_PULL, evidenceRoot, writePullRequestMoment, type EvidenceRepository, type PullRequestMoment } from '../fixtures/reviewEvidence/repository'
import { DEFAULT_THEME_ID } from '../../src/shared/themes/library'
import { pageBoundProblems, setAppearance } from './support/designCapture'
import { paintedContrastSweep } from './support/paintedContrastSweep'
import { onReleaseTrack } from './support/releaseTrack'
import { openThreads, toggleTools, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'
import { holdOwlSky } from './support/sottoOwl'
import { seedWatcherControls, seedWatcherRoom, VOICE_QUESTION } from './support/watcherRoom'
import { fillPrompt, promptField } from './support/prompt'
import { seedUsageHistory, usageAssistantFrame, usageDashboardHarness, usageResultFrame, usageWait, waitForNativePrompt } from './support/usageDashboard'

/**
 * The real running app in real, busy states, for side-by-side review and as "before" images for later changes. Every
 * image comes from the built app's own renderer. The harness supplies data only: a real Git repository and scripted gh
 * (tests/fixtures/reviewEvidence), and the fake provider host's own events. It never writes a baseline and never opens
 * the user's profile. Run it through scripts/capture-review-evidence.mjs; without that it skips.
 */
const OUT = process.env.SOTTO_REVIEW_EVIDENCE_OUT
const ONLY = process.env.SOTTO_REVIEW_EVIDENCE_STATES?.split(',').map(name => name.trim()).filter(Boolean)
const BOXES_FROM = process.env.SOTTO_REVIEW_EVIDENCE_BOXES
/** Set to 1 to write each image's text contrast as painted beside it, in contrast/, lowest first. */
const CONTRAST = process.env.SOTTO_REVIEW_EVIDENCE_CONTRAST === '1'

type Mode = 'dark' | 'light'
type Box = { readonly left: number; readonly top: number; readonly width: number; readonly height: number }
interface ManifestRow { readonly file: string; readonly state: string; readonly shows: string; readonly differs: string; readonly bounds: readonly string[] }

const MODES: readonly Mode[] = ['dark', 'light']
const SMALLER_SIZES = [[1280, 800], [820, 560]] as const
const manifest = new Map<string, ManifestRow>()
const boxes = new Map<string, Box>()
let fixedBoxes: Readonly<Record<string, Box>> = {}
const failures: string[] = []

/** The word the working line starts on stays up, so two runs read the same; its interval is the only one this length. */
const WORKING_WORD_INTERVAL_MS = 3_800

/** Every infinite animation is held at one frame part-way through its cycle, so the frame repeats and still shows the animation. */
const ANIMATION_HOLD_MS = 900

/** The content size a capture names, with the shipped minimum left as it is. */
const resizeContentWindowFor = (launched: LaunchedSotto, width: number, height: number): Promise<void> => resizeContentWindow(launched, width, height, [820, 560])

/**
 * Holds the frame still. The pointer goes to the corner first unless the image is of what it points at, and the open row is
 * brought to the sidebar's middle unless the state set the sidebar's scroll itself.
 */
async function settle(page: Page, pointerAway = true, keepSidebarScroll = false): Promise<void> {
  if (pointerAway) await page.mouse.move(0, 0)
  const blank = await page.evaluate(async ({ hold, keepSidebarScroll }) => {
    await document.fonts.ready
    const endOf = (animation: Animation): number | undefined => animation.effect?.getComputedTiming().endTime as number | undefined
    await Promise.race([
      Promise.all(document.getAnimations().filter(animation => { const end = endOf(animation); return end !== undefined && Number.isFinite(end) }).map(animation => animation.finished.catch(() => undefined))),
      new Promise(done => setTimeout(done, 1_200)),
    ])
    for (const animation of document.getAnimations()) {
      // An animation that follows a scroll, such as the sidebar's rows at its edges, has no time to hold: it already shows
      // what the scroll it follows says, and pausing it would freeze it where the scroll set below no longer is.
      if (!(animation.timeline instanceof DocumentTimeline)) continue
      const end = endOf(animation)
      if (end !== undefined && Number.isFinite(end)) continue
      try { animation.currentTime = hold; animation.pause() } catch { /* A compositor-only animation with no timeline has no frame to hold. */ }
    }
    // The sidebar's own scroll depends on when a row last moved, so the open thread's row is brought to its middle, as a
    // reader would scroll to it, and the image repeats.
    const list = document.querySelector('.thread-nav__scroll'), open = list?.querySelector('[aria-current="page"]')
    if (keepSidebarScroll) { /* The state put the list where its image needs it. */ } else if (list && open) list.scrollTop += open.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - open.clientHeight) / 2
    else if (list) list.scrollTop = 0
    const frames = (): Promise<unknown> => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
    await frames()
    // The rows' fades follow the list's scroll. A list that was hidden, as under the rail at the minimum window, or whose
    // size changed with the window, can keep the fades it had then until it scrolls again, which once left every row
    // invisible. A scroll there and back moves nothing and brings every fade to the list as it stands.
    if (list && list.clientHeight > 0) {
      const at = list.scrollTop
      list.scrollTop = at > 0 ? at - 1 : at + 1
      await frames()
      list.scrollTop = at
      await frames()
    }
    // A list whose rows in its middle are all faded out is the blank list above, and its image would be wrong.
    if (!list || list.clientHeight === 0) return false
    const box = list.getBoundingClientRect(), middle = box.top + box.height / 2
    const rows = [...list.querySelectorAll('.thread-nav__row')].filter(row => { const at = row.getBoundingClientRect(); return at.height > 0 && at.top <= middle + 60 && at.bottom >= middle - 60 })
    return rows.length > 0 && rows.every(row => Number(getComputedStyle(row).opacity) < 0.1)
  }, { hold: ANIMATION_HOLD_MS, keepSidebarScroll })
  if (blank) throw new Error('The sidebar\'s thread list drew no rows: their fades did not follow the list.')
  await holdOwlSky(page)
}

function composerBox(file: string, measured: { x: number; y: number; width: number; height: number }): Box {
  const fixed = fixedBoxes[file]
  if (fixed) return fixed
  const left = Math.floor(measured.x), top = Math.floor(measured.y)
  return { left, top, width: Math.ceil(measured.x + measured.width) - left, height: Math.ceil(measured.y + measured.height) - top }
}

interface Capture {
  readonly launched: LaunchedSotto
  readonly page: Page
  readonly repository: EvidenceRepository
  /**
   * One image per mode at the current size, with the composer's crop from the same frame. `before` runs once the size and
   * the mode are set, for what neither survives, such as the pointer's hover, and the pointer then stays where it left it.
   */
  shoot(state: string, shows: string, differs?: string, options?: { readonly modes?: readonly Mode[]; readonly size?: readonly [number, number]; readonly before?: () => Promise<void>; readonly keepSidebarScroll?: boolean }): Promise<void>
}

function captureFor(launched: LaunchedSotto, repository: EvidenceRepository, out: string): Capture {
  const { page } = launched
  return {
    launched, page, repository,
    async shoot(state, shows, differs = '', options = {}) {
      const [width, height] = options.size ?? [1600, 1000]
      await resizeContentWindowFor(launched, width, height)
      for (const mode of options.modes ?? MODES) {
        await setAppearance(page, { appearance: mode }, mode)
        await options.before?.()
        await settle(page, options.before === undefined, options.keepSidebarScroll)
        const file = `${state}-${mode}-${width}.png`
        const image = await page.screenshot({ caret: 'hide' })
        await writeFile(join(out, file), image)
        if (CONTRAST) {
          await mkdir(join(out, 'contrast'), { recursive: true })
          await writeFile(join(out, 'contrast', file.replace(/\.png$/u, '.json')), `${JSON.stringify(await paintedContrastSweep(page, image), null, 1)}\n`)
        }
        const composer = page.locator('.thread-pane[data-focused] form.thread-prompt, .watcher-room form.thread-prompt').first()
        if (await composer.isVisible().catch(() => false)) {
          const box = composerBox(file, (await composer.boundingBox())!)
          boxes.set(file, box)
          await sharp(image).extract(box).toFile(join(out, 'composer', file))
        }
        manifest.set(file, { file, state, shows, differs, bounds: await pageBoundProblems(page) })
      }
      await setAppearance(page, { appearance: 'dark' }, 'dark')
    },
  }
}

const transcript = (page: Page): Locator => page.locator('.thread-pane[data-focused]').getByRole('log', { name: 'Thread transcript' })
const focusedPane = (page: Page): Locator => page.locator('section.thread-pane[data-focused]')

async function openThread(page: Page, title: string): Promise<void> {
  const row = page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: title, exact: true }).first()
  // A row at the list's edge is faded out and takes no presses (b5a3d9adc), so it is brought to the middle first, as a
  // reader would scroll to it.
  await row.evaluate(element => element.scrollIntoView({ block: 'center' }))
  await row.click({ position: { x: 16, y: 12 } })
  await expect(focusedPane(page).getByRole('heading', { name: title, exact: true })).toBeVisible()
}

/**
 * A long thread opens on its newest turns and the reader's own presses bring the rest in, so a state that reads its
 * earlier messages presses Show earlier messages until all of it is drawn, whatever ran before it.
 */
async function drawWholeThread(page: Page): Promise<void> {
  const earlier = transcript(page).locator('.thread-transcript__earlier').getByRole('button')
  await expect(async () => {
    if (await earlier.count()) await earlier.first().click({ timeout: 2_000 }).catch(() => undefined)
    expect(await transcript(page).locator('.thread-message').count()).toBeGreaterThanOrEqual(100)
  }).toPass({ timeout: 120_000 })
}

/**
 * Opens the pull request's thread with its turn's steps folded, as a finished turn starts, so a pull request state shows
 * the same transcript beside it whether or not an earlier state opened those steps.
 */
async function openPullRequestThread(page: Page): Promise<void> {
  await openThread(page, 'Thread store on a worker')
  const fold = transcript(page).getByRole('button', { name: /^Worked for.*Ran 3 commands/u }).first()
  if (await fold.getAttribute('aria-expanded') === 'true') await fold.click()
  await expect(fold).toHaveAttribute('aria-expanded', 'false')
}

/** Puts a transcript's scroll where a state names it, and holds until the transcript stops moving it. */
async function scrollTranscript(page: Page, to: 'top-of-turn' | 'middle' | 'bottom'): Promise<void> {
  await transcript(page).evaluate((log, where) => {
    const place = where === 'top-of-turn' ? log.querySelector('.thread-message')!.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop - 12
      : where === 'middle' ? (log.scrollHeight - log.clientHeight) / 2 : log.scrollHeight
    log.scrollTop = place
  }, to)
  await page.waitForTimeout(400)
}

/** The fixture's threads, added the way a window adds them, and their records told by the fake provider host. */
async function seedThreads(launched: LaunchedSotto, repository: EvidenceRepository): Promise<void> {
  const { page } = launched
  const created = await page.evaluate(async ({ path }) => {
    const agents = window.sotto!.agents!
    await agents.command({ type: 'connect' })
    const state = await agents.command({ type: 'create-project', title: 'sotto', path, useExisting: true })
    return Object.fromEntries(state.host.projects.map(project => [project.title, project.id]))
  }, { path: repository.path })
  for (const thread of EVIDENCE_THREADS) {
    await setMainClock(launched, Date.parse(thread.messages.at(-1)!.createdAt))
    await page.evaluate(async ({ thread, projectId }) => {
      const agents = window.sotto!.agents!
      let state = await agents.command({ type: 'create-thread', projectId, title: thread.title, titleSource: 'user', modelId: thread.modelId, threadId: thread.id, workingCopy: 'shared' })
      if (state.error) throw new Error(`${thread.title}: ${state.error}`)
      // A thread reaches its provider with its first send, so each one is sent to once before its record is told.
      state = await agents.command({ type: 'manual-send', threadId: thread.id, text: thread.messages[0]!.text })
      if (state.error) throw new Error(`${thread.title}: ${state.error}`)
      // The send's own record settles first, so the record told next is never counted with it.
      await new Promise(done => setTimeout(done, 150))
      await window.sottoE2E!.agentEvent!({ type: 'history', threadId: thread.id, text: '', status: thread.status, messages: [...thread.messages],
        ...(thread.activities ? { activities: [...thread.activities] } : {}) })
      await new Promise(done => setTimeout(done, 150))
    }, { thread, projectId: created[thread.project]! })
  }
  await setMainClock(launched, E2E_THREADS_NOW)
  // Older finished work has been read: a row says Done rather than Just finished once a client has shown it, which takes a moment to arrive.
  await expect(async () => {
    const unread = await page.evaluate(async () => {
      const agents = window.sotto!.agents!
      const waiting = (await agents.get()).host.threads.filter(thread => thread.finishedUnread === true).map(thread => thread.id)
      for (const id of waiting) await agents.command({ type: 'select-thread', threadId: id })
      return waiting
    })
    expect(unread).toEqual([])
    await page.waitForTimeout(500)
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.filter(thread => thread.finishedUnread === true).length)).toBe(0)
  }).toPass({ timeout: 60_000 })
  // A clean renderer, as after a restart: what it chose while the threads were being told (each one's greeting) is forgotten.
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await openThreads(page)
}

/**
 * Main stamps a thread when it is sent to, so its clock is moved to the fixture era before anything is seeded. It keeps
 * running from there, since main's own waits measure it; `setMainClock` moves it to a thread's own time while that thread
 * is told, so a row's time and the sidebar's order come out of the real code.
 */
async function freezeMain(launched: LaunchedSotto): Promise<void> {
  await launched.app.evaluate(() => {
    const RealDate = Date, realNow = RealDate.now.bind(RealDate), holder = globalThis as unknown as { evidenceClock: { offset: number } }
    holder.evidenceClock = { offset: 0 }
    globalThis.Date = class extends RealDate {
      constructor(...parts: []) { if (parts.length) super(...parts); else super(realNow() + holder.evidenceClock.offset) }
      static override now(): number { return realNow() + holder.evidenceClock.offset }
    } as DateConstructor
  })
  await setMainClock(launched, E2E_THREADS_NOW)
}

async function setMainClock(launched: LaunchedSotto, at: number): Promise<void> {
  await launched.app.evaluate((_electron, at) => {
    const holder = globalThis as unknown as { evidenceClock: { offset: number } }
    holder.evidenceClock.offset = 0
    holder.evidenceClock.offset = at - Date.now()
  }, at)
}

/** Starts the clock and random numbers the same way for every renderer of this launch, before the app reads either. */
async function freezeRenderer(page: Page): Promise<void> {
  await page.addInitScript(({ interval, now }) => {
    const RealDate = Date
    window.Date = class extends RealDate {
      constructor(...parts: []) { if (parts.length) super(...parts); else super(now) }
      static override now(): number { return now }
    } as DateConstructor
    // One value, not a seeded sequence: how many draws came first depends on timing. Nothing in the renderer draws until it gets a different one.
    Math.random = () => 0.37
    const realInterval = window.setInterval.bind(window)
    window.setInterval = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) => ms === interval ? 0 : realInterval(handler, ms, ...rest)) as typeof window.setInterval
  }, { interval: WORKING_WORD_INTERVAL_MS, now: E2E_THREADS_NOW })
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
}

let streamed = 0
/** The reply arrives a few characters at a time, as a provider's deltas do, up to a moment. */
async function streamTo(page: Page, moment: keyof typeof STREAM_MOMENTS): Promise<void> {
  const target = STREAM_MOMENTS[moment]
  if (streamed >= target) return
  await page.evaluate(async ({ thread, messageId, reply, from, target, activities, first }) => {
    const send = window.sottoE2E!.agentEvent!
    if (first && target > 0) {
      await send({ type: 'history', threadId: thread, text: '', status: 'running', messages: [...first, { id: messageId, role: 'assistant', text: reply.slice(0, 24), createdAt: first.at(-1)!.createdAt }], activities })
      from = 24
    }
    for (let at = from; at < target; at += 24) {
      await send({ type: 'stream', threadId: thread, messageId, text: reply.slice(0, Math.min(at + 24, target)), status: 'running', activities })
      await new Promise(done => setTimeout(done, 20))
    }
  }, { thread: STREAM_THREAD_ID, messageId: STREAM_MESSAGE_ID, reply: STREAM_REPLY, from: streamed, target, activities: [...streamActivities(moment)],
    first: streamed === 0 ? [...evidenceThread('stream').messages] : null })
  streamed = target
  if (target > 0) await expect(transcript(page)).toContainText(STREAM_SHOWN[moment], { timeout: 30_000 })
}

async function toolsTab(page: Page, name: string): Promise<Locator> {
  const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
  if (await panel.count() === 0) await toggleTools(page)
  await panel.getByRole('tab', { name, exact: true }).click()
  return panel
}

/** Real wheel turns over the diff until a file's block reaches the top of the list. */
async function wheelToFile(page: Page, panel: Locator, path: string): Promise<void> {
  const list = panel.locator('.changes-files'), block = panel.locator(`.changes-file[data-file-path="${path}"]`)
  const box = (await list.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await expect(async () => {
    const distance = (await block.boundingBox())!.y - box.y
    if (Math.abs(distance) > 4) await page.mouse.wheel(0, distance)
    await page.waitForTimeout(150)
    expect(Math.abs((await block.boundingBox())!.y - box.y)).toBeLessThanOrEqual(4)
  }).toPass({ timeout: 60_000 })
}

async function refreshBranch(page: Page, title: string): Promise<void> {
  await page.evaluate(async ({ title }) => {
    const agents = window.sotto!.agents!
    const state = await agents.get()
    const thread = state.host.threads.find(item => item.title === title)!
    await agents.command({ type: 'refresh-thread-worktree', threadId: thread.id })
  }, { title })
}

async function closeTools(page: Page): Promise<void> {
  if (await page.getByRole('complementary', { name: 'Tools', exact: true }).count()) await toggleTools(page)
}

/**
 * Where every state starts: the Threads page at 1600x1000 in the default dark look, one pane, Tools shut and not expanded,
 * nothing open over the thread, motion on, and neither the keys nor the pointer on anything. A state that stops part-way
 * leaves what it opened behind it, and a state that ends at another size or with a split open does too, so each next
 * state would start inside the last one's mess and read wrong or fail.
 */
async function cleanStart(capture: Capture): Promise<void> {
  const { page, launched } = capture
  for (let tries = 0; tries < 4 && await page.locator('[role="dialog"]:visible, [role="menu"]:visible').count(); tries += 1) await page.keyboard.press('Escape')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await openThreads(page)
  await resizeContentWindowFor(launched, 1600, 1000)
  const restore = page.getByRole('button', { name: 'Restore tools panel', exact: true })
  if (await restore.count()) await restore.first().click()
  await closeTools(page)
  for (let tries = 0; tries < 4 && await page.locator('section.thread-pane').count() > 1; tries += 1) {
    await page.locator('section.thread-pane').last().getByRole('button', { name: /^Close .+ pane$/u }).first().click()
  }
  await expect(page.locator('section.thread-pane')).toHaveCount(1)
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('.threads-view, .threads-view *')) if (element.scrollTop > 0 && !element.closest('.changes-files, [role="log"], .thread-nav')) element.scrollTop = 0
  })
  await setAppearance(page, { appearance: 'dark', lightTheme: DEFAULT_THEME_ID, darkTheme: DEFAULT_THEME_ID }, 'dark')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.mouse.move(0, 0)
}

const PR_NOTES: Readonly<Record<PullRequestMoment, string>> = {
  'checks-running': 'Pull request surface in Tools with Gates, three test shards, Package and Desktop still running or queued; the branch toolbar shows the pull request badge.',
  'checks-failed': 'Pull request surface with Gates (Windows) and Test shard 2 failed and Desktop result still running; badge visible.',
  ready: 'Pull request surface with every check green and an approval, Merge enabled; badge visible.',
  'blocked-many': 'A draft that conflicts with main and is three commits behind it, with no review: four lines blocked and the checks done.',
  'auto-merge': 'Auto-merge armed while checks still run: the armed line in Merge\'s place.',
  merged: 'A merged pull request: what happened in Merge\'s place.',
  'changes-requested': 'Checks passed and a reviewer asked for changes, with nobody approving since.',
  'no-review-needed': 'A repository with no required review and no checks: the lines say so rather than claiming a pass.',
  closed: 'A pull request closed without merging, behind main, with a failed check and a cancelled one.',
}
const PR_STATE: Readonly<Record<PullRequestMoment, string>> = { 'checks-running': 'pr-checks-running', 'checks-failed': 'pr-checks-failed', ready: 'pr-ready', 'blocked-many': 'pr-blocked-many', 'auto-merge': 'pr-auto-merge', merged: 'pr-merged',
  'changes-requested': 'pr-changes-requested', 'no-review-needed': 'pr-no-review-needed', closed: 'pr-closed' }

/** The pull request surface opened on a moment, and read. */
async function pullRequestMomentRead(capture: Capture, moment: PullRequestMoment): Promise<void> {
  const { page, repository } = capture
  await writePullRequestMoment(repository, moment)
  const panel = await toolsTab(page, 'Pull request')
  await refreshBranch(page, 'Thread store on a worker')
  await panel.getByRole('button', { name: 'Refresh pull request', exact: true }).click()
  const shows: Partial<Record<PullRequestMoment, string | RegExp>> = { ready: 'Approved by mira', 'checks-failed': /fail/iu, 'blocked-many': 'Conflicts with main', 'auto-merge': /running/iu, merged: 'Approved by mira',
    'checks-running': /running/iu, 'changes-requested': 'ola asked for changes', 'no-review-needed': 'No review required', closed: 'Behind main' }
  await expect(panel.getByRole('list', { name: 'Merge checklist' })).toContainText(shows[moment]!, { timeout: 30_000 })
}

async function pullRequestMoment(capture: Capture, moment: PullRequestMoment): Promise<void> {
  const { page, repository } = capture
  await writePullRequestMoment(repository, moment)
  const panel = await toolsTab(page, 'Pull request')
  await refreshBranch(page, 'Thread store on a worker')
  const refresh = panel.getByRole('button', { name: 'Refresh pull request', exact: true })
  await expect(refresh).toBeVisible({ timeout: 30_000 })
  await refresh.click()
  await expect(panel.getByRole('heading', { name: new RegExp(`^#${EVIDENCE_PULL} `, 'u') })).toBeVisible({ timeout: 30_000 })
  const checklist = panel.getByRole('list', { name: 'Merge checklist' })
  if (moment === 'ready') await expect(checklist).toContainText('Approved by mira', { timeout: 30_000 })
  else if (moment === 'checks-failed') await expect(checklist).toContainText(/fail/iu, { timeout: 30_000 })
  else await expect(checklist).toContainText(/running|waiting|progress|queued/iu, { timeout: 30_000 })
  await expect(focusedPane(page).getByRole('button', { name: new RegExp(`Open PR #${EVIDENCE_PULL}`, 'u') })).toBeVisible({ timeout: 30_000 })
  await capture.shoot(PR_STATE[moment], PR_NOTES[moment], 'The pull request lives in the scripted gh: its checks and reviews are data, read through the real status reader and surface. Shown as the app does it: with Tools open the pane header is narrow, and the branch name and the #1612 badge are drawn over each other.')
}

/** Sets one row of Changes' View menu by its place in the menu, since a new row's words only reach a build once the catalogs are extracted. */
async function viewChoice(panel: Locator, row: 'stacked' | 'split' | 'wrap' | 'whitespace' | 'one-file' | 'tree', on: boolean): Promise<void> {
  await panel.locator('.changes-view > button').click()
  const item = panel.locator('.changes-view [role^="menuitem"]').nth(['stacked', 'split', 'wrap', 'whitespace', 'one-file', 'tree'].indexOf(row))
  if (await item.getAttribute('aria-checked') !== String(on)) await item.click()
  await panel.locator('.changes-view > button').click()
}

/** Every state, in an order that leaves each next one a clean start. A name in --states picks a group or a single image's state. */
const STATES: ReadonlyArray<{ readonly name: string; readonly covers: readonly string[]; readonly run: (capture: Capture) => Promise<void> }> = [
  { name: 'threads-empty', covers: [], run: async capture => {
    const { page } = capture
    await page.getByRole('button', { name: 'New thread', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
    await dialog.getByRole('searchbox', { name: 'Search projects' }).fill('sotto')
    await dialog.getByRole('button', { name: /^sotto / }).first().click()
    await expect(dialog).toHaveCount(0)
    // The header fills in once the host has read the folder's Git status: without this the first image is taken before that
    // read and the second after it, and the two modes seem to hold different things.
    await expect(focusedPane(page).locator('.git-action')).toBeVisible()
    await capture.shoot('threads-empty', 'Threads page: a busy sidebar and a new, empty thread with its greeting and composer.', 'The greeting line comes from the held random number.')
  } },
  { name: 'thread-idle', covers: [], run: async capture => {
    await openThread(capture.page, 'Repository review')
    await scrollTranscript(capture.page, 'top-of-turn')
    await capture.shoot('thread-idle', 'A finished thread read from the top of its turn: "What do you think of this repository?", the folded Worked for line, and a reply with headings, lists, inline code and a code block.')
  } },
  { name: 'thread-long', covers: ['steps-finished', 'steps-finished-open'], run: async capture => {
    const { page } = capture
    await openThread(page, 'Split AgentControl')
    await drawWholeThread(page)
    await scrollTranscript(page, 'middle')
    const shows = 'A long thread (102 messages and 134 tool calls, the calls folded in their turns) scrolled to its middle, with the sidebar full: a twelve-cut refactor, its questions, a failed typecheck and a flaky test fixed, a rebase and three pull requests. It opens on its newest turns, so Show earlier messages is pressed until all of it is drawn.'
    const differs = 'The session is written by hand, and its commands print a line or two where a real run prints more.'
    await capture.shoot('thread-long', shows, differs)
    for (const size of SMALLER_SIZES) {
      await resizeContentWindowFor(capture.launched, size[0], size[1])
      await scrollTranscript(page, 'middle')
      await capture.shoot('thread-long', shows, differs, { modes: ['dark'], size })
    }
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    if (!ONLY || ONLY.includes('steps-finished') || ONLY.includes('steps-finished-open')) {
      // A finished turn opened to its steps, the first with four commands: quick reads, a slow test run and a typecheck that failed.
      const fold = transcript(page).getByRole('button', { name: /^Worked for.*Ran 4 commands/u }).first()
      const opened = async (): Promise<void> => {
        await fold.evaluate(element => element.scrollIntoView({ block: 'start' }))
        await expect(fold).toHaveAttribute('aria-expanded', 'true')
        await fold.evaluate(element => element.scrollIntoView({ block: 'start' }))
      }
      await fold.click()
      await opened()
      const finishedShows = 'A finished turn in the long thread opened to its steps: quick reads, a slow test run and a typecheck that failed.'
      await capture.shoot('steps-finished', finishedShows, differs)
      await resizeContentWindowFor(capture.launched, 820, 560)
      await opened()
      await capture.shoot('steps-finished', finishedShows, differs, { modes: ['dark'], size: [820, 560] })
      await resizeContentWindowFor(capture.launched, 1600, 1000)
      if (!ONLY || ONLY.includes('steps-finished-open')) {
        // The same turn with its failed typecheck pressed open: the command and Copy on one line, then what it printed.
        await opened()
        const failed = transcript(page).getByRole('button', { name: /^npm run typecheck, Exit 1/u }).first()
        await failed.click()
        await expect(failed).toHaveAttribute('aria-expanded', 'true')
        await fold.evaluate(element => element.scrollIntoView({ block: 'start' }))
        const openShows = 'The same finished turn with its failed typecheck pressed open: the command whole with Copy at the end of its line, then what it printed.'
        await capture.shoot('steps-finished-open', openShows, differs)
        await resizeContentWindowFor(capture.launched, 1280, 800)
        await fold.evaluate(element => element.scrollIntoView({ block: 'start' }))
        await capture.shoot('steps-finished-open', openShows, differs, { modes: ['dark'], size: [1280, 800] })
        await resizeContentWindowFor(capture.launched, 820, 560)
        await fold.evaluate(element => element.scrollIntoView({ block: 'start' }))
        await capture.shoot('steps-finished-open', openShows, differs, { modes: ['dark'], size: [820, 560] })
        await resizeContentWindowFor(capture.launched, 1600, 1000)
        await failed.click()
        await expect(failed).toHaveAttribute('aria-expanded', 'false')
      }
      // Folded again, so the states after this start as the user left a turn's steps before it.
      await fold.click()
      await expect(fold).toHaveAttribute('aria-expanded', 'false')
      // And read from the middle again, where thread-long leaves this thread for the states that open it later.
      await scrollTranscript(page, 'middle')
    }
  } },
  { name: 'turn-quiet', covers: ['turn-quiet-hover', 'turn-quiet-focus', 'turn-quiet-glass', 'turn-quiet-clay'], run: async capture => {
    // A quick turn's Worked for line keeps its room but shows nothing until the pointer is over the turn or the keyboard
    // reaches it (Zach's pick C, November 6, 2026, ADR-0134), read where "Wait, which one was cut 3?" stands mid-thread.
    const { page } = capture
    await openThread(page, 'Split AgentControl')
    await drawWholeThread(page)
    const ask = transcript(page).locator('.thread-message[data-role="user"]').filter({ hasText: 'Wait, which one was cut 3?' }).first()
    const line = transcript(page).locator('.thread-message[data-role="user"]:has-text("Wait, which one was cut 3?") + .thread-work[data-quiet]').first()
    await expect(line).toHaveCount(1)
    const centre = (): Promise<void> => ask.evaluate(element => element.scrollIntoView({ block: 'center' }))
    // Neither a resize nor a switch of look keeps the pointer's hover, so the pointer comes to the bubble after both.
    const point = async (): Promise<void> => {
      await centre()
      const box = (await ask.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await expect(line.locator('.thread-work__summary')).toHaveCSS('opacity', '1')
    }
    const hoverShows = 'The pointer over "Wait, which one was cut 3?" in the long thread: its quick turn\'s Worked for line shows, while the quick turns around it keep their room with nothing in it.'
    for (const theme of [DEFAULT_THEME_ID, 'glass', 'clay'] as const) {
      await page.evaluate(async id => window.sotto!.updateSettings({ darkTheme: id, lightTheme: id }), theme)
      const state = theme === DEFAULT_THEME_ID ? 'turn-quiet-hover' : `turn-quiet-${theme}`
      const named = theme === DEFAULT_THEME_ID ? '' : theme === 'glass' ? ' On Glass.' : ' On Clay.'
      for (const size of [[1600, 1000] as const, ...SMALLER_SIZES]) await capture.shoot(state, `${hoverShows}${named}`, '', { size, before: point })
    }
    await page.evaluate(async id => window.sotto!.updateSettings({ darkTheme: id, lightTheme: id }), DEFAULT_THEME_ID)
    // Tab first, so the focus ring is the keyboard's; the copy control under the bubble comes just before the line.
    await centre()
    await page.keyboard.press('Tab')
    await ask.locator('.thread-message__copy').focus()
    await page.keyboard.press('Tab')
    await expect(line.locator('.thread-work__summary')).toBeFocused()
    const focusShows = 'The keyboard on the same quick turn\'s Worked for line, reached with Tab from the copy control under the bubble: it shows with its focus ring.'
    for (const size of [[1600, 1000] as const, ...SMALLER_SIZES]) {
      await resizeContentWindowFor(capture.launched, size[0], size[1])
      await centre()
      await capture.shoot('turn-quiet-focus', focusShows, '', { size })
    }
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await scrollTranscript(page, 'middle')
  } },
  { name: 'steps-cut', covers: ['steps-cut'], run: async capture => {
    // A finished turn's rows beside the pull request, where the transcript is narrow and a long test command has to give way.
    const { page } = capture
    await openThread(page, 'Thread store on a worker')
    await toolsTab(page, 'Pull request')
    const fold = transcript(page).getByRole('button', { name: /^Worked for.*Ran 3 commands/u }).first()
    if (await fold.getAttribute('aria-expanded') !== 'true') await fold.click()
    await expect(fold).toHaveAttribute('aria-expanded', 'true')
    await expect(transcript(page).getByRole('button', { name: /^npm test -- tests\/integration\/threadStoreWorker/u })).toBeVisible()
    const shows = 'A finished turn opened to its steps beside the pull request: a test command too long for its row keeps its verb and both files\' names.'
    await capture.shoot('steps-cut', shows)
    await resizeContentWindowFor(capture.launched, 1280, 800)
    await capture.shoot('steps-cut', shows, '', { modes: ['dark'], size: [1280, 800] })
    // At the minimum window Tools would cover the thread, so the rows are read without it, at the window's own width.
    await closeTools(page)
    await resizeContentWindowFor(capture.launched, 820, 560)
    await fold.evaluate(element => element.scrollIntoView({ block: 'start' }))
    await capture.shoot('steps-cut', shows, '', { modes: ['dark'], size: [820, 560] })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await fold.click()
    await expect(fold).toHaveAttribute('aria-expanded', 'false')
    await closeTools(page)
  } },
  { name: 'reading', covers: ['reading-copy', 'reading-reply-copy', 'reading-scrubber', 'reading-scrubber-woken', 'reading-scrubber-glass', 'reading-scrubber-glass-woken', 'reading-scrubber-clay', 'reading-scrubber-clay-woken', 'reading-jump-focus', 'reading-new-messages', 'reading-clay', 'reading-glass'], run: async capture => {
    const { page } = capture
    await openThread(page, 'Split AgentControl')
    await drawWholeThread(page)
    await scrollTranscript(page, 'middle')
    const pane = focusedPane(page)
    const user = transcript(page).locator('.thread-message[data-role="user"]').filter({ hasText: 'titleRequests' }).first()
    // Focus holds the control open through the shoot's resize, which a pointer's hover does not survive.
    await page.keyboard.press('Tab')
    await user.locator('.thread-message__copy').focus()
    const copyShows = 'The keyboard on the copy control of a message the user sent, just under the bubble\'s bottom-left corner.'
    await capture.shoot('reading-copy', copyShows)
    for (const size of SMALLER_SIZES) {
      await resizeContentWindowFor(capture.launched, size[0], size[1])
      await user.locator('.thread-message__copy').evaluate(element => element.scrollIntoView({ block: 'center' }))
      await capture.shoot('reading-copy', copyShows, '', { modes: ['dark'], size })
    }
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    // A reply after the first is headed by its name and time, as the first is (Zach's pick B, November 7, 2026).
    const reply = transcript(page).locator('.thread-message[data-role="assistant"]').filter({ hasText: 'threadTitles' }).first()
    await reply.locator('.thread-message__copy').focus()
    await reply.evaluate(element => element.scrollIntoView({ block: 'center' }))
    await capture.shoot('reading-reply-copy', 'The keyboard on the copy control of a reply after the first one, which is headed by its name and time.')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const lane = pane.locator('.message-scrubber')
    if (await lane.count()) {
      // At rest only the ticks around the messages on screen show; the pointer anywhere in the lane shows them all
      // (ADR-0109, Zach's pick C on November 5, 2026). The pointer rests over the column's words, as a reader's does.
      const rest = async (): Promise<void> => {
        const view = (await transcript(page).boundingBox())!
        await page.mouse.move(view.x + view.width * 0.7, view.y + view.height * 0.4)
      }
      // The pointer comes in from the column's words and stops at the middle of the lane, beside the tick it reaches.
      const wake = async (): Promise<void> => {
        const box = (await lane.boundingBox())!
        await page.mouse.move(box.x + box.width + 40, box.y + box.height / 2 - 6)
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await expect(pane.locator('.message-scrubber__card')).toBeVisible()
      }
      // Neither a resize nor a switch of look keeps the pointer's card, so the pointer comes in after both.
      const shootWoken = (state: string, shows: string, modes: readonly Mode[] = MODES, size: readonly [number, number] = [1600, 1000]): Promise<void> =>
        capture.shoot(state, shows, '', { modes, size, before: wake })
      const restShows = 'The message scrubber at rest beside a long thread read part-way up: only the ticks around the messages on screen show, fading out above and below them.'
      const wokenShows = 'The pointer in the message scrubber\'s lane: every tick shows, the ones near the pointer risen, with the card for the tick it reached.'
      await rest()
      await capture.shoot('reading-scrubber', restShows)
      await shootWoken('reading-scrubber-woken', wokenShows)
      for (const size of SMALLER_SIZES) {
        await resizeContentWindowFor(capture.launched, size[0], size[1])
        await rest()
        await capture.shoot('reading-scrubber', restShows, '', { modes: ['dark'], size })
        await shootWoken('reading-scrubber-woken', wokenShows, ['dark'], size)
      }
      await resizeContentWindowFor(capture.launched, 1600, 1000)
      for (const theme of ['glass', 'clay'] as const) {
        await page.evaluate(async theme => window.sotto!.updateSettings({ darkTheme: theme, lightTheme: theme }), theme)
        await rest()
        await capture.shoot(`reading-scrubber-${theme}`, `${restShows} In the ${theme === 'glass' ? 'Glass' : 'Clay'} theme.`)
        await shootWoken(`reading-scrubber-${theme}-woken`, `${wokenShows} In the ${theme === 'glass' ? 'Glass' : 'Clay'} theme.`)
      }
      await page.evaluate(async () => window.sotto!.updateSettings({ darkTheme: 't3-code', lightTheme: 't3-code' }))
      await page.mouse.move(800, 300)
    }
    // Tab first, so the focus ring is the keyboard's: a modifier alone does not count as the keyboard.
    await page.keyboard.press('Tab')
    await pane.getByRole('button', { name: 'Jump to latest' }).focus()
    await capture.shoot('reading-jump-focus', 'Jump to latest with the keyboard on it.')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    // A reply arrives while the reader is back up the thread, and the button says so.
    const long = EVIDENCE_THREADS.find(thread => thread.title === 'Split AgentControl')!
    const tell = (messages: readonly (typeof long.messages)[number][]): Promise<void> => page.evaluate(async ({ thread, messages }) => {
      await window.sottoE2E!.agentEvent!({ type: 'history', threadId: thread.id, text: '', status: thread.status, messages: [...messages], ...(thread.activities ? { activities: [...thread.activities] } : {}) })
    }, { thread: long, messages })
    const last = long.messages.at(-1)!
    await tell([...long.messages, { ...last, id: 'review-evidence-arrived', text: 'One more thing: the pull request is ready for your review.' }])
    await expect(pane.getByRole('button', { name: 'New messages' })).toBeVisible()
    await capture.shoot('reading-new-messages', 'New messages, after a reply arrived while the reader was back up the thread.', 'The reply is told to the thread by the fake provider host and taken back afterwards.')
    await capture.shoot('reading-new-messages', 'The same at the minimum window, where the button has no margin to stand in.', 'The reply is told to the thread by the fake provider host and taken back afterwards.', { modes: ['dark'], size: [820, 560] })
    await tell(long.messages)
    await openThread(page, 'Repository review')
    await scrollTranscript(page, 'top-of-turn')
    // The keyboard on the sent message's copy control, so each theme shows it under the bubble's corner too.
    await page.keyboard.press('Tab')
    await transcript(page).locator('.thread-message[data-role="user"]').filter({ hasText: 'What do you think of this repository?' }).first().locator('.thread-message__copy').focus()
    await page.evaluate(async () => window.sotto!.updateSettings({ darkTheme: 'clay', lightTheme: 'clay' }))
    await capture.shoot('reading-clay', 'A finished reply in the Clay theme, to check the reading surface away from the default palette, with the keyboard on the copy control of the message the user sent.')
    await page.evaluate(async () => window.sotto!.updateSettings({ darkTheme: 'glass', lightTheme: 'glass' }))
    await capture.shoot('reading-glass', 'The same reply on Glass, whose room is painted once and whose cards are translucent, to check the foot of the transcript, with the keyboard on the copy control of the message the user sent.')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.evaluate(async () => window.sotto!.updateSettings({ darkTheme: 't3-code', lightTheme: 't3-code' }))
  } },
  { name: 'streaming', covers: ['streaming-1', 'streaming-2', 'streaming-3'], run: async capture => {
    const { page } = capture
    await openThread(page, 'Trace a permission request')
    const differs = 'The deltas come from the fake provider host at a steady rate, not a model.'
    await capture.shoot('streaming-1', 'A streaming turn before its first word: the working line after three steps, one command running.', differs)
    await capture.shoot('streaming-1', 'The same at the minimum window.', differs, { size: [820, 560] })
    await streamTo(page, 'second')
    await capture.shoot('streaming-2', 'The same turn with its reply part-way through the numbered list, written under the working line and the plan Claude sent, three of four done; the transcript follows the end.', differs)
    await capture.shoot('streaming-2', 'The same at the minimum window.', differs, { size: [820, 560] })
    await streamTo(page, 'third')
    await capture.shoot('streaming-3', 'The same turn further on, its reply under its plan and working line, cut off inside the code block as it arrives.', differs)
    await capture.shoot('streaming-3', 'The same at the minimum window.', differs, { size: [820, 560] })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
  } },
  { name: 'steps', covers: ['steps-collapsed', 'steps-expanded'], run: async capture => {
    const { page } = capture
    await openThread(page, 'Plan the split')
    const line = focusedPane(page).getByRole('button', { name: /^Working, / })
    await expect(line).toBeVisible()
    await capture.shoot('steps-collapsed', 'An agent mid-way through "Plan the split": its steps folded under the working line.')
    await capture.shoot('steps-collapsed', 'The same line at a narrower window.', '', { modes: ['dark'], size: [1280, 800] })
    await capture.shoot('steps-collapsed', 'The same line at the minimum window.', '', { modes: ['dark'], size: [820, 560] })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await capture.shoot('steps-collapsed-still', 'The same line under reduced motion: the light holds still and a still dot stands beside the words.', '', { modes: ['dark'] })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const composer = focusedPane(page).locator('form.thread-prompt')
    /**
     * From the end of the thread at the window's size, as a reader there would: the working line pressed, then the command
     * that read the publish windows module, for its output. The plan is one of the steps there and opens nothing, since its
     * checklist stands above the line.
     */
    const unfold = async (width: number, height: number, folded: boolean): Promise<void> => {
      await resizeContentWindowFor(capture.launched, width, height)
      if (!folded) await line.click()
      await scrollTranscript(page, 'bottom')
      await line.click()
      await focusedPane(page).getByRole('button', { name: /^Read the publish windows module, cat src\/main\/agents\/publishWindows\.ts, /u }).click()
      await expect(focusedPane(page).getByText('export interface PublishWindow')).toBeVisible()
      // The press can take the reader off the end, so the composer slims; it is not done moving when its animations are.
      let lastTop = Number.NaN
      await expect.poll(async () => { const top = (await composer.boundingBox())?.y ?? Number.NaN, still = top === lastTop; lastTop = top; return still }, { intervals: [500] }).toBe(true)
    }
    await unfold(1600, 1000, true)
    await capture.shoot('steps-expanded', 'The same turn unfolded: the newest six steps under the plan’s checklist, the plan among them as one step, and a finished command pressed open to its output.')
    await unfold(1280, 800, false)
    await capture.shoot('steps-expanded', 'The same turn unfolded at a narrower window, pressed open at that size.', '', { modes: ['dark'], size: [1280, 800] })
    await unfold(820, 560, false)
    await capture.shoot('steps-expanded', 'The same turn unfolded at the minimum window, pressed open at that size.', '', { modes: ['dark'], size: [820, 560] })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await setAppearance(page, { appearance: 'dark', lightTheme: 'clay', darkTheme: 'clay' }, 'dark')
    await capture.shoot('steps-expanded-clay', 'The same turn unfolded on another theme, clay.')
    await setAppearance(page, { appearance: 'dark', lightTheme: DEFAULT_THEME_ID, darkTheme: DEFAULT_THEME_ID }, 'dark')
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await line.click()
  } },
  { name: 'doc-edit', covers: ['doc-edit-collapsed', 'doc-edit-expanded'], run: async capture => {
    const { page } = capture
    await openThread(page, 'Write the split plan down')
    const log = transcript(page)
    const work = log.getByRole('button', { name: /^Worked for/u })
    await work.click()
    const row = log.getByRole('button', { name: /Edited docs\/plans\/agent-control-split\.md/u })
    await expect(row).toBeVisible()
    await capture.shoot('doc-edit-collapsed', 'An edit to a Markdown document in the transcript: the turn\'s steps open and the edit\'s own row folded.', 'The Worked for fold is pressed open so the edit\'s row shows; a finished turn starts with it folded.')
    await capture.shoot('doc-edit-collapsed', 'The same at the minimum window.', '', { modes: ['dark'], size: [820, 560] })
    const composer = focusedPane(page).locator('form.thread-prompt')
    /**
     * The edit's row pressed at the window's size, as a reader there would: a window pressed open at 820 and shot at 1600
     * shows where the narrow press left the diff, not where a press at 1600 brings it.
     */
    /** Presses the row until it reads `want`, so a press lost to a transcript still moving after a resize is pressed again. */
    const fold = async (want: boolean): Promise<void> => {
      await expect(async () => {
        if (await row.getAttribute('aria-expanded') !== String(want)) await row.click()
        await expect(row).toHaveAttribute('aria-expanded', String(want), { timeout: 1500 })
      }).toPass({ timeout: 15_000 })
    }
    const open = async (width: number, height: number): Promise<void> => {
      await resizeContentWindowFor(capture.launched, width, height)
      await fold(true)
      await expect(log.locator('.thread-activity__change').first()).toBeVisible()
      // The press can take the reader off the end, so the composer slims; it is not done moving when its animations are.
      let lastTop = Number.NaN
      await expect.poll(async () => { const top = (await composer.boundingBox())?.y ?? Number.NaN, still = top === lastTop; lastTop = top; return still }, { intervals: [500] }).toBe(true)
    }
    await open(1600, 1000)
    await capture.shoot('doc-edit-expanded', 'The same edit unfolded with its diff showing, pressed at this size.')
    await fold(false)
    await open(820, 560)
    await capture.shoot('doc-edit-expanded', 'The same edit unfolded at the minimum window, pressed at that size: the diff is taller than the room under its row, so the row rises to the top and the diff reads from its start.', '', { modes: ['dark'], size: [820, 560] })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await fold(false)
    await work.click()
  } },
  { name: 'changes', covers: ['changes-big', 'changes-expanded', 'changes-file', 'changes-sideways', 'changes-tree-press'], run: async capture => {
    const { page } = capture
    await openPullRequestThread(page)
    const panel = await toolsTab(page, 'Changes')
    await panel.locator('.changes-scope__select').selectOption('branch')
    await expect(panel.locator('.changes-file').nth(29)).toBeAttached({ timeout: 60_000 })
    const expand = panel.getByRole('button', { name: 'Expand all files', exact: true })
    if (await expand.count()) await expand.click()
    await viewChoice(panel, 'tree', true)
    await expect(panel.locator('.changes-review[data-tree]')).toBeAttached()
    await page.waitForTimeout(1_000)
    const shows = 'Changes in Tools on Branch changes against origin/main: 30 files, about 4,200 lines added and removed, with the file tree on and every file open. At this panel width the tree waits behind All files.'
    const differs = 'The diff is a real merge from this repository\'s history (ead571a0d), in a repository holding only the files it touched.'
    await capture.shoot('changes-big', shows, differs)
    for (const size of SMALLER_SIZES) await capture.shoot('changes-big', shows, differs, { modes: ['dark'], size })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    // Expanded, the panel has room for the tree beside the lines.
    await page.getByRole('button', { name: 'Expand tools panel', exact: true }).click()
    await expect(panel.getByRole('listbox', { name: 'Files in this comparison' })).toBeVisible()
    await page.waitForTimeout(500)
    await capture.shoot('changes-expanded', 'The same comparison with the tools panel expanded over the thread, where the tree stands beside the lines.', differs)
    // A press on a file in the tree is the other way to a file, and it must move only the list. The tree stands beside the
    // lines here, so the shot shows it with the file pressed marked; at the panel's own width it waits behind All files.
    await panel.getByRole('listbox', { name: 'Files in this comparison' }).getByRole('option', { name: /storeOverlay\.ts/u }).first().click()
    // The place says the pressed file at once. The shot waits for the press to end: a smooth scroll this long takes
    // about two seconds, and a shot at one caught the list on its way, with the file before it at the top.
    await expect(panel.locator('.changes-jump__place')).toHaveText('10 of 30')
    await expect.poll(() => panel.locator('.changes-files').evaluate(list => {
      const block = list.querySelector<HTMLElement>('.changes-file[data-file-path="src/main/agents/storeOverlay.ts"]')
      return block ? Math.abs(block.offsetTop - list.scrollTop) : -1
    }), { timeout: 10_000 }).toBeLessThan(1)
    await page.waitForTimeout(1_200)
    const moved = await page.evaluate(() => {
      let most = 0
      for (const element of document.querySelectorAll('.threads-view, .threads-view *')) if (!element.closest('.changes-files, .changes-tree__list, [role="log"], .thread-nav')) most = Math.max(most, element.scrollTop)
      return most
    })
    await capture.shoot('changes-tree-press', 'The same comparison, expanded, after a press on src/main/agents/storeOverlay.ts in the file tree beside the lines: the file is at the top of the list and marked in the tree.', moved > 0 ? `Shown as the app does it: the press also scrolled the workspace itself up by ${Math.round(moved)} px, which moves the header, the composer and the window controls with it and leaves a blank band at the foot.` : '')
    await page.getByRole('button', { name: 'Restore tools panel', exact: true }).click()
    await page.waitForTimeout(500)
    await wheelToFile(page, panel, 'src/main/agents/threadStore.ts')
    await capture.shoot('changes-file', 'The same diff, wheeled down to one file, src/main/agents/threadStore.ts, with its hunks.', differs)
    // The tab where a line runs on past the panel scrolls the file to that line's end. It is drawn by the line's end,
    // held at the panel's edge, so the press goes to where it is drawn.
    const file = panel.locator('.changes-file[data-file-path="src/main/agents/threadStore.ts"]')
    const runsOn = await file.locator('.changes-line[data-kind="add"] .changes-line__on').first().boundingBox()
    if (runsOn) {
      await page.mouse.click(runsOn.x - 8, runsOn.y + runsOn.height / 2)
      await expect.poll(() => file.locator('.changes-diff__body').evaluate(body => body.scrollLeft), { timeout: 5_000 }).toBeGreaterThan(0)
      await page.waitForTimeout(900)
      await capture.shoot('changes-sideways', 'threadStore.ts after a press on the tab at the end of line 18, which runs past the panel: the file scrolled sideways to that line\'s end, its numbers and signs held at the left.')
      await file.locator('.changes-diff__body').evaluate(body => { body.scrollLeft = 0 })
      // The tab and the arrow keys add to free scrolling, never replace it: a sideways wheel still moves the file.
      await page.mouse.move(runsOn.x - 200, runsOn.y + runsOn.height / 2)
      await page.mouse.wheel(240, 0)
      await expect.poll(() => file.locator('.changes-diff__body').evaluate(body => body.scrollLeft), { timeout: 5_000 }).toBeGreaterThan(0)
      await file.locator('.changes-diff__body').evaluate(body => { body.scrollLeft = 0 })
    }
    // Code wraps hardest where the panel is narrowest.
    for (const size of SMALLER_SIZES) {
      await resizeContentWindowFor(capture.launched, size[0], size[1])
      await wheelToFile(page, panel, 'src/main/agents/threadStore.ts')
      await capture.shoot('changes-file', 'The same file at a smaller window.', differs, { modes: ['dark'], size })
    }
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await page.evaluate(() => {
      for (const element of document.querySelectorAll('.threads-view, .threads-view *')) if (element.scrollTop > 0 && !element.closest('.changes-files, [role="log"], .thread-nav')) element.scrollTop = 0
    })
    await closeTools(page)
  } },
  // The rest of reading a long comparison, and a diff away from the default palette. Controls are found by what they are,
  // since a new control's words only reach a build once the catalogs are extracted.
  { name: 'changes-more', covers: ['changes-tree-filter', 'changes-view-menu', 'changes-all-files', 'changes-split', 'changes-wrap', 'changes-one-file', 'changes-reworked', 'changes-reworked-glass', 'changes-reworked-clay', 'changes-clay', 'doc-edit-clay'], run: async capture => {
    const { page } = capture
    await openPullRequestThread(page)
    const panel = await toolsTab(page, 'Changes')
    await panel.locator('.changes-scope__select').selectOption('branch')
    await expect(panel.locator('.changes-file').nth(29)).toBeAttached({ timeout: 60_000 })
    await viewChoice(panel, 'tree', true)
    await panel.locator('.changes-jump__all').click()
    await panel.locator('.changes-tree__filter').fill('worker')
    await capture.shoot('changes-tree-filter', 'The file tree, opened from All files, filtered to the files with "worker" in their path, their long names whole.')
    await panel.locator('.changes-tree__filter').fill('')
    await page.keyboard.press('Escape')
    await expect(panel.getByRole('listbox', { name: 'Files in this comparison' })).toBeHidden()
    await panel.locator('.changes-view > button').click()
    await capture.shoot('changes-view-menu', 'View open in the bar above the files: the layout, wrapping, whitespace, one file at a time and the file tree.')
    await panel.locator('.changes-view > button').click()
    // A panel too narrow for the tree beside the lines opens it over them.
    for (const size of [[1600, 1000] as const, ...SMALLER_SIZES]) {
      await resizeContentWindowFor(capture.launched, size[0], size[1])
      await panel.locator('.changes-jump__all').click()
      await expect(panel.getByRole('listbox', { name: 'Files in this comparison' })).toBeVisible()
      await capture.shoot('changes-all-files', 'All files open over the lines, in a panel too narrow for the tree beside them.', '', { modes: size[0] === 1600 ? ['dark', 'light'] : ['dark'], size })
      await page.keyboard.press('Escape')
      await expect(panel.getByRole('listbox', { name: 'Files in this comparison' })).toBeHidden()
    }
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await viewChoice(panel, 'tree', false)
    await viewChoice(panel, 'split', true)
    await page.waitForTimeout(300)
    await capture.shoot('changes-split', 'The same files in the split view, with the tree off.', '', { modes: ['dark'] })
    await viewChoice(panel, 'stacked', true)
    await viewChoice(panel, 'wrap', true)
    await page.waitForTimeout(300)
    await capture.shoot('changes-wrap', 'The same files with Wrap long lines on: a long line of code wraps inside its file, hanging inside its indent.', '', { modes: ['dark'] })
    await viewChoice(panel, 'wrap', false)
    await viewChoice(panel, 'one-file', true)
    await panel.getByRole('button', { name: 'Next file', exact: true }).click()
    await expect(panel.locator('.changes-file')).toHaveCount(1)
    await page.waitForTimeout(500)
    await capture.shoot('changes-one-file', 'One file at a time, after a press on Next file, with the tree off.')
    await viewChoice(panel, 'one-file', false)
    // A paragraph reworked all through reads as two paragraphs, the old one whole and then the new one whole: at each
    // size, on the default theme, on Glass and on Clay.
    const reworked = panel.locator('.changes-file[data-file-path="CONTEXT.md"] .changes-line[data-reworked]').first()
    const toReworked = async (): Promise<void> => {
      await wheelToFile(page, panel, 'CONTEXT.md')
      const box = (await panel.locator('.changes-files').boundingBox())!
      // Clear of the file's head, which stays at the top while its lines scroll under it.
      const under = (): Promise<number> => reworked.boundingBox().then(row => row!.y - box.y - 56)
      await expect(async () => {
        const distance = await under()
        if (Math.abs(distance) > 4) await page.mouse.wheel(0, distance)
        await page.waitForTimeout(150)
        expect(Math.abs(await under())).toBeLessThanOrEqual(4)
      }).toPass({ timeout: 60_000 })
    }
    for (const theme of [DEFAULT_THEME_ID, 'glass', 'clay']) {
      await page.evaluate(async id => window.sotto!.updateSettings({ darkTheme: id, lightTheme: id }), theme)
      for (const size of [[1600, 1000] as const, ...SMALLER_SIZES]) {
        await resizeContentWindowFor(capture.launched, size[0], size[1])
        await toReworked()
        await expect(reworked.locator('.changes-reworked__was')).toBeVisible()
        const named = theme === DEFAULT_THEME_ID ? '' : theme === 'glass' ? ' On Glass.' : ' On Clay.'
        await capture.shoot(theme === DEFAULT_THEME_ID ? 'changes-reworked' : `changes-reworked-${theme}`, `CONTEXT.md in Changes with its reworked paragraph, line 338, read as two paragraphs: as it was, its removed words struck, then as it is now, its new words underlined.${named}`, '', { size })
      }
    }
    await page.evaluate(async id => window.sotto!.updateSettings({ darkTheme: id, lightTheme: id }), DEFAULT_THEME_ID)
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await page.evaluate(async () => window.sotto!.updateSettings({ darkTheme: 'clay', lightTheme: 'clay' }))
    await viewChoice(panel, 'tree', true)
    await wheelToFile(page, panel, 'CONTEXT.md')
    await capture.shoot('changes-clay', 'A document\'s change in Changes on the Clay theme, to check the marks away from the default palette.')
    await wheelToFile(page, panel, 'src/main/agents/threadStore.ts')
    await capture.shoot('changes-clay', 'Code in Changes on the Clay theme, to check syntax colour away from the default palette.', '', { modes: ['dark'], size: [1280, 800] })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await closeTools(page)
    await openThread(page, 'Write the split plan down')
    const log = transcript(page)
    await log.getByRole('button', { name: /^Worked for/u }).click()
    await log.getByRole('button', { name: /Edited docs\/plans\/agent-control-split\.md/u }).click()
    await page.waitForTimeout(300)
    await capture.shoot('doc-edit-clay', 'The same document edit in the transcript on the Clay theme.')
    await page.evaluate(async id => window.sotto!.updateSettings({ darkTheme: id, lightTheme: id }), DEFAULT_THEME_ID)
  } },
  { name: 'pr', covers: ['pr-checks-running', 'pr-checks-failed', 'pr-ready', 'pr-fold-hover'], run: async capture => {
    const { page } = capture
    await openPullRequestThread(page)
    await pullRequestMoment(capture, 'checks-running')
    await pullRequestMoment(capture, 'checks-failed')
    await pullRequestMoment(capture, 'ready')
    const files = page.getByRole('complementary', { name: 'Tools', exact: true }).getByRole('button', { name: /^Changed files/u })
    await capture.shoot('pr-fold-hover', 'The pointer on a file under the closed Changed files head: the whole head lights, its files with it, as the one press that opens them.', '',
      { before: async () => { await files.hover({ position: { x: 160, y: 70 } }) } })
    for (const size of SMALLER_SIZES) await capture.shoot('pr-ready', PR_NOTES.ready, 'The pull request lives in the scripted gh. At this size the pane header has no room left for the badge, so it does not show.', { modes: ['dark'], size })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await closeTools(page)
  } },
  // How the answer holds: the blocked and the ready surface at every size, in a third theme, and the states that take Merge's place.
  { name: 'pr-states', covers: ['pr-blocked-many', 'pr-auto-merge', 'pr-merged', 'pr-failed-clay', 'pr-ready-clay', 'pr-ready-glass', 'pr-merge-method'], run: async capture => {
    const { page } = capture
    await openPullRequestThread(page)
    const scripted = 'The pull request lives in the scripted gh: its checks, reviews and how it stands are data, read through the real status reader and surface.'
    await pullRequestMomentRead(capture, 'checks-failed')
    for (const size of SMALLER_SIZES) await capture.shoot('pr-checks-failed', PR_NOTES['checks-failed'], scripted, { modes: ['dark'], size })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await page.evaluate(async () => window.sotto!.updateSettings({ darkTheme: 'clay', lightTheme: 'clay' }))
    await page.waitForTimeout(400)
    await capture.shoot('pr-failed-clay', 'Blocked, in the Clay theme.', scripted)
    await capture.shoot('pr-failed-clay', 'Blocked, in the Clay theme, at the smallest window.', scripted, { modes: ['light'], size: [820, 560] })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await pullRequestMomentRead(capture, 'ready')
    await capture.shoot('pr-ready-clay', 'Ready, in the Clay theme.', scripted)
    await page.evaluate(async () => window.sotto!.updateSettings({ darkTheme: 'glass', lightTheme: 'glass' }))
    await page.waitForTimeout(400)
    await capture.shoot('pr-ready-glass', 'Ready, on Glass, whose surfaces are translucent: Merge and the box of folds over the painted room.', scripted)
    await page.evaluate(async id => window.sotto!.updateSettings({ darkTheme: id, lightTheme: id }), DEFAULT_THEME_ID)
    await page.waitForTimeout(400)
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    await panel.getByRole('button', { name: /^Merge method:/u }).click()
    await capture.shoot('pr-merge-method', 'The merge method menu over a ready pull request, whose short checklist leaves it no room above Merge.', scripted)
    await page.keyboard.press('Escape')
    for (const moment of ['blocked-many', 'auto-merge', 'merged'] as const) {
      await pullRequestMomentRead(capture, moment)
      await capture.shoot(PR_STATE[moment], PR_NOTES[moment], scripted)
    }
    await resizeContentWindowFor(capture.launched, 820, 560)
    await pullRequestMomentRead(capture, 'blocked-many')
    await capture.shoot(PR_STATE['blocked-many'], PR_NOTES['blocked-many'], scripted, { modes: ['dark'], size: [820, 560] })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await closeTools(page)
  } },
  // Every moment of the pull request, in both modes at every size, so each line's label can be read against its reason. Run by name.
  { name: 'pr-every', covers: ['pr-changes-requested', 'pr-no-review-needed', 'pr-closed'], run: async capture => {
    const { page } = capture
    await openPullRequestThread(page)
    const scripted = 'The pull request lives in the scripted gh: its checks, reviews and how it stands are data, read through the real status reader and surface.'
    for (const moment of Object.keys(PR_STATE) as PullRequestMoment[]) {
      await pullRequestMomentRead(capture, moment)
      for (const size of [[1600, 1000], ...SMALLER_SIZES] as const) await capture.shoot(PR_STATE[moment], PR_NOTES[moment], scripted, { size })
    }
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await closeTools(page)
  } },
  // The drill-in folded under the plain answer: every check, the changed files, the description, the repository's open pull requests and one of them read.
  { name: 'pr-detail', covers: ['pr-checks-fold', 'pr-all-checks', 'pr-files', 'pr-review-in-changes', 'pr-description', 'pr-clay', 'pr-open-list', 'pr-other'], run: async capture => {
    const { page } = capture
    await openPullRequestThread(page)
    const scripted = 'The pull request and the repository\'s others live in the scripted gh: checks, times, files and counts are data, read through the real status reader and surface. The files and their counts are the real diff\'s.'
    await pullRequestMomentRead(capture, 'checks-failed')
    const panel = page.getByRole('complementary', { name: 'Tools', exact: true })
    const checks = panel.getByRole('button', { name: /^Checks \d+/u })
    await checks.click()
    await expect(panel.getByRole('list', { name: 'Checks', exact: true })).toBeVisible()
    await capture.shoot('pr-checks-fold', 'A failed pull request with its Checks fold opened below Merge: what failed and still runs first, with state and time, and the passed ones folded.', scripted)
    await resizeContentWindowFor(capture.launched, 820, 560)
    await panel.locator('.pr-surface__body').evaluate(body => { body.scrollTop += body.querySelector('.pr-surface__checks')!.getBoundingClientRect().top - body.getBoundingClientRect().top - 44 })
    await capture.shoot('pr-checks-fold', 'The Checks fold at the smallest window, scrolled to: a check\'s state goes under its name.', scripted, { modes: ['dark'], size: [820, 560] })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await panel.getByRole('button', { name: /^Show \d+ passed$/u }).click()
    await capture.shoot('pr-all-checks', 'The same fold with the passed checks shown too: every named check, its state, how long it took, and a press to open it.', scripted)
    await pullRequestMomentRead(capture, 'ready')
    const files = panel.getByRole('button', { name: /^Changed files/u })
    await checks.click()
    await files.click()
    await expect(panel.getByRole('list', { name: 'Changed files' })).toBeVisible()
    await capture.shoot('pr-files', 'Ready to merge, with the changed files opened below Merge: the most changed first, each with its added and removed lines.', scripted)
    await capture.shoot('pr-files', 'Ready to merge, with the changed files opened below Merge: the most changed first, each with its added and removed lines.', scripted, { modes: ['dark'], size: [1280, 800] })
    await resizeContentWindowFor(capture.launched, 820, 560)
    await panel.locator('.pr-surface__body').evaluate(body => { body.scrollTop += body.querySelector('.pr-surface__files')!.getBoundingClientRect().top - body.getBoundingClientRect().top - 44 })
    await capture.shoot('pr-files', 'The changed files at the smallest window, scrolled to: the folder gives way before the name.', scripted, { modes: ['dark'], size: [820, 560] })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await panel.getByRole('button', { name: 'Review in Changes', exact: true }).click()
    await expect(panel.locator('.changes-scope__select')).toHaveValue('branch', { timeout: 30_000 })
    await expect(panel.locator('.changes-file').nth(29)).toBeAttached({ timeout: 60_000 })
    await capture.shoot('pr-review-in-changes', 'Review in Changes pressed from the changed files: Changes on the branch against its base.', scripted)
    await panel.getByRole('tab', { name: 'Pull request', exact: true }).click()
    // Coming back opens the surface afresh, as any other Tools tab does: everything is folded again.
    await expect(panel.getByRole('button', { name: /^Changed files/u })).toBeVisible({ timeout: 30_000 })
    await panel.getByRole('button', { name: 'Description' }).click()
    await capture.shoot('pr-description', 'Ready to merge with its description unfolded, drawn as Markdown.', scripted)
    await page.evaluate(async () => window.sotto!.updateSettings({ darkTheme: 'clay', lightTheme: 'clay' }))
    await page.waitForTimeout(400)
    await files.click()
    await capture.shoot('pr-clay', 'The same surface with its files open in the Clay theme, to check it away from the default palette.', scripted)
    await files.click()
    await page.evaluate(async () => window.sotto!.updateSettings({ darkTheme: 't3-code', lightTheme: 't3-code' }))
    await panel.getByRole('button', { name: 'Description' }).click()
    const list = panel.getByRole('button', { name: /^Open pull requests/u })
    await list.click()
    await expect(panel.getByRole('list', { name: 'Open pull requests' })).toContainText('#1640', { timeout: 30_000 })
    await capture.shoot('pr-open-list', 'The repository\'s open pull requests, read on the press that opened the fold: a search, and for each its state, title, checks, author, age and line counts.', scripted)
    await resizeContentWindowFor(capture.launched, 820, 560)
    await panel.locator('.pr-surface__body').evaluate(body => { body.scrollTop += body.querySelector('.pr-surface__open-list')!.getBoundingClientRect().top - body.getBoundingClientRect().top - 90 })
    await capture.shoot('pr-open-list', 'The repository\'s open pull requests at the smallest window, scrolled to.', scripted, { modes: ['dark'], size: [820, 560] })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await panel.getByRole('button', { name: /^Show #1638:/u }).click()
    await expect(panel.getByRole('heading', { name: /^#1638 / })).toBeVisible({ timeout: 30_000 })
    await capture.shoot('pr-other', 'Another open pull request read from the list: its checklist, with no Merge and a press to link it to this thread, and Back to the thread\'s own.', scripted)
    await panel.getByRole('button', { name: 'Back to #1612', exact: true }).click()
    await expect(panel.getByRole('heading', { name: new RegExp(`^#${EVIDENCE_PULL} `, 'u') })).toBeVisible({ timeout: 30_000 })
    await closeTools(page)
  } },
  { name: 'git-dialog', covers: [], run: async capture => {
    const { page } = capture
    await openPullRequestThread(page)
    await refreshBranch(page, 'Thread store on a worker')
    const quick = focusedPane(page).locator('.git-action__quick')
    await expect(focusedPane(page).locator('.git-action__label')).toHaveText(/Commit/u, { timeout: 30_000 })
    await quick.click()
    const dialog = page.getByRole('dialog', { name: 'Commit changes' })
    await expect(dialog.getByRole('list', { name: 'Changed files' })).toContainText('storeWorkerProtocol.ts', { timeout: 30_000 })
    await capture.shoot('git-dialog', 'The Git action\'s commit dialog over the thread, with its changed-files list: four edits and one new file on the pull request\'s branch.')
    await capture.shoot('git-dialog', 'The commit dialog at the smallest window: the paths give way before the counts and the presses.', '', { modes: ['dark'], size: [820, 560] })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  } },
  { name: 'permission-card', covers: [], run: async capture => {
    const { page } = capture
    await page.evaluate(async ({ id, request }) => {
      await window.sottoE2E!.agentEvent!({ type: 'permission', threadId: id, text: request.text, request, status: 'running' })
    }, { id: evidenceThread('permission').id, request: PERMISSION_REQUEST })
    // The request goes again however the state ends, so the states after it see the waits they always have.
    try {
      await openThread(page, 'Measure the store worker')
      await expect(focusedPane(page).getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
      await capture.shoot('permission-card', 'A thread waiting on a permission request to run a benchmark, with its Allow, Allow for this session and Deny choices.', 'The request is the fake provider host\'s, in the shape the Claude adapter sends.')
      await capture.shoot('permission-card', 'The same at the minimum window.', 'The request is the fake provider host\'s, in the shape the Claude adapter sends.', { modes: ['dark'], size: [820, 560] })
      await resizeContentWindowFor(capture.launched, 1600, 1000)
    } finally {
      const thread = evidenceThread('permission')
      await page.evaluate(async thread => {
        await window.sottoE2E!.agentEvent!({ type: 'history', threadId: thread.id, text: '', status: thread.status, messages: thread.messages, ...(thread.activities ? { activities: thread.activities } : {}) })
      }, { id: thread.id, status: thread.status, messages: [...thread.messages], ...(thread.activities ? { activities: [...thread.activities] } : {}) })
      await expect(page.getByRole('complementary', { name: 'Thread sidebar' }).locator('.needs-you__entry[data-entry-id="' + thread.id + '"]')).toHaveCount(0)
    }
  } },
  { name: 'split-panes', covers: [], run: async capture => {
    const { page } = capture
    await openThread(page, 'Trace a permission request')
    await streamTo(page, 'third')
    const row = page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Repository review', exact: true }).first()
    await row.evaluate(element => element.scrollIntoView({ block: 'center' }))
    await row.hover({ position: { x: 16, y: 12 } })
    await page.getByRole('button', { name: 'Open Repository review beside', exact: true }).click()
    await expect(page.getByRole('separator', { name: 'Resize panes', exact: true })).toBeVisible()
    await capture.shoot('split-panes', 'Two threads side by side: the finished review and a thread still streaming its reply.', 'The stream is held at one moment while each image is taken.')
    for (const size of SMALLER_SIZES) await capture.shoot('split-panes', 'Two threads side by side: the finished review and a thread still streaming its reply.', 'The stream is held at one moment while each image is taken.', { modes: ['dark'], size })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
  } },
  { name: 'pages', covers: ['dictate', 'settings', 'usage-no-records', 'help'], run: async capture => {
    const { page } = capture
    await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Dictate', exact: true }).click()
    await expect(page.locator('.dictate')).toBeVisible()
    await capture.shoot('dictate', 'The Dictate room with its Journal, reached from the sidebar\'s room switch.', 'The Journal is the design captures\' fixture history. Nothing is being dictated.')
    await openThreads(page)
    await page.getByRole('link', { name: 'Usage', exact: true }).click()
    await page.waitForTimeout(1_500)
    // The page as it reads before any provider has written a record on this computer; `usage` itself is the page with records (captureConnectedUsage).
    await capture.shoot('usage-no-records', 'The Usage page with no provider\'s records on this computer.', 'Its prompt counts are the prompts this run sent. No provider wrote tokens or limits, so those tiles are empty, and its model name is the fixture model\'s ID.')
    await openThreads(page)
    await page.getByRole('link', { name: 'Help', exact: true }).click()
    await page.waitForTimeout(500)
    await capture.shoot('help', 'The Help page.')
    await openThreads(page)
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(page.locator('.settings-scroll')).toBeVisible()
    await capture.shoot('settings', 'Settings, opened on its first section.')
    await page.keyboard.press('Escape')
    await openThreads(page)
  } },
  // Asked for by name only: a model menu outside the composer, Settings → Threads' Thread model, open on its provider rail.
  { name: 'model-menu', covers: [], run: async capture => {
    const { page } = capture
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(page.locator('.settings-scroll')).toBeVisible()
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Threads', exact: true }).click()
    const chip = page.getByRole('combobox', { name: 'Thread model', exact: true })
    const menu = page.getByRole('dialog', { name: 'Choose model', exact: true })
    const open = async (): Promise<void> => {
      if (!await menu.isVisible()) await chip.click()
      await expect(menu.getByRole('tablist', { name: 'Model providers', exact: true })).toBeVisible()
    }
    await capture.shoot('model-menu', 'Settings → Threads with the Thread model menu open on its provider rail.', '', { before: open })
    if (await menu.isVisible()) await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await openThreads(page)
  } },
  // Asked for by name only: the header's lists open, over what stands beside them, and a control in it holding focus.
  { name: 'header-press', covers: [], run: async capture => {
    const { page } = capture
    await openThread(page, 'Split AgentControl')
    const head = focusedPane(page).locator('header.thread-workspace__head')
    await head.getByRole('combobox', { name: 'Choose branch' }).click()
    await capture.shoot('header-branch-open', 'The branch list open from the header, over what stands beside it.', '', { modes: ['dark'] })
    await page.keyboard.press('Escape')
    await head.locator('.working-copy__trigger').click()
    await capture.shoot('header-working-copy-open', 'The working copy open from the header.', '', { modes: ['dark'] })
    await page.keyboard.press('Escape')
    await head.locator('.working-copy__trigger').focus()
    await capture.shoot('header-focus', 'The working copy holding keyboard focus at the edge of the box beside the name.', '', { modes: ['dark'] })
    // The Council's landmark and Tools' panel named under the header as the keys reach them, in their tooltips' words.
    for (const [symbol, state] of [['[data-pane-council-toggle]', 'header-council-focus'], ['.tools-toggle', 'header-tools-focus']] as const) {
      const named = async (): Promise<void> => {
        await page.keyboard.press('Tab')
        await head.locator(symbol).focus()
        await expect(page.locator('.focus-name')).toBeVisible()
      }
      await capture.shoot(state, `The keyboard on ${state === 'header-council-focus' ? 'the Council' : 'Tools'} in the header, named under it.`, '', { modes: ['dark', 'light'], before: named })
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    }
  } },
  // Asked for by name only: the sidebar, Needs you and the header together, at every size, in both modes and on another theme.
  { name: 'shell-surface', covers: [], run: async capture => {
    const { page } = capture
    const everySize = async (state: string, shows: string): Promise<void> => {
      for (const size of [[1600, 1000], ...SMALLER_SIZES] as const) await capture.shoot(state, shows, '', { size })
      await resizeContentWindowFor(capture.launched, 1600, 1000)
    }
    await openThread(page, 'Split AgentControl')
    await everySize('shell-thread', 'A finished thread with a full sidebar and Needs you standing.')
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    // Focus holds a row's shortcuts open through the shoot, which a pointer's hover does not survive.
    await page.keyboard.press('Tab')
    await sidebar.getByRole('button', { name: 'Plan the split', exact: true }).first().focus()
    await capture.shoot('shell-row-focus', 'The keyboard on a working row, with its shortcuts showing.', '', { modes: ['dark', 'light'] })
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    // A header symbol the keys reach is named under it, as the pointer's tooltip names it.
    const headerFocus = async (): Promise<void> => {
      await page.keyboard.press('Tab')
      await page.locator('.thread-pane[data-focused] [data-pane-terminal-toggle]').focus()
      await expect(page.locator('.focus-name')).toBeVisible()
    }
    await capture.shoot('shell-header-focus', 'The keyboard on the Terminal drawer button, named under the header.', '', { modes: ['dark', 'light'], before: headerFocus })
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    // An icon of the sidebar's foot the keys reach is named over the foot.
    const footFocus = async (): Promise<void> => {
      await page.keyboard.press('Tab')
      await sidebar.locator('.thread-nav__foot .thread-nav__page[href="#settings"]').focus()
      await expect(page.locator('.focus-name')).toBeVisible()
    }
    await capture.shoot('shell-foot-focus', 'The keyboard on Settings in the sidebar foot, named over the foot.', '', { modes: ['dark', 'light'], before: footFocus })
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    // The row may sit faded at the list's edge, where it takes no presses, so it comes to the middle and is pointed at first.
    const review = sidebar.getByRole('button', { name: 'Repository review', exact: true }).first()
    await review.evaluate(element => element.scrollIntoView({ block: 'center' }))
    await review.hover({ position: { x: 16, y: 12 } })
    await page.getByRole('button', { name: 'Open Repository review beside', exact: true }).click()
    await expect(page.getByRole('separator', { name: 'Resize panes', exact: true })).toBeVisible()
    await everySize('shell-split', 'Two threads side by side, with the sidebar full.')
    await setAppearance(page, { appearance: 'dark', lightTheme: 'clay', darkTheme: 'clay' }, 'dark')
    await everySize('shell-split-clay', 'The same on the Clay theme.')
    await setAppearance(page, { appearance: 'dark', lightTheme: DEFAULT_THEME_ID, darkTheme: DEFAULT_THEME_ID }, 'dark')
  } },
  // Below a 1000 pixel window the rail stands and Expand opens the whole sidebar over the thread (ADR-0110, November 5,
  // 2026); and a waiting thread's row reads In Needs you, lighting its entry under the pointer (ADR-0135, the same day).
  { name: 'sidebar-narrow', covers: ['sidebar-rail-narrow', 'sidebar-rail-focus', 'sidebar-over', 'sidebar-over-clay', 'needs-you-peer', 'needs-you-peer-entry'], run: async capture => {
    const { page } = capture
    // A waiting thread on screen, so the list centres on its folder, where another waiting thread's row stands.
    await openThread(page, 'Visual gate flake')
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    // Pointing at a waiting thread's row in its folder lights its entry in Needs you, and the other way round.
    const queued = sidebar.locator('.thread-nav__row[data-in-queue]').filter({ hasText: 'Streaming WAV stall' })
    await expect(queued).toContainText('In Needs you')
    // The shoot brings the open thread's row to the list's middle after this runs, so the list is put there first and the
    // pointer stays on the row it points at.
    const pointAt = (target: Locator) => async (): Promise<void> => {
      await page.evaluate(() => {
        const list = document.querySelector('.thread-nav__scroll'), open = list?.querySelector('[aria-current="page"]')
        if (list && open) list.scrollTop += open.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - open.clientHeight) / 2
      })
      await target.hover({ position: { x: 40, y: 12 } })
    }
    await capture.shoot('needs-you-peer', 'The pointer on a waiting thread\'s row, which reads In Needs you, and its entry in Needs you lit.', '', { before: pointAt(queued) })
    const id = await queued.getAttribute('data-in-queue')
    await capture.shoot('needs-you-peer-entry', 'The pointer on an entry in Needs you, and its thread\'s row lit in its folder.', '', { modes: ['dark'], before: pointAt(sidebar.locator(`.needs-you__entry[data-entry-id="${id}"]`)) })
    await page.mouse.move(0, 0)
    await openThread(page, 'Split AgentControl')
    for (const [width, height] of [[1000, 700], [999, 700], [820, 560]] as const) {
      await resizeContentWindowFor(capture.launched, width, height)
      await capture.shoot('sidebar-rail-narrow', width < 1000 ? 'Below a 1000 pixel window the sidebar stands as the rail and the thread takes the rest.' : 'At 1000 the sidebar stands beside the thread, as at every wider window.', '', { modes: ['dark'], size: [width, height] })
    }
    // A tile the keys reach is named beside the rail, as the pointer's tooltip names it.
    const railFocus = async (): Promise<void> => {
      await page.keyboard.press('Tab')
      await sidebar.locator('.thread-nav__rail-thread[data-rail-thread]').nth(1).focus()
      await expect(page.locator('.focus-name')).toBeVisible()
    }
    await capture.shoot('sidebar-rail-focus', 'The keyboard on a rail tile at the minimum window, its thread named beside the rail.', '', { modes: ['dark', 'light'], size: [820, 560], before: railFocus })
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    // Expand opens the whole sidebar over the thread, which has not moved.
    const open = async (): Promise<void> => {
      if (await page.locator('aside.thread-nav[data-over]').count()) return
      await sidebar.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Thread sidebar' })).toBeVisible()
    }
    await open()
    await capture.shoot('sidebar-over', 'Expand pressed at the minimum window: the whole sidebar over the thread, the thread dimmed and unmoved behind it.', '', { size: [820, 560], before: open })
    await resizeContentWindowFor(capture.launched, 999, 700)
    await capture.shoot('sidebar-over', 'The same just under the 1000 pixel line.', '', { modes: ['dark'], size: [999, 700], before: open })
    await setAppearance(page, { appearance: 'dark', lightTheme: 'clay', darkTheme: 'clay' }, 'dark')
    await resizeContentWindowFor(capture.launched, 820, 560)
    await capture.shoot('sidebar-over-clay', 'The sidebar over the thread on the Clay theme.', '', { size: [820, 560], before: open })
    await setAppearance(page, { appearance: 'dark', lightTheme: DEFAULT_THEME_ID, darkTheme: DEFAULT_THEME_ID }, 'dark')
    await page.keyboard.press('Escape')
    await expect(page.locator('aside.thread-nav[data-over]')).toHaveCount(0)
    await resizeContentWindowFor(capture.launched, 1600, 1000)
  } },
  // A busier hour: five threads wait, three holding an agent still and two whose last turn failed, so Needs you meets its
  // caps and the collapsed rail has a project tray of waiting threads (Zach's picks C, ADR-0135 and ADR-0146, November 5,
  // 2026). The two newer requests carry the times they were asked, which the host keeps as their stamps, on the renderer's
  // held clock; the failure is the host's to stamp. They are taken away again at the end.
  { name: 'needs-you-five', covers: ['needs-you-five-hover', 'needs-you-five-keys', 'needs-you-five-glass', 'needs-you-five-citrine', 'needs-you-five-over', 'sidebar-rail-five', 'sidebar-rail-five-glass', 'sidebar-rail-five-graphite', 'sidebar-rail-five-focus'], run: async capture => {
    const { page } = capture
    const bump = evidenceThread('background-2'), rows = evidenceThread('background-3'), translate = evidenceThread('background-4')
    const asked = (minutes: number): string => new Date(E2E_THREADS_NOW - minutes * 60_000).toISOString()
    await page.evaluate(async ({ bump, rows, translate, bumpAt, rowsAt }) => {
      const send = window.sottoE2E!.agentEvent!
      await send({ type: 'failure', threadId: translate, text: 'The Spanish catalog did not compile: three strings in Settings have placeholders that do not match the English ones.' })
      const command = 'Run a command in sotto\nnpm run notices:verify'
      await send({ type: 'permission', threadId: bump, text: command, status: 'running', request: { id: 'bump-notices', kind: 'permission', text: command, options: [], since: bumpAt } })
      const ask = 'The row actions still clip at 820 wide when a host badge shows. Should the badge drop its name, or the actions move under the title?'
      await send({ type: 'question', threadId: rows, text: ask, status: 'running', request: { id: 'rows-badge', kind: 'question', text: ask, options: [], since: rowsAt } })
    }, { bump: bump.id, rows: rows.id, translate: translate.id, bumpAt: asked(26), rowsAt: asked(4) })
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    const card = sidebar.locator('.needs-you')
    // The waits go again however the state ends, so a state that stops part-way still leaves the next one the sidebar it always has.
    try {
      await expect(card.locator('.needs-you__entry')).toHaveCount(5)
      await expect(card).toContainText('longest wait 26 min')
      await openThread(page, 'Repository review')
      await capture.shoot('needs-you-five', 'Five threads wait: two approvals and a question lead, each with Answer, and two failed turns rest under them in muted words.')
      await capture.shoot('needs-you-five', 'The same at a narrower window.', '', { modes: ['dark'], size: [1280, 800] })
      // The pointer on a failed turn brings its Dismiss and Show why, and on the heading Dismiss 2 failed.
      const failed = card.locator('.needs-you__entry[data-rest]').first()
      await capture.shoot('needs-you-five-hover', 'The pointer on a failed turn in Needs you, with its Dismiss and Show why.', '', { modes: ['dark', 'light'], before: async () => { await failed.hover({ position: { x: 40, y: 10 } }) } })
      const keys = async (): Promise<void> => {
        await page.keyboard.press('Tab')
        await card.getByRole('button', { name: /^Dismiss Needs attention on 2 threads$/u }).focus()
      }
      await capture.shoot('needs-you-five-keys', 'The keyboard on Dismiss 2 failed, which takes the longest wait\'s place in the heading.', '', { modes: ['dark'], before: keys })
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await setAppearance(page, { appearance: 'dark', lightTheme: 'glass', darkTheme: 'glass' }, 'dark')
      await capture.shoot('needs-you-five-glass', 'The five waiting threads on Glass.', '', { modes: ['dark', 'light'] })
      await setAppearance(page, { appearance: 'dark', lightTheme: 'citrine', darkTheme: 'citrine' }, 'dark')
      await capture.shoot('needs-you-five-citrine', 'The five waiting threads on Citrine.', '', { modes: ['dark', 'light'] })
      await setAppearance(page, { appearance: 'dark', lightTheme: DEFAULT_THEME_ID, darkTheme: DEFAULT_THEME_ID }, 'dark')
      // The rail at the minimum window: a tray for each project's waiting and moving threads, and the resting ones at the foot.
      await openThread(page, 'Split AgentControl')
      await capture.shoot('sidebar-rail-five', 'The collapsed rail at the minimum window with five threads waiting: provider marks, a tray for each project under its name.', '', { modes: ['dark', 'light'], size: [820, 560] })
      for (const [theme, state] of [['glass', 'sidebar-rail-five-glass'], ['graphite', 'sidebar-rail-five-graphite']] as const) {
        await setAppearance(page, { appearance: 'dark', lightTheme: theme, darkTheme: theme }, 'dark')
        await capture.shoot(state, `The same rail on ${theme === 'glass' ? 'Glass' : 'Graphite'}.`, '', { modes: ['dark', 'light'], size: [820, 560] })
      }
      await setAppearance(page, { appearance: 'dark', lightTheme: DEFAULT_THEME_ID, darkTheme: DEFAULT_THEME_ID }, 'dark')
      const railFocus = async (): Promise<void> => {
        await page.keyboard.press('Tab')
        await sidebar.locator('.thread-nav__rail-project').nth(1).locator('.thread-nav__rail-thread').first().focus()
        await expect(page.locator('.focus-name')).toBeVisible()
      }
      await capture.shoot('sidebar-rail-five-focus', 'The keyboard on a tile in the second project\'s tray, its thread, project and status named beside the rail.', '', { modes: ['dark', 'light'], size: [820, 560], before: railFocus })
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      const over = async (): Promise<void> => {
        if (await page.locator('aside.thread-nav[data-over]').count()) return
        await sidebar.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
        await expect(page.getByRole('dialog', { name: 'Thread sidebar' })).toBeVisible()
      }
      await capture.shoot('needs-you-five-over', 'The whole sidebar over the thread at the minimum window, with the five waiting threads in Needs you.', '', { size: [820, 560], before: over })
      await page.keyboard.press('Escape')
      await resizeContentWindowFor(capture.launched, 1600, 1000)
    } finally {
      await page.evaluate(async threads => {
        for (const thread of threads) await window.sottoE2E!.agentEvent!({ type: 'history', threadId: thread.id, text: '', status: 'idle', messages: thread.messages })
      }, [bump, rows, translate].map(thread => ({ id: thread.id, messages: [...thread.messages] })))
      await expect(card.locator('.needs-you__entry')).toHaveCount(2)
    }
  } },
  // Asked for by name only: a scrolled sidebar with its folder's head stuck at the top, and a row passing under the head's
  // edge at each part of its height: only its padding under, its name under, both its lines under. The current row and a
  // working one pass under too, on the default theme, Glass and Clay.
  { name: 'sidebar-stuck-head', covers: [], run: async capture => {
    const { page } = capture
    await openThread(page, 'Write the split plan down')
    // The list scrolled so the stuck head's edge lies `into` pixels below the named row's top.
    const under = (title: string, into: number) => async (): Promise<void> => {
      await page.mouse.move(0, 0)
      await page.evaluate(({ title, into }) => {
        const list = document.querySelector<HTMLElement>('.thread-nav__scroll')!
        const row = [...list.querySelectorAll<HTMLElement>('.thread-folder__rows .thread-nav__row')].find(item => item.querySelector('.thread-nav__item')?.getAttribute('aria-label') === title)!
        const edge = Number.parseFloat(getComputedStyle(list).getPropertyValue('--folder-head-edge')) || 35
        list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - edge + into
      }, { title, into })
    }
    const shoot = (state: string, shows: string, title: string, into: number, modes: readonly Mode[] = MODES, size?: readonly [number, number]): Promise<void> =>
      capture.shoot(state, shows, '', { modes, before: under(title, into), keepSidebarScroll: true, ...size ? { size } : {} })
    await shoot('stuck-head-padding', 'The sidebar scrolled so only the top padding of "Fix the socket host flake" is under the stuck head of sotto.', 'Fix the socket host flake', 5)
    await shoot('stuck-head-name', 'The same row scrolled on until the head\'s edge crosses its name.', 'Fix the socket host flake', 14)
    await shoot('stuck-head-words', 'The same row scrolled on until the head\'s edge crosses its second line.', 'Fix the socket host flake', 36)
    await shoot('stuck-head-name', 'Its name under the head at a narrower window.', 'Fix the socket host flake', 14, ['dark'], [1280, 800])
    await shoot('stuck-head-working', 'A working row, "Plan the split", with its name under the head.', 'Plan the split', 14)
    await shoot('stuck-head-current', 'The open thread\'s row, "Write the split plan down", with its name under the head.', 'Write the split plan down', 14)
    // The list scrolled so the next folder has pushed a stuck head `by` pixels up, the moment a head was once drawn cut
    // through under Needs you.
    const pushed = (folder: string, by: number) => async (): Promise<void> => {
      await page.mouse.move(0, 0)
      await page.evaluate(({ folder, by }) => {
        const list = document.querySelector<HTMLElement>('.thread-nav__scroll')!
        const box = [...list.querySelectorAll<HTMLElement>('.thread-folder')].find(item => item.querySelector('.thread-folder__title')?.textContent === folder)!
        const edge = Number.parseFloat(getComputedStyle(list).getPropertyValue('--folder-head-edge')) || 35
        list.scrollTop += box.getBoundingClientRect().bottom - list.getBoundingClientRect().top - (edge - 1) + by
      }, { folder, by })
    }
    await capture.shoot('stuck-head-push', 'The sidebar scrolled so the workshop folder\'s last row is gone under its head and sotto pushes the head 14px up.', '', { before: pushed('workshop', 14), keepSidebarScroll: true })
    // And the foot: a row whose bottom is `by` pixels under the band over the sidebar's foot.
    const footCut = (title: string, by: number) => async (): Promise<void> => {
      await page.mouse.move(0, 0)
      await page.evaluate(({ title, by }) => {
        const list = document.querySelector<HTMLElement>('.thread-nav__scroll')!
        const row = [...list.querySelectorAll<HTMLElement>('.thread-folder__rows .thread-nav__row')].find(item => item.querySelector('.thread-nav__item')?.getAttribute('aria-label') === title)!
        list.scrollTop += row.getBoundingClientRect().bottom - (list.getBoundingClientRect().bottom - 7) - by
      }, { title, by })
    }
    await capture.shoot('list-foot-name', 'The sidebar scrolled so "Weekly note", a working row, has its second line under the band over the foot.', '', { before: footCut('Weekly note', 20), keepSidebarScroll: true })
    await capture.shoot('list-foot-padding', 'The same row with only its bottom padding under the band.', '', { modes: ['dark'], before: footCut('Weekly note', 2), keepSidebarScroll: true })
    for (const theme of ['glass', 'clay'] as const) {
      await setAppearance(page, { appearance: 'dark', lightTheme: theme, darkTheme: theme }, 'dark')
      const name = theme === 'glass' ? 'Glass' : 'Clay'
      await shoot(`stuck-head-name-${theme}`, `A row's name under the stuck head on ${name}.`, 'Fix the socket host flake', 14)
      await shoot(`stuck-head-words-${theme}`, `A row's second line under the stuck head on ${name}.`, 'Fix the socket host flake', 36)
      await shoot(`stuck-head-current-${theme}`, `The open thread's row with its name under the stuck head on ${name}.`, 'Write the split plan down', 14)
    }
    await setAppearance(page, { appearance: 'dark', lightTheme: DEFAULT_THEME_ID, darkTheme: DEFAULT_THEME_ID }, 'dark')
  } },
  // Asked for by name only: where the thread list comes to rest. From the top it is scrolled by the wheel in uneven steps,
  // set by the app's own kind of scroll (a scrollTop the way a restore would), and walked by the keys, and at each rest
  // the top of the list is cut out under the stuck head and laid in one sheet per theme and mode, each labelled with how
  // the scroll got there and where the first row lies against the head's edge. Then the end of the list, past every row.
  { name: 'sidebar-rest', covers: [], run: async capture => {
    const { page } = capture
    const out = resolve(OUT!)
    await openThread(page, 'Write the split plan down')
    const list = page.locator('.thread-nav__scroll')
    const still = async (): Promise<number> => {
      let last = Number.NaN, same = 0
      for (let tries = 0; tries < 60 && same < 4; tries += 1) {
        await page.waitForTimeout(100)
        const at = await list.evaluate(element => element.scrollTop)
        same = at === last ? same + 1 : 0
        last = at
      }
      return last
    }
    /** Where the first row the head does not wholly cover lies against the head's edge: 0 is right at it, under 0 cut. */
    const edge = (): Promise<{ readonly scrollTop: number; readonly head: string; readonly row: string; readonly offset: number }> => list.evaluate(element => {
      const top = element.getBoundingClientRect().top
      const stuck = [...element.querySelectorAll<HTMLElement>('.thread-folder__head')].find(head => {
        const box = head.getBoundingClientRect()
        return box.top - top <= 6.5 && box.bottom - top > 0
      })
      const line = stuck === undefined ? top + 6 : stuck.getBoundingClientRect().bottom
      const row = [...element.querySelectorAll<HTMLElement>('.thread-folder__rows > .thread-nav__row, .thread-nav__settled, .thread-folder__head')]
        .filter(item => item !== stuck && item.getBoundingClientRect().height > 0)
        .find(item => item.getBoundingClientRect().bottom > line + 0.5)
      return {
        scrollTop: Math.round(element.scrollTop),
        head: stuck?.querySelector('.thread-folder__title')?.textContent ?? '',
        row: row?.querySelector('.thread-nav__item')?.getAttribute('aria-label') ?? row?.textContent?.trim().slice(0, 32) ?? '',
        offset: row === undefined ? 0 : Math.round((row.getBoundingClientRect().top - line) * 10) / 10,
      }
    })
    const sheet = async (file: string, cells: readonly { readonly image: Buffer; readonly label: string }[]): Promise<void> => {
      const first = await sharp(cells[0]!.image).metadata()
      const width = first.width!, height = first.height!, label = 34, across = 5
      const rows = Math.ceil(cells.length / across)
      const escape = (text: string): string => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;')
      const parts = await Promise.all(cells.map(async (cell, index) => {
        const x = (index % across) * (width + 12), y = Math.floor(index / across) * (height + label + 12)
        const [one, two] = cell.label.split('\n')
        const text = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${label}"><rect width="100%" height="100%" fill="#202020"/><text x="6" y="14" font-family="Segoe UI, sans-serif" font-size="12" fill="#f2f2f2">${escape(one ?? '')}</text><text x="6" y="29" font-family="Segoe UI, sans-serif" font-size="12" fill="${(two ?? '').includes('cut') ? '#ff8a80' : '#9be7a1'}">${escape(two ?? '')}</text></svg>`)
        return [{ input: cell.image, left: x, top: y }, { input: text, left: x, top: y + height }]
      }))
      await sharp({ create: { width: across * (width + 12) - 12, height: rows * (height + label + 12) - 12, channels: 3, background: '#808080' } })
        .composite(parts.flat()).png().toFile(join(out, file))
    }
    const record: Record<string, unknown[]> = {}
    for (const [theme, name, mode, size] of [[DEFAULT_THEME_ID, 'sotto', 'dark', [1600, 1000]], [DEFAULT_THEME_ID, 'sotto', 'light', [1600, 1000]], [DEFAULT_THEME_ID, 'sotto', 'dark', [1280, 800]],
      ['glass', 'glass', 'dark', [1600, 1000]], ['glass', 'glass', 'light', [1600, 1000]]] as const) {
      await resizeContentWindowFor(capture.launched, size[0], size[1])
      await setAppearance(page, { appearance: mode, lightTheme: theme, darkTheme: theme }, mode)
      await page.mouse.move(0, 0)
      const box = (await list.boundingBox())!
      const clip = { x: 0, y: Math.round(box.y) - 2, width: Math.round(box.x + box.width) + 1, height: 250 }
      const cells: { image: Buffer; label: string }[] = [], facts: unknown[] = []
      const take = async (how: string): Promise<void> => {
        await still()
        const at = await edge()
        facts.push({ how, ...at })
        cells.push({ image: await page.screenshot({ clip }), label: `${how} · rests at ${at.scrollTop}\n${at.offset < -0.5 ? `cut ${-at.offset}px` : `whole, ${at.offset}px under the edge`}: ${at.row.slice(0, 26)}` })
      }
      await list.evaluate(element => { element.scrollTop = 0 })
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      for (const step of [23, 41, 67, 100, 19, 133, 58, 250, 37, 90, 171]) {
        await page.mouse.wheel(0, step)
        await take(`wheel +${step}`)
      }
      for (const set of [212, 389, 517, 640]) {
        await list.evaluate((element, to) => { element.scrollTop = to }, set)
        await take(`scrollTop = ${set}`)
      }
      await list.evaluate(element => { element.scrollTop = 0 })
      await page.mouse.move(0, 0)
      await page.locator('.thread-nav__list [aria-current="page"]').focus()
      for (const presses of [6, 6, 6]) {
        for (let press = 0; presses > press; press += 1) await page.keyboard.press('ArrowDown')
        await take(`Down x${presses}`)
      }
      await page.keyboard.press('End')
      await take('End key')
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.wheel(0, 5000)
      await take('wheel to the end')
      await page.mouse.wheel(0, -77)
      await take('wheel -77')
      await page.mouse.move(0, 0)
      const file = `sidebar-rest-${name}-${mode}-${size[0]}.png`
      await sheet(file, cells)
      record[file] = facts
      manifest.set(file, { file, state: 'sidebar-rest', shows: `The top of the thread list at ${cells.length} resting scrolls on ${name === 'glass' ? 'Glass' : 'the default theme'} by ${mode === 'dark' ? 'night' : 'day'}, each labelled with how it got there and where its first row lies against the stuck head's edge.`, differs: '', bounds: [] })
    }
    await writeFile(join(out, 'sidebar-rest.json'), `${JSON.stringify(record, null, 1)}\n`)
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await setAppearance(page, { appearance: 'dark', lightTheme: DEFAULT_THEME_ID, darkTheme: DEFAULT_THEME_ID }, 'dark')
  } },
  // Asked for by name only: the sidebar's resting rows on one line and its working and waiting rows on two (Zach's pick C,
  // ADR-0135, November 5, 2026), at every size, under the pointer and the keys, with a thread just finished, on Glass and
  // Clay, and under reduced motion.
  { name: 'sidebar-rows', covers: [], run: async capture => {
    const { page } = capture
    await openThread(page, 'Repository review')
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    for (const size of [[1600, 1000], [1280, 800]] as const) await capture.shoot('sidebar-rows', 'A finished thread open, its resting rows one line each and its working and waiting rows two.', '', { size })
    const over = async (): Promise<void> => {
      if (await page.locator('aside.thread-nav[data-over]').count()) return
      await sidebar.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Thread sidebar' })).toBeVisible()
    }
    await capture.shoot('sidebar-rows', 'The same sidebar over the thread at the minimum window.', '', { size: [820, 560], before: over })
    await page.keyboard.press('Escape')
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    // By its button's name: the row's own words are cut at a word's end where the name does not fit.
    const resting = sidebar.locator('.thread-nav__row[data-steps-back]', { has: page.getByRole('button', { name: 'Write the split plan down', exact: true }) })
    // The shoot brings the open thread's row to the list's middle after this runs, so the list is put there first and the
    // pointer stays on the row it points at.
    const pointAt = async (): Promise<void> => {
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur()
        const list = document.querySelector('.thread-nav__scroll'), open = list?.querySelector('[aria-current="page"]')
        if (list && open) list.scrollTop += open.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - open.clientHeight) / 2
      })
      await resting.hover({ position: { x: 40, y: 12 } })
      await page.waitForTimeout(200)
    }
    await capture.shoot('sidebar-rows-hover', 'The pointer on a resting row: its provider\'s mark where the ring would be and its shortcuts in its time\'s place.', '', { before: pointAt })
    const keys = async (): Promise<void> => {
      await page.mouse.move(0, 0)
      await page.keyboard.press('Tab')
      await resting.getByRole('button', { name: 'Write the split plan down', exact: true }).focus()
    }
    await capture.shoot('sidebar-rows-keys', 'The keyboard on the same resting row.', '', { before: keys })
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    for (const theme of ['glass', 'clay'] as const) {
      await setAppearance(page, { appearance: 'dark', lightTheme: theme, darkTheme: theme }, 'dark')
      await capture.shoot(`sidebar-rows-${theme}`, `The same rows on ${theme === 'glass' ? 'Glass' : 'Clay'}.`)
      await capture.shoot(`sidebar-rows-${theme}-hover`, `The pointer on a resting row on ${theme === 'glass' ? 'Glass' : 'Clay'}.`, '', { modes: ['dark'], before: pointAt })
    }
    await setAppearance(page, { appearance: 'dark', lightTheme: DEFAULT_THEME_ID, darkTheme: DEFAULT_THEME_ID }, 'dark')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await capture.shoot('sidebar-rows-still', 'The same rows under reduced motion: the working rings hold still.', '', { modes: ['dark'], before: keys })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    // Last, since the finish moves the thread to the top of its folder: a thread that finishes out of sight is news, so its row keeps its two lines and says Just finished.
    const bump = evidenceThread('background-2')
    await page.evaluate(async id => {
      const send = window.sottoE2E!.agentEvent!
      await send({ type: 'ready', threadId: id, status: 'running', text: '' })
      await send({ type: 'ready', threadId: id, status: 'idle', text: 'Done.' })
    }, bump.id)
    try {
      await expect(sidebar.locator('.thread-nav__row').filter({ hasText: bump.title })).toContainText('Just finished')
      await capture.shoot('sidebar-rows-finished', 'A thread that finished out of sight keeps two lines and says Just finished; the rows at rest around it take one.')
    } finally {
      await page.evaluate(async id => { await window.sotto!.agents!.command({ type: 'select-thread', threadId: id }) }, bump.id)
      await openThread(page, 'Repository review')
    }
  } },
  // Asked for by name only: the pages at the smaller sizes, and a thread and Help on a theme other than the default. Usage
  // at the smaller sizes is captureConnectedUsage's.
  { name: 'shell-check', covers: [], run: async capture => {
    const { page } = capture
    const pages = [['Help', 'help'], ['Settings', 'settings']] as const
    for (const [link, state] of pages) {
      await openThreads(page)
      await page.getByRole('link', { name: link, exact: true }).click()
      await page.waitForTimeout(800)
      for (const size of SMALLER_SIZES) await capture.shoot(`${state}-sizes`, `The ${link} page at a smaller window.`, '', { modes: ['dark'], size })
      await resizeContentWindowFor(capture.launched, 1600, 1000)
    }
    await openThreads(page)
    await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Dictate', exact: true }).click()
    for (const size of SMALLER_SIZES) await capture.shoot('dictate-sizes', 'The Dictate room at a smaller window.', '', { modes: ['dark'], size })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await openThreads(page)
    await openThread(page, 'Repository review')
    await setAppearance(page, { appearance: 'dark', lightTheme: 'clay', darkTheme: 'clay' }, 'dark')
    await capture.shoot('thread-clay', 'A finished thread on the Clay theme.')
    await setAppearance(page, { appearance: 'dark', lightTheme: DEFAULT_THEME_ID, darkTheme: DEFAULT_THEME_ID }, 'dark')
  } },
]

const BY_NAME_ONLY = ['shell-check', 'model-menu', 'header-press', 'shell-surface', 'pr-every', 'sidebar-stuck-head', 'sidebar-rest', 'sidebar-rows']
const wanted = (state: { readonly name: string; readonly covers: readonly string[] }): boolean => ONLY ? ONLY.includes(state.name) || state.covers.some(name => ONLY.includes(name)) : !BY_NAME_ONLY.includes(state.name)

async function runState(name: string, run: () => Promise<void>): Promise<void> {
  try { await run() } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`) }
}

const COMMON_DIFFERENCES = [
  'Two runs of one build, compared with a noise floor of 6 per channel: every composer crop and box the same, and 49 of 54 windows the same. The rest are 10 to 67 stray pixels (a sidebar status dot, a header icon, a message edge) and Usage, whose prompt count can read 29 or 30, depending on when a send\'s record is counted.',
  'There is no Studio page in this build, so none is captured, and Memory is gated off.',
  'Sotto Owl: the real Owl track at version 0.1.37-owl.20261012.1, so Owl features are on as on the owner\'s builds.',
  'The provider is the fake host the end-to-end suite uses: threads, messages and activity records are data it was told, through the real coordinator, IPC and renderer.',
  'The renderer\'s clock is held at July 12, 2026, 19:41 UTC, in America/Los_Angeles, and Math.random always answers 0.37. Main\'s clock runs from the same era; each thread\'s record was told at its own time.',
  'The working line keeps its first word, because its 3.8-second word timer is held. Infinite animations are held at 0.9 s, and the sidebar sky\'s twinkle is off, as an Owl capture elsewhere does.',
  'The click effect is off and the window is rendered with --disable-gpu at scale 1, as the design captures run. The operating system\'s title bar is not in the image; the window draws its own strip.',
  'Sidebar threads beyond the named ones are the design fixture\'s and short finished ones. Project "sotto" is a real repository in the temporary folder holding only part of the tree.',
]

/**
 * Usage as it reads for someone whose Claude Code and Codex are on this computer: two weeks of their records outside Sotto,
 * one thread in Sotto and Claude's limits. These are the `usage` and `usage-sizes` states: the main launch's fake provider
 * host keeps no records and reads no limits, so its page, `usage-no-records`, shows only the prompts that run sent.
 * Everything here is data: Claude Code's transcripts and a Codex CLI rollout in the harness's own home, read by the real
 * importer, and the scripted Claude client's answers.
 */
/** The Watcher room states with its controls in use: run together, on their own launch. */
const WATCHER_CONTROLS = ['watcher-controls', 'watcher-answered-hover', 'watcher-way-tip', 'watcher-new']

/**
 * Watcher's room an afternoon into its work (`seedWatcherControls`): answers to news with their work in the header, two
 * replies seconds apart, a watched thread's question answered on its card, Stop all with two threads to stop and Move
 * threads with forge connected; then the pointer on the answered line and on the way off the page, and two replies
 * arriving while the reader is back up the conversation.
 */
async function captureWatcherControls(out: string): Promise<void> {
  const repository = await buildEvidenceRepository()
  await withSotto({ onboardingComplete: true, appearance: 'dark', scenario: 'design-threads', agents: 'design-threads' }, async launched => {
    const { page } = launched
    await freezeMain(launched)
    await freezeRenderer(page)
    await resizeContentWindowFor(launched, 1600, 1000)
    const seeded = await seedWatcherControls(page)
    await page.evaluate(async request => window.sottoE2E!.agentEvent!({ type: 'question', threadId: 'grok-previews', text: request.text, request, status: 'running' }), VOICE_QUESTION)
    await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Watcher' })).toBeAttached()
    const pane = page.locator('#watcher-pane')
    const log = pane.getByRole('log', { name: 'Thread transcript' })
    // The user's own answer, on the card in Watcher's conversation: four voices, a length and where the key lives.
    const card = pane.getByRole('region', { name: 'Question from Grok voice previews' })
    await expect(card).toBeVisible()
    for (const voice of ['Ara', 'Rex', 'Eve', 'Leo']) await card.getByRole('checkbox', { name: voice }).click()
    await card.getByRole('radio', { name: 'Two seconds' }).click()
    await card.getByRole('radio', { name: 'System keychain' }).click()
    await card.getByRole('button', { name: 'Send answers' }).click()
    const answered = pane.locator('.watcher-ask-receipt')
    await expect(answered).toBeVisible()
    await log.evaluate(element => { element.scrollTop = element.scrollHeight })
    const room = captureFor(launched, repository, out)
    const scene = 'Watcher itself is the stand-in the watcher specs seed, and its scene is held by the design-threads clock with every owl sitting. The question was answered on its card by this run\'s own presses.'
    const shows = 'Watcher\'s room an afternoon in: answers to news with their work folded in, two replies seconds apart, a watched thread\'s question answered on its card, Stop all and Move threads in the header.'
    await room.shoot('watcher-controls', shows, scene)
    for (const size of SMALLER_SIZES) await room.shoot('watcher-controls', shows, scene, { size })
    const onAnswered = async (): Promise<void> => {
      await answered.scrollIntoViewIfNeeded()
      const box = (await answered.boundingBox())!
      await page.mouse.move(box.x + Math.min(120, box.width / 3), box.y + box.height / 2)
      await page.waitForTimeout(400)
    }
    await room.shoot('watcher-answered-hover', 'The pointer on the line that replaced the answered card.', scene, { before: onAnswered })
    const onSettings = async (): Promise<void> => {
      // The row of icons stands in Watcher's footer at the bottom left (ADR-0152's Watcher footer), not in its header.
      const link = page.locator('.watcher-foot .thread-nav__page[href="#settings"]')
      const box = (await link.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForTimeout(900)
    }
    await room.shoot('watcher-way-tip', 'The pointer resting on Settings in the footer\'s row of icons.', scene, { before: onSettings })
    // Back up the conversation, then two replies arrive.
    await page.mouse.move(0, 0)
    await log.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')) })
    await page.waitForTimeout(300)
    await page.evaluate(async ({ at, messages, activities }) => {
      await window.sottoE2E!.agentEvent!({ type: 'history', threadId: 'release-notes', text: '', status: 'idle', activities, messages: [...messages,
        { id: 'c-6', role: 'assistant', text: 'Footer links’ checks passed. It is ready to merge once you say so.', createdAt: at[0]! },
        { id: 'c-7', role: 'assistant', text: 'Weekly note finished the Friday wrap. It is in notes/weekly.md.', createdAt: at[1]! }] })
    }, { at: [minutesAgo(1), minutesAgo(0)], messages: [...seeded.messages], activities: [...seeded.activities] })
    await expect(pane.locator('.thread-transcript__jump[data-unseen]')).toBeVisible()
    const shown = 'Two replies arrived while the reader was back at the top of Watcher\'s conversation.'
    await room.shoot('watcher-new', shown, scene)
    for (const size of SMALLER_SIZES) await room.shoot('watcher-new', shown, scene, { size })
  })
}

async function captureConnectedUsage(out: string): Promise<void> {
  const harness = await usageDashboardHarness()
  const shows = 'The Usage page for someone using Claude Code and Codex: fourteen days of their own records, seven models, one thread in Sotto, and Claude\'s limits.'
  const differs = 'Production main over an isolated home on the real clock, not the fixture era. The records are the usage-dashboard spec\'s invented history, read by the real importer; Claude Code is the scripted client, which answers get_usage with 18% of five hours and 46% of the week used. No other provider is connected, so only Claude has limits.'
  try {
    const seeded = await seedUsageHistory(harness.home)
    const resetsAt = Date.now() + 3 * 3_600_000
    await writeFile(join(harness.client, 'usage-script.json'), JSON.stringify({ rate_limits: {
      five_hour: { utilization: 18, resets_at: new Date(resetsAt).toISOString() },
      seven_day: { utilization: 46, resets_at: new Date(resetsAt + 2 * 86_400_000).toISOString() } } }))
    const page = await harness.launch()
    await harness.connect()
    await page.evaluate(async path => {
      const agents = window.sotto!.agents!
      const created = await agents.command({ type: 'create-project', provider: 'claude', title: 'sotto', path, useExisting: true })
      if (created.error) throw new Error(created.error)
      const state = await agents.get()
      const project = state.host.projects.find(value => value.title === 'sotto')!
      const model = state.host.models.find(value => value.providerId === 'claude' && value.ready)!
      const result = await agents.command({ type: 'create-thread', projectId: project.id, title: 'Measure the store worker', titleSource: 'user', modelId: model.id,
        workingCopy: 'shared', runtimeMode: 'approval-required' })
      if (result.error) throw new Error(result.error)
      await agents.command({ type: 'select-thread', threadId: result.activeThreadId! })
    }, harness.project)
    await openThreads(page)
    await expect(promptField(page)).toBeEditable()
    await fillPrompt(promptField(page), 'Measure how long the store worker takes to answer a read.')
    await page.getByRole('button', { name: 'Send prompt', exact: true }).click()
    const nativeId = await waitForNativePrompt(harness, 1)
    await harness.action(nativeId, { type: 'raw', persist: true, frame: usageAssistantFrame(nativeId, 'evidence-store-worker', 1_400) })
    await harness.action(nativeId, { type: 'raw', frame: usageResultFrame(nativeId) })
    await expect.poll(async () => (await harness.activity()).totals.prompts.total, usageWait).toBe(seeded + 1)
    await harness.open()
    const measures = page.getByRole('tablist', { name: 'Usage measures', exact: true })
    await expect(measures.getByRole('tab', { name: /^Room left \d+% /u })).toBeVisible(usageWait)
    /** The image first, then the harness's own checks (nothing overflows or clips, text at 4.5:1), whose failure is reported. */
    const shoot = async (file: string, width: number, height: number, mode: Mode, what = shows): Promise<void> => {
      await harness.appearance(mode); await harness.resize(width, height)
      await writeFile(join(out, file), await page.screenshot({ animations: 'disabled' }))
      const state = file.startsWith('usage-sizes-') ? 'usage-sizes' : 'usage'
      manifest.set(file, { file, state, shows: what, differs, bounds: [] })
      try { await harness.capture(out, file, width, height, mode) } catch (error) { failures.push(`${state} ${file}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    for (const [width, height, modes] of [[1600, 1000, MODES], [1280, 800, ['dark']], [820, 560, ['dark']]] as const) {
      for (const mode of modes) await shoot(`${width === 1600 ? 'usage' : 'usage-sizes'}-${mode}-${width}.png`, width, height, mode)
    }
    // The other views a press on the index opens, at the largest size.
    for (const [measure, name] of [[/^Room left /u, 'room'], [/^Tokens /u, 'tokens'], [/^Where /u, 'where']] as const) {
      await harness.resize(1600, 1000)
      await measures.getByRole('tab', { name: measure }).click()
      await shoot(`usage-${name}-dark-1600.png`, 1600, 1000, 'dark', `${shows} Its ${name === 'room' ? 'Room left' : name === 'tokens' ? 'Tokens' : 'Where'} view, pressed in the index.`)
    }
    // The Room left view on a theme other than the default.
    await measures.getByRole('tab', { name: /^Room left /u }).click()
    await page.evaluate(async () => { await window.sotto!.updateSettings({ darkTheme: 'clay' }) })
    await expect(page.locator('html')).toHaveAttribute('data-theme-id', 'clay')
    await shoot('usage-room-clay-dark-1600.png', 1600, 1000, 'dark', `${shows} Its Room left view on the Clay theme.`)
    await page.evaluate(async theme => { await window.sotto!.updateSettings({ darkTheme: theme }) }, DEFAULT_THEME_ID)
    await measures.getByRole('tab', { name: /^Prompts /u }).click()
    // The Per day chart read by the pointer: on its busiest day, which says its figure over its bar.
    for (const mode of MODES) {
      await harness.appearance(mode); await harness.resize(1600, 1000)
      const columns = page.getByRole('group', { name: /^Prompts per day/u }).locator('.usage-chart__column')
      const busiest = await columns.evaluateAll(elements => elements.reduce((best, element, at, all) => element.getBoundingClientRect().height >= 0
        && (element.querySelector('.usage-chart__bar')?.getBoundingClientRect().height ?? 0) > (all[best]!.querySelector('.usage-chart__bar')?.getBoundingClientRect().height ?? 0) ? at : best, 0))
      await columns.nth(busiest).hover()
      await shoot(`usage-day-${mode}-1600.png`, 1600, 1000, mode, `${shows} The pointer on the Per day chart's busiest day.`)
    }
    await page.mouse.move(0, 0)
    // At the minimum the stage sits under the index: the same page scrolled to it.
    await page.locator('.usage-stage').evaluate(element => {
      const scroll = element.closest<HTMLElement>('.usage-scroll')!
      scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 16
    })
    await shoot('usage-sizes-stage-dark-820.png', 820, 560, 'dark', `${shows} Scrolled to the Prompts view under the index.`)
  } finally {
    await harness.cleanup()
  }
}

async function writeManifest(out: string): Promise<void> {
  const path = join(out, 'manifest.json')
  const kept = await readFile(path, 'utf8').then(text => JSON.parse(text) as ManifestRow[]).catch(() => [] as ManifestRow[])
  for (const row of kept) if (!manifest.has(row.file)) manifest.set(row.file, row)
  const rows = [...manifest.values()].sort((a, b) => a.file.localeCompare(b.file))
  await writeFile(path, `${JSON.stringify(rows, null, 2)}\n`)
  const cell = (text: string): string => text.replaceAll('|', '\\|')
  await writeFile(join(out, 'manifest.md'), [
    '# Sotto review evidence', '', 'Written by `scripts/capture-review-evidence.mjs`.', '',
    '## What differs from a real session, everywhere', '', ...COMMON_DIFFERENCES.map(line => `- ${line}`), '',
    '## Images', '', '| File | State | On screen | Differs from a real session | App chrome out of bounds |', '|---|---|---|---|---|',
    ...rows.map(row => `| ${row.file} | ${row.state} | ${cell(row.shows)} | ${cell(row.differs) || 'Nothing further'} | ${row.bounds.join(', ') || 'None'} |`), '',
    '## Composer crops', '', 'Each image with a composer has a crop of it from the same frame in `composer/`, at the box in `composer/boxes.json`. Pass that file back with `--boxes-from` to crop a later run at the exact same boxes.', '',
  ].join('\n'))
  await writeFile(join(out, 'composer', 'boxes.json'), `${JSON.stringify(Object.fromEntries([...boxes].sort()), null, 2)}\n`)
}

test.describe('review evidence', () => {
  test.skip(OUT === undefined, 'Run through scripts/capture-review-evidence.mjs')
  test.describe.configure({ mode: 'serial', timeout: 90 * 60_000 })

  test('captures every state', async () => {
    const out = resolve(OUT!)
    await mkdir(join(out, 'composer'), { recursive: true })
    if (BOXES_FROM) fixedBoxes = JSON.parse(await readFile(BOXES_FROM, 'utf8')) as Record<string, Box>
    const kept = await readFile(join(out, 'composer', 'boxes.json'), 'utf8').then(text => JSON.parse(text) as Record<string, Box>).catch(() => ({} as Record<string, Box>))
    for (const [file, box] of Object.entries(kept)) boxes.set(file, box)
    const repository = await buildEvidenceRepository()
    // The threads' commands ran in their own folder, the project's.
    placeCommandsIn(repository.path)
    await writePullRequestMoment(repository, 'checks-running')
    process.env.SOTTO_E2E_GH_SCRIPT = resolve('tests/fixtures/fakeGh.mjs')
    process.env.SOTTO_E2E_GH_EXECUTABLE = process.execPath
    process.env.FAKE_GH_STATE = repository.ghState
    await onReleaseTrack('owl', async () => {
      if (STATES.some(wanted)) {
        await withSotto({ onboardingComplete: true, appearance: 'dark', scenario: 'phase3-workspace', agents: 'design-threads', history: populatedHistory }, async launched => {
          const { page } = launched
          await freezeMain(launched)
          await freezeRenderer(page)
          await openThreads(page)
          await resizeContentWindowFor(launched, 1600, 1000)
          await seedThreads(launched, repository)
          const capture = captureFor(launched, repository, out)
          for (const state of STATES) {
            if (!wanted(state)) continue
            await runState(`${state.name} (its clean start)`, () => cleanStart(capture))
            await runState(state.name, () => state.run(capture))
          }
        })
      }
      if (!ONLY || ONLY.includes('watcher-room') || ONLY.includes('watcher-quiet')) {
        await runState('watcher-room', () => withSotto({ onboardingComplete: true, appearance: 'dark', scenario: 'design-threads', agents: 'design-threads' }, async launched => {
          const { page } = launched
          await freezeMain(launched)
          await freezeRenderer(page)
          await resizeContentWindowFor(launched, 1600, 1000)
          await seedWatcherRoom(page, { watched: ['visual-gate', 'footer-links', 'weekly-note', 'grok-previews'], idPrefix: 'review-watcher' })
          await page.evaluate(async ({ at }) => {
            const asked = (index: number): string => at[index]!
            await window.sottoE2E!.agentEvent!({ type: 'history', threadId: 'release-notes', text: '', status: 'idle', messages: [
              { id: 'w-0', role: 'user', text: 'Keep an eye on the footer links and the visual gate, and tell me when either needs me.', createdAt: asked(0) },
              { id: 'w-1', role: 'assistant', text: 'Watching both. The visual gate thread is waiting for you on a permission to run the unit suite. Footer links is still fixing the help page.', createdAt: asked(1) },
              { id: 'w-2', role: 'user', text: 'Is the footer links pull request green yet?', createdAt: asked(2) },
              { id: 'w-3', role: 'assistant', text: 'Not yet. **Package (Windows)** is still running, and Gates passed on its [second run](https://github.com/millZach/Sotto/actions). I will send it to merge once the required checks pass.', createdAt: asked(3) },
            ] })
          }, { at: [minutesAgo(30), minutesAgo(29), minutesAgo(9), minutesAgo(8)] })
          await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
          await expect(page.getByRole('heading', { level: 1, name: 'Watcher' })).toBeVisible()
          const room = captureFor(launched, repository, out)
          const scene = 'Watcher itself is the stand-in the watcher specs seed, and its scene is held by the design-threads clock with every owl sitting.'
          if (!ONLY || ONLY.includes('watcher-room')) {
            const shows = 'Watcher\'s room with its night scene, watching four threads, under a short conversation.'
            await room.shoot('watcher-room', shows, scene)
            for (const size of SMALLER_SIZES) await room.shoot('watcher-room', shows, scene, { size })
            await resizeContentWindowFor(launched, 1600, 1000)
          }
          if (!ONLY || ONLY.includes('watcher-quiet')) {
            // The same conversation with the work Watcher did for each answer: a look at both pull requests that took its time,
            // then one quick read of the checks, whose Worked for line keeps its room and shows only under the pointer (Zach's
            // pick C, November 6, 2026, ADR-0134).
            await page.evaluate(async ({ at }) => {
              const later = (index: number, seconds: number): string => new Date(Date.parse(at[index]!) + seconds * 1_000).toISOString()
              await window.sottoE2E!.agentEvent!({ type: 'history', threadId: 'release-notes', text: '', status: 'idle', messages: [
                { id: 'w-0', role: 'user', text: 'Keep an eye on the footer links and the visual gate, and tell me when either needs me.', createdAt: at[0]! },
                { id: 'w-1', role: 'assistant', text: 'Watching both. The visual gate thread is waiting for you on a permission to run the unit suite. Footer links is still fixing the help page.', createdAt: later(0, 41) },
                { id: 'w-2', role: 'user', text: 'Is the footer links pull request green yet?', createdAt: at[2]! },
                { id: 'w-3', role: 'assistant', text: 'Not yet. **Package (Windows)** is still running, and Gates passed on its [second run](https://github.com/millZach/Sotto/actions). I will send it to merge once the required checks pass.', createdAt: later(2, 4) },
              ], activities: [
                { id: 'turn-w-0', turnId: 'w-0', afterMessageId: 'w-0', sequence: 0, kind: 'turn', status: 'completed', title: 'Turn', startedAt: at[0]!, completedAt: later(0, 41), durationMs: 41_000 },
                { id: 'w-0-a', turnId: 'w-0', afterMessageId: 'w-0', sequence: 1, kind: 'command', status: 'completed', title: 'Bash', command: 'gh pr view 2101 --json statusCheckRollup', startedAt: later(0, 3), completedAt: later(0, 5), durationMs: 2_000 },
                { id: 'w-0-b', turnId: 'w-0', afterMessageId: 'w-0', sequence: 2, kind: 'command', status: 'completed', title: 'Bash', command: 'gh pr view 2098 --json statusCheckRollup', startedAt: later(0, 6), completedAt: later(0, 8), durationMs: 2_000 },
                { id: 'turn-w-2', turnId: 'w-2', afterMessageId: 'w-2', sequence: 3, kind: 'turn', status: 'completed', title: 'Turn', startedAt: at[2]!, completedAt: later(2, 4), durationMs: 4_000 },
                { id: 'w-2-a', turnId: 'w-2', afterMessageId: 'w-2', sequence: 4, kind: 'command', status: 'completed', title: 'Bash', command: 'gh pr checks 2101', startedAt: later(2, 1), completedAt: later(2, 3), durationMs: 2_000 },
              ] })
            }, { at: [minutesAgo(30), minutesAgo(29), minutesAgo(9), minutesAgo(8)] })
            const quick = page.locator('.watcher-pane .thread-work[data-quiet]')
            await expect(quick).toHaveCount(1)
            const ask = page.locator('.watcher-pane .thread-message[data-role="user"]').filter({ hasText: 'Is the footer links pull request green yet?' })
            const point = async (): Promise<void> => {
              const box = (await ask.boundingBox())!
              await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
              await expect(quick.locator('.thread-work__summary')).toHaveCSS('opacity', '1')
            }
            await room.shoot('watcher-quiet', 'Watcher\'s conversation with its work: the first answer\'s Worked for line in view, the quick second one keeping its room with nothing in it.', scene)
            await room.shoot('watcher-quiet-hover', 'The pointer over "Is the footer links pull request green yet?": its quick turn\'s Worked for line shows.', scene, { before: point })
          }
        }))
      }
      if (!ONLY || WATCHER_CONTROLS.some(name => ONLY.includes(name))) await runState('watcher-controls', () => captureWatcherControls(out))
    })
    // Its own launch: production main over an isolated home, so it reads the provider clients' records the way it would on a computer that has them.
    if (!ONLY || ['usage', 'usage-sizes'].some(name => ONLY.includes(name))) await runState('usage', () => captureConnectedUsage(out))
    await writeManifest(out)
    await rm(evidenceRoot(), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    expect(failures).toEqual([])
  })
})
