import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'
import sharp from 'sharp'

import { E2E_THREADS_NOW } from '../../src/shared/e2e'
import { populatedHistory, withSotto } from '../fixtures/designCaptureProfile'
import { EVIDENCE_THREADS, PERMISSION_REQUEST, STREAM_MESSAGE_ID, STREAM_MOMENTS, STREAM_REPLY, STREAM_SHOWN, STREAM_THREAD_ID, evidenceThread, minutesAgo, streamActivities } from '../fixtures/reviewEvidence/content'
import { buildEvidenceRepository, EVIDENCE_PULL, evidenceRoot, writePullRequestMoment, type EvidenceRepository, type PullRequestMoment } from '../fixtures/reviewEvidence/repository'
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
  // A running turn's tip is chosen from a list its skills join once they are read, so they are read before the next thread opens.
  await page.waitForTimeout(600)
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
  // A clean renderer, as after a restart: what it chose while the threads were being told (each one's greeting and tip) is forgotten.
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
}
const PR_STATE: Readonly<Record<PullRequestMoment, string>> = { 'checks-running': 'pr-checks-running', 'checks-failed': 'pr-checks-failed', ready: 'pr-ready' }

async function pullRequestMoment(capture: Capture, moment: PullRequestMoment): Promise<void> {
  const { page, repository } = capture
  await writePullRequestMoment(repository.ghState, moment)
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

/** Every state, in an order that leaves each next one a clean start. A name in --states picks a group or a single image's state. */
const STATES: ReadonlyArray<{ readonly name: string; readonly covers: readonly string[]; readonly run: (capture: Capture) => Promise<void> }> = [
  { name: 'threads-empty', covers: [], run: async capture => {
    const { page } = capture
    await page.getByRole('button', { name: 'New thread', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
    await dialog.getByRole('searchbox', { name: 'Search projects' }).fill('sotto')
    await dialog.getByRole('button', { name: /^sotto / }).first().click()
    await expect(dialog).toHaveCount(0)
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
    // The header fills in once the host has read the folder's Git status: without this the first image is taken before that
    // read and the second after it, and the two modes seem to hold different things.
    await expect(focusedPane(page).locator('.git-action')).toBeVisible()
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
  { name: 'streaming', covers: ['streaming-1', 'streaming-2', 'streaming-3'], run: async capture => {
    const { page } = capture
    await openThread(page, 'Trace a permission request')
    const differs = 'The deltas come from the fake provider host at a steady rate, not a model.'
    await capture.shoot('streaming-1', 'A streaming turn before its first word: the working line after three steps, one command running.', differs)
    await streamTo(page, 'second')
    await capture.shoot('streaming-2', 'The same turn with its reply part-way through the numbered list; the transcript follows the end.', differs)
    await streamTo(page, 'third')
    await capture.shoot('streaming-3', 'The same turn further on, its reply cut off inside the code block as it arrives.', differs)
  } },
  { name: 'steps', covers: ['steps-collapsed', 'steps-expanded'], run: async capture => {
    const { page } = capture
    await openThread(page, 'Plan the split')
    const line = focusedPane(page).getByRole('button', { name: /^Working, / })
    await expect(line).toBeVisible()
    await capture.shoot('steps-collapsed', 'An agent mid-way through "Plan the split": its steps folded under the working line.')
    await line.click()
    const plan = focusedPane(page).getByRole('button', { name: /Plan the split.*3 of 7 done/u }).first()
    await plan.click()
    await expect(focusedPane(page).getByRole('list', { name: 'Plan, 3 of 7 done' })).toBeVisible()
    await capture.shoot('steps-expanded', 'The same turn unfolded: the steps opened, and the plan row opened to its checklist with three done, one running and three to come.')
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
    await row.click()
    await expect(log.locator('.thread-activity__change, .thread-activity__details').first()).toBeVisible()
    await capture.shoot('doc-edit-expanded', 'The same edit unfolded with its diff showing.')
    await row.click()
    await work.click()
  } },
  { name: 'changes', covers: ['changes-big', 'changes-file', 'changes-tree-press'], run: async capture => {
    const { page } = capture
    await openThread(page, 'Thread store on a worker')
    const panel = await toolsTab(page, 'Changes')
    await panel.locator('.changes-scope__select').selectOption('branch')
    await expect(panel.locator('.changes-file').nth(29)).toBeAttached({ timeout: 60_000 })
    const expand = panel.getByRole('button', { name: 'Expand all files', exact: true })
    if (await expand.count()) await expand.click()
    const showTree = panel.getByRole('button', { name: 'Show file tree' })
    if (await showTree.count()) await showTree.click()
    await expect(panel.getByRole('listbox', { name: 'Files in this comparison' })).toBeVisible()
    await page.waitForTimeout(1_000)
    const shows = 'Changes in Tools on Branch changes against origin/main: 30 files, about 4,200 lines added and removed, with the file tree showing and every file open.'
    const differs = 'The diff is a real merge from this repository\'s history (ead571a0d), in a repository holding only the files it touched.'
    await capture.shoot('changes-big', shows, differs)
    for (const size of SMALLER_SIZES) await capture.shoot('changes-big', shows, differs, { modes: ['dark'], size })
    await resizeContentWindowFor(capture.launched, 1600, 1000)
    await wheelToFile(page, panel, 'src/main/agents/threadStore.ts')
    await capture.shoot('changes-file', 'The same diff, wheeled down to one file, src/main/agents/threadStore.ts, with its hunks.', differs)
    // A press on a file in the tree is the other way to a file, and it moves more than the list.
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
    await expect(page.getByRole('separator', { name: 'Resize panes', exact: true })).toBeVisible()
    await capture.shoot('split-panes', 'Two threads side by side: the finished review and a thread still streaming its reply.', 'The stream is held at one moment while each image is taken.')
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
]

const BY_NAME_ONLY = ['shell-check']
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
    await writePullRequestMoment(repository.ghState, 'checks-running')
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
    await setAppearance(page, { appearance: 'dark', lightTheme: 'sotto', darkTheme: 'sotto' }, 'dark')
  } },
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
