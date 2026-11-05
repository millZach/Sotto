import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'
import sharp from 'sharp'

import { E2E_THREADS_NOW } from '../../src/shared/e2e'
import { populatedHistory, withSotto } from '../fixtures/designCaptureProfile'
import { EVIDENCE_THREADS, PERMISSION_REQUEST, STREAM_MESSAGE_ID, STREAM_MOMENTS, STREAM_REPLY, STREAM_SHOWN, STREAM_THREAD_ID, evidenceThread, minutesAgo, streamActivities } from '../fixtures/reviewEvidence/content'
import { buildEvidenceRepository, EVIDENCE_PULL, evidenceRoot, writePullRequestMoment, type EvidenceRepository, type PullRequestMoment } from '../fixtures/reviewEvidence/repository'
import { DEFAULT_THEME_ID } from '../../src/shared/themes/library'
import { pageBoundProblems, setAppearance } from './support/designCapture'
import { onReleaseTrack } from './support/releaseTrack'
import { openThreads, toggleTools, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'
import { holdOwlSky } from './support/sottoOwl'
import { seedWatcherRoom } from './support/watcherRoom'

/**
 * The real running app in real, busy states, for side-by-side review and as "before" images for later changes. Every
 * image comes from the built app's own renderer. The harness supplies data only: a real Git repository and scripted gh
 * (tests/fixtures/reviewEvidence), and the fake provider host's own events. It never writes a baseline and never opens
 * the user's profile. Run it through scripts/capture-review-evidence.mjs; without that it skips.
 */
const OUT = process.env.SOTTO_REVIEW_EVIDENCE_OUT
const ONLY = process.env.SOTTO_REVIEW_EVIDENCE_STATES?.split(',').map(name => name.trim()).filter(Boolean)
const BOXES_FROM = process.env.SOTTO_REVIEW_EVIDENCE_BOXES

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

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0)
  await page.evaluate(async hold => {
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
    if (list && open) list.scrollTop += open.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - open.clientHeight) / 2
    else if (list) list.scrollTop = 0
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  }, ANIMATION_HOLD_MS)
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
  /** One image per mode at the current size, with the composer's crop from the same frame. */
  shoot(state: string, shows: string, differs?: string, options?: { readonly modes?: readonly Mode[]; readonly size?: readonly [number, number] }): Promise<void>
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
        await settle(page)
        const file = `${state}-${mode}-${width}.png`
        const image = await page.screenshot({ caret: 'hide' })
        await writeFile(join(out, file), image)
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
  await row.click({ position: { x: 16, y: 12 } })
  await expect(focusedPane(page).getByRole('heading', { name: title, exact: true })).toBeVisible()
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
  { name: 'thread-long', covers: [], run: async capture => {
    const { page } = capture
    await openThread(page, 'Split AgentControl')
    // A long thread opens on its newest turns; the reader's own presses bring the rest in.
    const earlier = transcript(page).locator('.thread-transcript__earlier').getByRole('button')
    await expect(async () => {
      if (await earlier.count()) await earlier.first().click({ timeout: 2_000 }).catch(() => undefined)
      expect(await transcript(page).locator('.thread-message').count()).toBeGreaterThanOrEqual(100)
    }).toPass({ timeout: 120_000 })
    await scrollTranscript(page, 'middle')
    const shows = 'A long thread (106 messages and 190 tool calls, the calls folded in their turns) scrolled to its middle, with the sidebar full. It opens on its newest turns, so Show earlier messages is pressed until all of it is drawn.'
    const differs = 'The rounds of this thread are written from a template over twelve cuts, so their shape repeats more than a real session.'
    await capture.shoot('thread-long', shows, differs)
    for (const size of SMALLER_SIZES) {
      await resizeContentWindowFor(capture.launched, size[0], size[1])
      await scrollTranscript(page, 'middle')
      await capture.shoot('thread-long', shows, differs, { modes: ['dark'], size })
    }
    await resizeContentWindowFor(capture.launched, 1600, 1000)
  } },
  { name: 'reading', covers: ['reading-copy', 'reading-reply-copy', 'reading-scrubber', 'reading-jump-focus', 'reading-new-messages', 'reading-clay', 'reading-glass'], run: async capture => {
    const { page } = capture
    await openThread(page, 'Split AgentControl')
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
    // A reply after the first is headed by nothing; its name and time show beside its copy control.
    const reply = transcript(page).locator('.thread-message[data-role="assistant"][data-named="no"]').filter({ hasText: 'threadTitles' }).first()
    await reply.locator('.thread-message__copy').focus()
    await reply.evaluate(element => element.scrollIntoView({ block: 'center' }))
    await capture.shoot('reading-reply-copy', 'The keyboard on the copy control of a reply after the first one, with its name and time beside it.')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const lane = pane.locator('.message-scrubber')
    if (await lane.count()) {
      const box = (await lane.boundingBox())!
      await page.mouse.move(box.x + box.width / 2 - 2, box.y + box.height / 2 - 2)
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await capture.shoot('reading-scrubber', 'The pointer on the message scrubber, with the ticks risen and a card showing.')
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
    await capture.shoot('streaming-1', 'The same at the minimum window.', differs, { modes: ['dark'], size: [820, 560] })
    await streamTo(page, 'second')
    await capture.shoot('streaming-2', 'The same turn with its reply part-way through the numbered list; the transcript follows the end.', differs)
    await capture.shoot('streaming-2', 'The same at the minimum window.', differs, { modes: ['dark'], size: [820, 560] })
    await streamTo(page, 'third')
    await capture.shoot('streaming-3', 'The same turn further on, its reply cut off inside the code block as it arrives.', differs)
    await capture.shoot('streaming-3', 'The same at the minimum window.', differs, { modes: ['dark'], size: [820, 560] })
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
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await line.click()
    await focusedPane(page).getByRole('button', { name: /^Plan the split, 3 of 7 done/u }).click()
    await expect(focusedPane(page).getByRole('list', { name: 'Plan, 3 of 7 done' })).toBeVisible()
    // The press scrolls the reader off the end, so the composer slims; it is not done moving when its animations are.
    const composer = focusedPane(page).locator('form.thread-prompt')
    let lastTop = Number.NaN
    await expect.poll(async () => { const top = (await composer.boundingBox())?.y ?? Number.NaN, still = top === lastTop; lastTop = top; return still }, { intervals: [500] }).toBe(true)
    await capture.shoot('steps-expanded', 'The same turn unfolded: the newest six steps, with the plan among them pressed open, three done, one running and three to come.')
    await capture.shoot('steps-expanded', 'The same turn unfolded at a narrower window.', '', { modes: ['dark'], size: [1280, 800] })
    await capture.shoot('steps-expanded', 'The same turn unfolded at the minimum window.', '', { modes: ['dark'], size: [820, 560] })
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
    await row.click()
    await expect(log.locator('.thread-activity__change, .thread-activity__details').first()).toBeVisible()
    await capture.shoot('doc-edit-expanded', 'The same edit unfolded with its diff showing.')
    await row.click()
    await work.click()
  } },
  { name: 'changes', covers: ['changes-big', 'changes-expanded', 'changes-file', 'changes-tree-press'], run: async capture => {
    const { page } = capture
    await openThread(page, 'Thread store on a worker')
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
    await page.getByRole('button', { name: 'Restore tools panel', exact: true }).click()
    await page.waitForTimeout(500)
    await wheelToFile(page, panel, 'src/main/agents/threadStore.ts')
    await capture.shoot('changes-file', 'The same diff, wheeled down to one file, src/main/agents/threadStore.ts, with its hunks.', differs)
    // A press on a file in the tree is the other way to a file, and it moves more than the list.
    if (await panel.locator('.changes-jump__all').isVisible()) await panel.locator('.changes-jump__all').click()
    await panel.getByRole('listbox', { name: 'Files in this comparison' }).getByRole('option', { name: /storeOverlay\.ts/u }).first().click()
    await page.waitForTimeout(1_200)
    const moved = await page.evaluate(() => {
      let most = 0
      for (const element of document.querySelectorAll('.threads-view, .threads-view *')) if (!element.closest('.changes-files, [role="log"], .thread-nav')) most = Math.max(most, element.scrollTop)
      return most
    })
    await capture.shoot('changes-tree-press', 'The same diff after a press on src/main/agents/storeOverlay.ts in the file tree.', moved > 0 ? `Shown as the app does it: the press also scrolled the workspace itself up by ${Math.round(moved)} px, which moves the header, the composer and the window controls with it and leaves a blank band at the foot.` : '')
    await page.evaluate(() => {
      for (const element of document.querySelectorAll('.threads-view, .threads-view *')) if (element.scrollTop > 0 && !element.closest('.changes-files, [role="log"], .thread-nav')) element.scrollTop = 0
    })
    await closeTools(page)
  } },
  // The rest of reading a long comparison, and a diff away from the default palette. Controls are found by what they are,
  // since a new control's words only reach a build once the catalogs are extracted.
  { name: 'changes-more', covers: ['changes-tree-filter', 'changes-view-menu', 'changes-all-files', 'changes-split', 'changes-no-wrap', 'changes-one-file', 'changes-clay', 'doc-edit-clay'], run: async capture => {
    const { page } = capture
    await openThread(page, 'Thread store on a worker')
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
    await viewChoice(panel, 'wrap', false)
    await page.waitForTimeout(300)
    await capture.shoot('changes-no-wrap', 'The same files with Wrap long lines off: a long line scrolls sideways inside its own file.', '', { modes: ['dark'] })
    await viewChoice(panel, 'wrap', true)
    await viewChoice(panel, 'one-file', true)
    await panel.locator('.changes-jump__place + button + button').click()
    await expect(panel.locator('.changes-file')).toHaveCount(1)
    await page.waitForTimeout(500)
    await capture.shoot('changes-one-file', 'One file at a time, after a press on Next file, with the tree off.')
    await viewChoice(panel, 'one-file', false)
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
  { name: 'pr', covers: ['pr-checks-running', 'pr-checks-failed', 'pr-ready'], run: async capture => {
    const { page } = capture
    await openThread(page, 'Thread store on a worker')
    await pullRequestMoment(capture, 'checks-running')
    await pullRequestMoment(capture, 'checks-failed')
    await pullRequestMoment(capture, 'ready')
    for (const size of SMALLER_SIZES) await capture.shoot('pr-ready', PR_NOTES.ready, 'The pull request lives in the scripted gh. At this size the pane header has no room left for the badge, so it does not show.', { modes: ['dark'], size })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await closeTools(page)
  } },
  // How the answer holds: the blocked and the ready surface at every size, in a third theme, and the states that take Merge's place.
  { name: 'pr-states', covers: ['pr-blocked-many', 'pr-auto-merge', 'pr-merged', 'pr-failed-clay', 'pr-ready-clay', 'pr-ready-glass', 'pr-merge-method'], run: async capture => {
    const { page } = capture
    await openThread(page, 'Thread store on a worker')
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
    await openThread(page, 'Thread store on a worker')
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
    await openThread(page, 'Thread store on a worker')
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
    await openThread(page, 'Thread store on a worker')
    await refreshBranch(page, 'Thread store on a worker')
    const quick = focusedPane(page).locator('.git-action__quick')
    await expect(focusedPane(page).locator('.git-action__label')).toHaveText(/Commit/u, { timeout: 30_000 })
    await quick.click()
    const dialog = page.getByRole('dialog', { name: 'Commit changes' })
    await expect(dialog.getByRole('list', { name: 'Changed files' })).toContainText('storeWorkerProtocol.ts', { timeout: 30_000 })
    await capture.shoot('git-dialog', 'The Git action\'s commit dialog over the thread, with its changed-files list: four edits and one new file on the pull request\'s branch.')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  } },
  { name: 'permission-card', covers: [], run: async capture => {
    const { page } = capture
    await page.evaluate(async ({ id, request }) => {
      await window.sottoE2E!.agentEvent!({ type: 'permission', threadId: id, text: request.text, request, status: 'running' })
    }, { id: evidenceThread('permission').id, request: PERMISSION_REQUEST })
    await openThread(page, 'Measure the store worker')
    await expect(focusedPane(page).getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
    await capture.shoot('permission-card', 'A thread waiting on a permission request to run a benchmark, with its Allow, Allow for this session and Deny choices.', 'The request is the fake provider host\'s, in the shape the Claude adapter sends.')
  } },
  { name: 'split-panes', covers: [], run: async capture => {
    const { page } = capture
    await openThread(page, 'Trace a permission request')
    await streamTo(page, 'third')
    const row = page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Repository review', exact: true }).first()
    await row.hover({ position: { x: 16, y: 12 } })
    await page.getByRole('button', { name: 'Open Repository review beside', exact: true }).click()
    await capture.shoot('permission-card', 'The same at the minimum window.', 'The request is the fake provider host\'s, in the shape the Claude adapter sends.', { modes: ['dark'], size: [820, 560] })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await expect(page.getByRole('separator', { name: 'Resize panes', exact: true })).toBeVisible()
    await capture.shoot('split-panes', 'Two threads side by side: the finished review and a thread still streaming its reply.', 'The stream is held at one moment while each image is taken.')
    for (const size of SMALLER_SIZES) await capture.shoot('split-panes', 'Two threads side by side: the finished review and a thread still streaming its reply.', 'The stream is held at one moment while each image is taken.', { modes: ['dark'], size })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
  } },
  { name: 'pages', covers: ['dictate', 'settings', 'usage', 'help'], run: async capture => {
    const { page } = capture
    await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Dictate', exact: true }).click()
    await expect(page.locator('.dictate')).toBeVisible()
    await capture.shoot('dictate', 'The Dictate room with its Journal, reached from the sidebar\'s room switch.', 'The Journal is the design captures\' fixture history. Nothing is being dictated.')
    await openThreads(page)
    await page.getByRole('link', { name: 'Usage', exact: true }).click()
    await page.waitForTimeout(1_500)
    await capture.shoot('usage', 'The Usage page.', 'Its prompt counts are the prompts this run sent. No provider wrote tokens or limits, so those tiles are empty, and its model name is the fixture model\'s ID.')
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
    await page.getByRole('button', { name: 'Open Repository review beside', exact: true }).click({ force: true })
    await expect(page.getByRole('separator', { name: 'Resize panes', exact: true })).toBeVisible()
    await everySize('shell-split', 'Two threads side by side, with the sidebar full.')
    await setAppearance(page, { appearance: 'dark', lightTheme: 'clay', darkTheme: 'clay' }, 'dark')
    await everySize('shell-split-clay', 'The same on the Clay theme.')
    await setAppearance(page, { appearance: 'dark', lightTheme: DEFAULT_THEME_ID, darkTheme: DEFAULT_THEME_ID }, 'dark')
  } },
  // Asked for by name only: the pages at the smaller sizes, and a thread and Help on a theme other than the default.
  { name: 'shell-check', covers: [], run: async capture => {
    const { page } = capture
    const pages = [['Usage', 'usage'], ['Help', 'help'], ['Settings', 'settings']] as const
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

const BY_NAME_ONLY = ['shell-check', 'header-press', 'shell-surface', 'pr-every']
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
            await runState(state.name, () => state.run(capture))
            await closeTools(page).catch(() => undefined)
          }
        })
      }
      if (!ONLY || ONLY.includes('watcher-room')) {
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
          await captureFor(launched, repository, out).shoot('watcher-room', 'Watcher\'s room with its night scene, watching four threads, under a short conversation.', 'Watcher itself is the stand-in the watcher specs seed, and its scene is held by the design-threads clock with every owl sitting.')
        }))
      }
    })
    await writeManifest(out)
    await rm(evidenceRoot(), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    expect(failures).toEqual([])
  })
})
