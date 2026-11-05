/**
 * What an agent's pictures cost a long thread in the built app (`docs/perf/2026-11-04-thread-pictures-cost.md`): the same
 * 1,322 steps in four turns, with 0, 25, 100 or 275 pictures, over the real Claude adapter and the fake CLI, and the 275
 * again with `inline-media` off. It prints and saves sizes, counts and times, never a thread's words. It asserts no time,
 * so it runs only when asked, after `npm run build`, like the other timing benchmarks (`docs/ci.md`):
 *
 *   SOTTO_PERF_BENCH=1 SOTTO_PICTURES_PASS=seed  xvfb-run -a -s '-screen 0 1920x1080x24' npx playwright test tests/e2e/thread-pictures-cost.spec.ts
 *   SOTTO_PERF_BENCH=1 SOTTO_PICTURES_PASS=clean SOTTO_PICTURES_RUNS=5 xvfb-run -a -s '-screen 0 1920x1080x24' npx playwright test tests/e2e/thread-pictures-cost.spec.ts
 *
 * The passes, each its own run because each changes what the others time:
 *   seed     builds a profile per picture count, reused by the others (each run takes a copy of it).
 *   clean    times opening, switching back, scrolling and updates, and samples memory, with nothing else in the way.
 *   counted  counts what crosses to the window: picture reads and bytes, broadcasts and bytes, main's decodes and their
 *            time, and takes a memory dump that says how much of the renderer is image data.
 *   trace    records a Chromium trace of each phase and splits its time: script, style, layout, paint, decoding, raster.
 *   sweep    the update's cost by how many pictures the working turn itself holds, with the same number of steps.
 *   profile  the same, with main and the window under the CPU profiler while steps arrive: self time by function name.
 *   undriven the built app with no debugger on the window, driven from main's Node inspector and read from /proc, with
 *            and without the tile's Lingui warning. A debugger on the window makes every console call far dearer, so this
 *            is the pass that says what the warning costs; the other passes silence it (SOTTO_PICTURES_KEEP_WARNING=1 keeps it).
 *
 * Switches: SOTTO_PICTURES_ROOT (where profiles and results live, default ~/.cache/sotto-thread-pictures), SOTTO_PICTURES_SCALE,
 * SOTTO_PICTURES_RUNS, SOTTO_PICTURES_CASES (a comma list of 0,25,100,275,275-off) and SOTTO_PICTURES_LABEL (the result
 * file's suffix). A run stops at once when the machine's available memory falls under SOTTO_PICTURES_MIN_FREE_MIB.
 */
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { freemem, homedir, loadavg } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { _electron as electron, expect, test, type CDPSession, type Page } from '@playwright/test'
import { AGENT_THREAD_MEDIA } from '../../src/shared/agents'
import { PERF_BENCH, round } from '../fixtures/perfBench'
import { closeSotto, e2eEnvironment, firstSottoWindow, launchSotto, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'
import { chunkFrame, fixturePicture, fixtureTurns, FIXTURE_STEPS, replyStartFrame, stepFrames } from './support/threadPicturesFixture'

const MiB = 1024 * 1024
const BASE_PICTURE = resolve('artifacts/image-viewer/viewer-1280-dark.png')
const ROOT = process.env.SOTTO_PICTURES_ROOT ?? join(homedir(), '.cache', 'sotto-thread-pictures')
const PASS = process.env.SOTTO_PICTURES_PASS ?? 'clean'
const RUNS = Number(process.env.SOTTO_PICTURES_RUNS ?? 5)
const LABEL = process.env.SOTTO_PICTURES_LABEL ?? ''
const MIN_FREE_MIB = Number(process.env.SOTTO_PICTURES_MIN_FREE_MIB ?? 2_500)
/** The screen's device scale, for a run on a scaled laptop's terms: SOTTO_PICTURES_SCALE=2 (give Xvfb a screen big enough). */
const SCALE = Number(process.env.SOTTO_PICTURES_SCALE ?? 1)
/** How much slower the window's main thread runs, as a stand-in for a slower or busier computer: SOTTO_PICTURES_THROTTLE=4. */
const THROTTLE = Number(process.env.SOTTO_PICTURES_THROTTLE ?? 1)
/** The pictures' pixels, SOTTO_PICTURES_SIZE=2560x1600. Give each size its own SOTTO_PICTURES_ROOT, since the profiles hold them. */
const [PICTURE_WIDTH, PICTURE_HEIGHT] = (process.env.SOTTO_PICTURES_SIZE ?? '1600x1000').split('x').map(Number) as [number, number]
const THREAD_TITLE = 'Picture fixture', SIDE_TITLE = 'Side thread'
const LAST_REPLY = 'The end of the fixture thread.', SIDE_REPLY = 'The side thread is done.'
/** Fast enough to bring a new row of tiles near every frame or two, as a quick flick through a thread does. */
const SCROLL_PX_PER_SECOND = 2_400

interface Case { readonly id: string; readonly tiles: number; readonly owl: boolean }
const ALL_CASES: readonly Case[] = [
  { id: '0', tiles: 0, owl: true }, { id: '25', tiles: 25, owl: true }, { id: '100', tiles: 100, owl: true },
  { id: '275', tiles: 275, owl: true }, { id: '275-off', tiles: 275, owl: false },
]
const chosen = process.env.SOTTO_PICTURES_CASES?.split(',')
const CASES = ALL_CASES.filter(item => !chosen || chosen.includes(item.id))
const SWEEP = (process.env.SOTTO_PICTURES_SWEEP ?? '0,25,100,275').split(',').map(Number)
const profileOf = (tiles: number) => join(ROOT, `sotto-e2e-tiles-${tiles}`)

/** Stops the run rather than push a shared machine into its out-of-memory killer. */
function guardMemory(): void {
  const available = /MemAvailable:\s+(\d+)/u.exec(existsSync('/proc/meminfo') ? readFileSync('/proc/meminfo', 'utf8') : '')
  const free = available ? Number(available[1]) * 1024 : freemem()
  if (free / MiB < MIN_FREE_MIB) throw new Error(`Stopped: ${Math.round(free / MiB)} MiB available, under the ${MIN_FREE_MIB} MiB floor.`)
}

async function launch(profile: string, owl: boolean): Promise<LaunchedSotto> {
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = join(profile, 'native-fixture')
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  process.env.SOTTO_OWL_FEATURES = `inline-media=${owl ? 1 : 0}`
  if (SCALE === 1) return launchSotto('success', profile)
  return launchSotto('success', profile, {
    createProfile: () => { throw new Error('The benchmark brings its own profile.') },
    removeProfile: () => Promise.resolve(),
    firstWindow: firstSottoWindow,
    launch: options => electron.launch({ ...options, args: [...options?.args ?? [], `--force-device-scale-factor=${SCALE}`] }),
  })
}

/** The numbered picture, made once and kept with the profiles, so every profile holds the same bytes. */
async function pictureFile(number: number): Promise<Buffer> {
  const path = join(ROOT, 'pictures', `${number}.png`)
  if (existsSync(path)) return readFile(path)
  const made = fixturePicture(BASE_PICTURE, number, PICTURE_WIDTH, PICTURE_HEIGHT)
  await mkdir(join(ROOT, 'pictures'), { recursive: true })
  await writeFile(path, made)
  return made
}

async function act(root: string, session: string, action: object): Promise<void> {
  const control = join(root, `control-${session}.json`)
  await writeFile(control, JSON.stringify({ id: randomUUID(), ...action }))
  await expect.poll(() => existsSync(control), { timeout: 120_000, intervals: [5, 10, 20, 50] }).toBe(false)
}

async function aliveSession(root: string): Promise<string> {
  const alive = async () => (await readdir(root)).filter(name => /^alive-.+\.json$/u.test(name)).map(name => name.slice(6, -5))
  await expect.poll(async () => (await alive()).length, { timeout: 60_000 }).toBeGreaterThan(0)
  return (await alive())[0]!
}

async function threadIdle(page: Page, id: string): Promise<void> {
  await expect.poll(() => page.evaluate(async id => (await window.sotto!.agents!.get()).host.threads.find(item => item.id === id)?.status, id), { timeout: 180_000 }).toBe('idle')
}

async function send(page: Page, id: string, text: string): Promise<void> {
  const error = await page.evaluate(async ({ id, text }) => (await window.sotto!.agents!.command({ type: 'manual-send', threadId: id, text })).error, { id, text })
  if (error) throw new Error(error)
}

/** Builds one profile: the fixture thread through the real adapter, then a one-turn thread to switch to. */
async function seed(tiles: number): Promise<void> {
  const profile = profileOf(tiles)
  await rm(profile, { recursive: true, force: true })
  const root = join(profile, 'native-fixture')
  const project = join(root, 'project')
  for (const folder of ['claude', 'codex', 'project']) await mkdir(join(root, folder), { recursive: true })
  const launched = await launch(profile, true)
  try {
    const { page } = launched
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', showEveryAgentPicture: true })
      const agents = window.sotto!.agents!
      const configured = await agents.command({ type: 'configure', patch: { provider: 'claude', enabled: true, enabledProviders: ['claude'], checkClientUpdates: false } })
      if (configured.error) throw new Error(configured.error)
      const connected = await agents.command({ type: 'connect', provider: 'claude' })
      if (connected.error) throw new Error(connected.error)
    })
    await page.reload()
    const made = (title: string) => page.evaluate(async ({ title, project }) => {
      const agents = window.sotto!.agents!
      const created = await agents.command({ type: 'create-project', provider: 'claude', title: 'Bench', path: project, useExisting: true })
      const projectId = created.host.projects.find(item => item.title === 'Bench')!.id
      const modelId = (await agents.get()).host.models.find(item => item.providerId === 'claude' && item.ready)!.id
      const thread = await agents.command({ type: 'create-thread', projectId, title, titleSource: 'user', modelId, workingCopy: 'shared' })
      if (thread.error || !thread.activeThreadId) throw new Error(thread.error ?? 'No thread was created.')
      return thread.activeThreadId
    }, { title, project })
    const threadId = await made(THREAD_TITLE)
    let number = 0, fixtureSession = ''
    const turns = fixtureTurns(tiles)
    for (const [index, steps] of turns.entries()) {
      guardMemory()
      await send(page, threadId, `Fixture turn ${index + 1}: try the next change and look at the page.`)
      const session = fixtureSession = await aliveSession(join(root, 'claude'))
      for (let at = 0; at < steps.length; at += 30) {
        const frames: object[] = []
        for (const step of steps.slice(at, at + 30)) frames.push(...stepFrames(session, step.picture ? await pictureFile(number++) : undefined))
        await act(join(root, 'claude'), session, { type: 'raw-burst', persist: true, frames })
      }
      await act(join(root, 'claude'), session, { type: 'complete', text: index === turns.length - 1 ? LAST_REPLY : `Fixture turn ${index + 1} is done.` })
      await threadIdle(page, threadId)
    }
    const sideId = await made(SIDE_TITLE)
    await send(page, sideId, 'A short question.')
    const others = async () => (await readdir(join(root, 'claude'))).filter(name => /^alive-.+\.json$/u.test(name)).map(name => name.slice(6, -5)).filter(name => name !== fixtureSession)
    await expect.poll(async () => (await others()).length, { timeout: 60_000 }).toBeGreaterThan(0)
    await act(join(root, 'claude'), (await others())[0]!, { type: 'complete', text: SIDE_REPLY })
    await threadIdle(page, sideId)
    await sleep(2_000)
    await writeFile(join(profile, 'fixture.json'), JSON.stringify({ threadId, sideId, tiles }))
  } finally { await closeSotto(launched) }
}

/** Lingui's warning for a tile's name, one for every render of every tile. A debugger on the window turns each into a message to Playwright, which no user pays. */
function SILENCE_TILE_WARNING(): void {
  const warn = console.warn
  console.warn = (...parts: unknown[]) => { if (typeof parts[0] === 'string' && parts[0].startsWith('Uncompiled message')) return; warn(...parts) }
}

/** A frame logger and a long-task observer in the page, and helpers the phases below call. */
async function instrumentPage(page: Page): Promise<void> {
  if (process.env.SOTTO_PICTURES_KEEP_WARNING !== '1') await page.evaluate(SILENCE_TILE_WARNING)
  await page.evaluate(() => {
    const held = window as unknown as Record<string, unknown>
    const frames: number[] = []
    const long: number[] = []
    // The clock, not the frame's own timestamp, so a late frame reads as late however the compositor labels it.
    const tick = () => { frames.push(performance.now()); requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    new PerformanceObserver(list => { for (const entry of list.getEntries()) long.push(entry.duration) }).observe({ entryTypes: ['longtask'] })
    held.__picturesLog = { frames, long }
  })
}
/** Drops what the logger holds, so a phase's numbers are that phase's. */
const startLog = (page: Page) => page.evaluate(() => {
  const log = (window as unknown as { __picturesLog: { frames: number[]; long: number[] } }).__picturesLog
  log.frames.length = 0; log.long.length = 0
})
const readLog = (page: Page) => page.evaluate(() => {
  const log = (window as unknown as { __picturesLog: { frames: number[]; long: number[] } }).__picturesLog
  const gaps = log.frames.slice(1).map((at, index) => at - log.frames[index]!)
  return { frames: gaps.length, longestFrameMs: Math.round(Math.max(0, ...gaps) * 10) / 10,
    over33: gaps.filter(gap => gap > 33.4).length, over50: gaps.filter(gap => gap > 50).length, over100: gaps.filter(gap => gap > 100).length,
    longTasks: log.long.length, longTaskMs: Math.round(log.long.reduce((sum, value) => sum + value, 0)) }
})

/** Times how long main's event loop goes unanswered, as anything else it should be doing would feel it. */
const watchMainLoop = (launched: LaunchedSotto) => launched.app.evaluate(() => {
  const held = globalThis as unknown as { __mainLoop?: { timer: NodeJS.Timeout; gaps: number[] } }
  if (held.__mainLoop) clearInterval(held.__mainLoop.timer)
  const gaps: number[] = []
  let last = performance.now()
  held.__mainLoop = { gaps, timer: setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now }, 5) }
})
const readMainLoop = (launched: LaunchedSotto) => launched.app.evaluate(() => {
  const gaps = (globalThis as unknown as { __mainLoop: { gaps: number[] } }).__mainLoop.gaps
  const stalls = gaps.filter(gap => gap >= 20)
  const summary = { longestMs: Math.round(Math.max(0, ...gaps)), stalls20: stalls.length, stalls50: stalls.filter(gap => gap >= 50).length, stalls100: stalls.filter(gap => gap >= 100).length, stalledMs: Math.round(stalls.reduce((sum, gap) => sum + gap, 0)) }
  gaps.length = 0
  return summary
})

interface Pids { main: number; renderer: number }
/** Proportional memory of a process on Linux, what it holds less its share of what others hold too. Elsewhere its working set. */
async function pssMiB(launched: LaunchedSotto, pid: number): Promise<number> {
  if (process.platform === 'linux') {
    const text = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8').catch(() => '')
    const found = /^Pss:\s+(\d+) kB/mu.exec(text)
    if (found) return Number(found[1]) / 1024
  }
  return launched.app.evaluate(({ app }, pid) => (app.getAppMetrics().find(item => item.pid === pid)?.memory.workingSetSize ?? 0) / 1024, pid)
}
/** Samples the window's memory every 100 ms until stopped, from outside the app. */
function memorySampler(launched: LaunchedSotto, pids: Pids) {
  const peak = { renderer: 0, main: 0 }
  let running = true
  const loop = (async () => {
    while (running) {
      const [renderer, main] = await Promise.all([pssMiB(launched, pids.renderer), pssMiB(launched, pids.main)])
      peak.renderer = Math.max(peak.renderer, renderer); peak.main = Math.max(peak.main, main)
      await sleep(100)
    }
  })()
  return { take: () => { const now = { ...peak }; peak.renderer = 0; peak.main = 0; return now }, stop: async () => { running = false; await loop } }
}

async function metrics(session: CDPSession): Promise<Record<string, number>> {
  const { metrics } = await session.send('Performance.getMetrics')
  return Object.fromEntries(metrics.map(item => [item.name, item.value]))
}
function workBetween(before: Record<string, number>, after: Record<string, number>) {
  const ms = (name: string) => Math.round((after[name]! - before[name]!) * 10_000) / 10
  return { taskMs: ms('TaskDuration'), scriptMs: ms('ScriptDuration'), layoutMs: ms('LayoutDuration'), styleMs: ms('RecalcStyleDuration'),
    layouts: after.LayoutCount! - before.LayoutCount!, styles: after.RecalcStyleCount! - before.RecalcStyleCount! }
}

/**
 * Presses a sidebar row and answers, from the press: when the thread's last reply is in the pane and two frames have
 * drawn, and when every tile near the view holds its picture. Both are taken in the page, so nothing crosses a process.
 */
async function pressRow(page: Page, title: string, marker: string, tiles: boolean) {
  const row = page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: title, exact: true })
  return row.evaluate(async (button: HTMLElement, { marker, tiles }) => {
    const pane = () => document.querySelector('section.thread-pane:not([data-hidden])')
    const frame = () => new Promise(done => requestAnimationFrame(done))
    const started = performance.now()
    button.click()
    for (;;) {
      const messages = pane()?.querySelectorAll('.thread-message')
      if (messages?.length && messages[messages.length - 1]!.textContent!.includes(marker)) break
      await frame()
      if (performance.now() - started > 180_000) throw new Error('The thread never opened.')
    }
    await frame(); await frame()
    const openedMs = performance.now() - started
    if (!tiles) return { openedMs: Math.round(openedMs), tilesMs: Math.round(openedMs), nearTiles: 0, shownTiles: 0, tiles: 0 }
    for (;;) {
      const scroller = pane()!.querySelector('.thread-workspace__transcript')!
      const view = scroller.getBoundingClientRect()
      const figures = [...pane()!.querySelectorAll('.thread-media')]
      const near = figures.filter(figure => { const box = figure.getBoundingClientRect(); return box.bottom >= view.top - view.height * 1.5 && box.top <= view.bottom + view.height * 1.5 })
      if (near.length && near.every(figure => { const image = figure.querySelector('img'); return image?.complete === true && image.naturalWidth > 0 })) {
        const shown = near.filter(figure => { const box = figure.getBoundingClientRect(); return box.bottom >= view.top && box.top <= view.bottom })
        return { openedMs: Math.round(openedMs), tilesMs: Math.round(performance.now() - started), nearTiles: near.length, shownTiles: shown.length, tiles: figures.length }
      }
      await new Promise(done => setTimeout(done, 33))
      if (performance.now() - started > 180_000) throw new Error('The tiles never loaded.')
    }
  }, { marker, tiles })
}

/** The same press as `pressRow`, as a plain function for a window no debugger is on. */
async function PRESS_IN_PAGE(title: string, marker: string, tiles: boolean): Promise<{ openedMs: number; tilesMs: number; tiles: number }> {
  const sidebar = document.querySelector('[aria-label="Thread sidebar"]')!
  const button = [...sidebar.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === title || item.textContent!.trim().startsWith(title))!
  const pane = () => document.querySelector('section.thread-pane:not([data-hidden])')
  const frame = () => new Promise(done => requestAnimationFrame(done))
  const started = performance.now()
  button.click()
  for (;;) {
    const messages = pane()?.querySelectorAll('.thread-message')
    if (messages?.length && messages[messages.length - 1]!.textContent!.includes(marker)) break
    await frame()
    if (performance.now() - started > 180_000) throw new Error('The thread never opened.')
  }
  await frame(); await frame()
  const openedMs = Math.round(performance.now() - started)
  if (!tiles) return { openedMs, tilesMs: openedMs, tiles: 0 }
  for (;;) {
    const view = pane()!.querySelector('.thread-workspace__transcript')!.getBoundingClientRect()
    const figures = [...pane()!.querySelectorAll('.thread-media')]
    const near = figures.filter(figure => { const box = figure.getBoundingClientRect(); return box.bottom >= view.top - view.height * 1.5 && box.top <= view.bottom + view.height * 1.5 })
    if (near.length && near.every(figure => { const image = figure.querySelector('img'); return image?.complete === true && image.naturalWidth > 0 })) return { openedMs, tilesMs: Math.round(performance.now() - started), tiles: figures.length }
    await new Promise(done => setTimeout(done, 33))
    if (performance.now() - started > 180_000) throw new Error('The tiles never loaded.')
  }
}
/** What the undriven window's frame log says, as a line of code for it to run. */
const FRAME_SUMMARY = `(() => { const log = window.__undriven; const gaps = log.slice(1).map((at, index) => at - log[index]); return { frames: gaps.length, longestFrameMs: Math.round(Math.max(0, ...gaps) * 10) / 10, over33: gaps.filter(gap => gap > 33.4).length, over50: gaps.filter(gap => gap > 50).length } })()`

/** Scrolls the transcript all the way up and back down at a set speed, taken from the clock so a slow frame cannot slow the trip. */
async function SCROLL_IN_PAGE(speed: number): Promise<{ px: number; height: number }> {
  const scroller = document.querySelector('section.thread-pane:not([data-hidden]) .thread-workspace__transcript')!
  const travel = async (from: number, to: number) => {
    const started = performance.now(), length = Math.abs(to - from), direction = Math.sign(to - from)
    for (;;) {
      await new Promise(done => requestAnimationFrame(done))
      const moved = (performance.now() - started) * speed / 1000
      scroller.scrollTop = from + direction * Math.min(moved, length)
      if (moved >= length) break
    }
  }
  const bottom = scroller.scrollHeight - scroller.clientHeight
  await travel(bottom, 0)
  await travel(0, bottom)
  return { px: bottom * 2, height: scroller.scrollHeight }
}
const scrollThrough = (page: Page) => page.evaluate(SCROLL_IN_PAGE, SCROLL_PX_PER_SECOND)

/** Jumps from the end to the top, and answers how long until the tiles now near hold their pictures. */
const jumpToTop = (page: Page) => page.evaluate(async () => {
  const pane = document.querySelector('section.thread-pane:not([data-hidden])')!
  const scroller = pane.querySelector('.thread-workspace__transcript')!
  const started = performance.now()
  scroller.scrollTop = 0
  await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  for (;;) {
    const view = scroller.getBoundingClientRect()
    const near = [...pane.querySelectorAll('.thread-media')].filter(figure => { const box = figure.getBoundingClientRect(); return box.bottom >= view.top - view.height * 1.5 && box.top <= view.bottom + view.height * 1.5 })
    if (near.every(figure => { const image = figure.querySelector('img'); return image?.complete === true && image.naturalWidth > 0 })) return { ms: Math.round(performance.now() - started), near: near.length }
    await new Promise(done => setTimeout(done, 33))
    if (performance.now() - started > 60_000) throw new Error('The tiles at the top never loaded.')
  }
})
const scrollToEnd = (page: Page) => page.evaluate(() => { const scroller = document.querySelector('section.thread-pane:not([data-hidden]) .thread-workspace__transcript')!; scroller.scrollTop = scroller.scrollHeight })

/**
 * Waits until main and the window have stopped working through what came before, so a phase's idle reading is idle. A
 * burst of pictures leaves main hashing and writing for a while after the last frame has gone by.
 */
async function quiet(launched: LaunchedSotto, session: CDPSession): Promise<void> {
  const cpu = () => launched.app.evaluate(() => { const used = process.cpuUsage(); return used.user + used.system })
  for (let waited = 0; waited < 45_000; waited += 500) {
    const main0 = await cpu(), window0 = await metrics(session)
    await sleep(500)
    const main1 = await cpu(), window1 = await metrics(session)
    if ((main1 - main0) / 1000 < 75 && workBetween(window0, window1).taskMs < 75) return
  }
}

interface UpdateWork { readonly updates: number; readonly rendererMsPerUpdate: number; readonly scriptMsPerUpdate: number; readonly layoutMsPerUpdate: number; readonly styleMsPerUpdate: number; readonly mainCpuMsPerUpdate: number; readonly longestFrameMs: number; readonly over50: number }
/** Drives `updates` of one kind at a set pace and answers what each cost beyond the same stretch of doing nothing. */
async function timedUpdates(launched: LaunchedSotto, session: CDPSession, count: number, gapMs: number, drive: (index: number) => Promise<void>): Promise<UpdateWork> {
  const { page } = launched
  const cpu = () => launched.app.evaluate(() => process.cpuUsage())
  await quiet(launched, session)
  const idleMs = Math.min(4_000, count * gapMs)
  const idle0 = await metrics(session), idleCpu0 = await cpu()
  await sleep(idleMs)
  const idle1 = await metrics(session), idleCpu1 = await cpu()
  const idleTask = workBetween(idle0, idle1).taskMs / idleMs
  const idleMain = (idleCpu1.user + idleCpu1.system - idleCpu0.user - idleCpu0.system) / 1000 / idleMs
  await startLog(page)
  const before = await metrics(session), cpu0 = await cpu()
  const started = performance.now()
  for (let index = 0; index < count; index++) {
    await drive(index)
    await sleep(Math.max(0, started + (index + 1) * gapMs - performance.now()))
  }
  // Let the last publish land inside the measurement.
  await sleep(500)
  const elapsed = performance.now() - started
  const after = await metrics(session), cpu1 = await cpu()
  const log = await readLog(page)
  const work = workBetween(before, after)
  return { updates: count, rendererMsPerUpdate: round((work.taskMs - idleTask * elapsed) / count, 2), scriptMsPerUpdate: round(work.scriptMs / count, 2),
    layoutMsPerUpdate: round(work.layoutMs / count, 2), styleMsPerUpdate: round(work.styleMs / count, 2),
    mainCpuMsPerUpdate: round(((cpu1.user + cpu1.system - cpu0.user - cpu0.system) / 1000 - idleMain * elapsed) / count, 2),
    longestFrameMs: log.longestFrameMs, over50: log.over50 }
}

/** The cost of updates arriving while the thread works: words of a reply, and steps, with `tilesInTurn` pictures in the working turn. */
async function updatesPhase(launched: LaunchedSotto, session: CDPSession, root: string, threadId: string, tilesInTurn: number, plainInTurn: number, pictureSteps: boolean, around: <T>(work: () => Promise<T>) => Promise<T> = work => work()) {
  const { page } = launched
  await send(page, threadId, 'One more change, then look at the page again.')
  const fake = await aliveSession(root)
  const results: Record<string, UpdateWork> = {}
  let number = 0
  const steps: object[][] = []
  for (let at = 0; at < tilesInTurn; at++) steps.push(stepFrames(fake, await pictureFile(at)))
  for (let at = 0; at < plainInTurn; at++) steps.push(stepFrames(fake, undefined))
  for (let at = 0; at < steps.length; at += 30) await act(root, fake, { type: 'raw-burst', persist: true, frames: steps.slice(at, at + 30).flat() })
  await sleep(4_000)
  results.steps = await around(() => timedUpdates(launched, session, 20, 250, async () => { await act(root, fake, { type: 'raw-burst', persist: true, frames: stepFrames(fake, undefined) }) }))
  await act(root, fake, { type: 'raw', frame: replyStartFrame(fake) })
  results.chunks = await timedUpdates(launched, session, 40, 50, async index => { await act(root, fake, { type: 'raw', frame: chunkFrame(fake, `word${index} `) }) })
  if (pictureSteps) {
    number = 400
    results.pictureSteps = await timedUpdates(launched, session, 10, 500, async () => { await act(root, fake, { type: 'raw-burst', persist: true, frames: stepFrames(fake, await pictureFile(number++)) }) })
  }
  await act(root, fake, { type: 'complete', text: 'That change is done.' })
  await threadIdle(page, threadId)
  return results
}

/** Counters on main for the counted pass: every picture read and its bytes, every decode and its time, every broadcast and its bytes. */
const installCounters = (launched: LaunchedSotto) => launched.app.evaluate(({ BrowserWindow, ipcMain, nativeImage }, channel) => {
  const counts = { media: { tile: { calls: 0, bytes: 0, ms: 0 }, full: { calls: 0, bytes: 0, ms: 0 } }, decode: { calls: 0, ms: 0, bytes: 0 }, resize: { calls: 0, ms: 0 }, jpeg: { calls: 0, ms: 0, bytes: 0 }, sends: {} as Record<string, { calls: number; bytes: number }> }
  ;(globalThis as unknown as { __counts: typeof counts }).__counts = counts
  const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, payload: { size: 'tile' | 'full' }) => Promise<{ dataUrl: string } | null>> })._invokeHandlers
  const original = handlers.get(channel)!
  handlers.set(channel, async (event, payload) => {
    const started = performance.now()
    const answer = await original(event, payload)
    const line = counts.media[payload.size]
    line.calls += 1; line.ms += performance.now() - started; line.bytes += answer?.dataUrl.length ?? 0
    return answer
  })
  // A NativeImage's methods are its own, so each is timed on the image main is about to use.
  const timeResized = (image: Electron.NativeImage) => {
    const encoding = image.toJPEG
    image.toJPEG = (quality: number) => { const started = performance.now(); const made = encoding.call(image, quality); counts.jpeg.calls += 1; counts.jpeg.ms += performance.now() - started; counts.jpeg.bytes += made.length; return made }
    return image
  }
  const decoding = nativeImage.createFromDataURL
  nativeImage.createFromDataURL = (url: string) => {
    const started = performance.now()
    const image = decoding.call(nativeImage, url)
    counts.decode.calls += 1; counts.decode.ms += performance.now() - started; counts.decode.bytes += url.length
    const resizing = image.resize
    image.resize = (options: Electron.ResizeOptions) => { const begun = performance.now(); const made = resizing.call(image, options); counts.resize.calls += 1; counts.resize.ms += performance.now() - begun; return timeResized(made) }
    return image
  }
  const contents = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))!.webContents
  const sending = contents.send
  contents.send = function (this: unknown, name: string, ...rest: unknown[]) {
    const line = counts.sends[name] ??= { calls: 0, bytes: 0 }
    line.calls += 1; line.bytes += JSON.stringify(rest)?.length ?? 0
    return sending.call(contents, name, ...rest)
  } as typeof contents.send
}, AGENT_THREAD_MEDIA)
const takeCounts = (launched: LaunchedSotto) => launched.app.evaluate(() => {
  const held = globalThis as unknown as { __counts: Record<string, unknown> }
  const copy = JSON.parse(JSON.stringify(held.__counts)) as Record<string, unknown>
  const empty = (value: unknown): void => { if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { if (typeof item === 'number') (value as Record<string, number>)[key] = 0; else empty(item) } }
  empty(held.__counts)
  return copy
})

/** A detailed Chromium memory dump of the window's process, reduced to the sizes that say what holds its memory. */
async function memoryDump(session: CDPSession, rendererPid: number): Promise<Record<string, number>> {
  const events: { name?: string; ph?: string; pid?: number; args?: { dumps?: { allocators?: Record<string, { attrs?: Record<string, { value: string }> }> } } }[] = []
  const collect = (message: { value: typeof events }) => { events.push(...message.value) }
  session.on('Tracing.dataCollected', collect)
  await session.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], excludedCategories: ['*'], memoryDumpConfig: { triggers: [] } as unknown as Record<string, string> } })
  await session.send('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail: 'detailed' })
  const finished = new Promise<void>(done => session.once('Tracing.tracingComplete', () => done()))
  await session.send('Tracing.end')
  await finished
  session.off('Tracing.dataCollected', collect)
  const sizes: Record<string, number> = {}
  for (const event of events) {
    const allocators = event.args?.dumps?.allocators
    if (!allocators) continue
    if (event.pid !== rendererPid) continue
    for (const [name, allocator] of Object.entries(allocators)) {
      // The allocators' totals, and everything under the three that hold pictures.
      if (name.split('/').length > 1 && !/^(?:web_cache|cc|skia|gpu|partition_alloc\/partitions|malloc\/partitions)\b/u.test(name)) continue
      if (name.split('/').length > 3) continue
      const value = allocator.attrs?.size?.value
      if (value !== undefined) sizes[name] = parseInt(value, 16)
    }
  }
  return sizes
}
/** What the page itself holds as picture text: the data URLs its tiles are showing. */
const heldSources = (page: Page) => page.evaluate(() => {
  const sources = [...document.querySelectorAll<HTMLImageElement>('.thread-media img')].map(image => image.src)
  return { images: sources.length, bytes: sources.reduce((sum, source) => sum + source.length, 0), naturalPixels: [...document.querySelectorAll<HTMLImageElement>('.thread-media img')].slice(0, 1).map(image => `${image.naturalWidth}x${image.naturalHeight}`)[0] }
})

async function heap(session: CDPSession): Promise<number> {
  return round((await session.send('Runtime.getHeapUsage')).usedSize / MiB, 1)
}
async function collectGarbage(session: CDPSession): Promise<void> {
  for (let index = 0; index < 3; index++) { await session.send('HeapProfiler.collectGarbage'); await sleep(300) }
}

async function traceInto(launched: LaunchedSotto, path: string, work: () => Promise<unknown>): Promise<void> {
  await launched.app.evaluate(async ({ contentTracing }) => {
    await contentTracing.startRecording({ included_categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8'], excluded_categories: ['*'] })
  })
  await work()
  await launched.app.evaluate(async ({ contentTracing }, path) => { await contentTracing.stopRecording(path) }, path)
}

/** One launch of one case on a fresh copy of its profile, through every phase, in the order the note gives them. */
async function measureRun(item: Case, run: number, pass: string): Promise<Record<string, unknown>> {
  guardMemory()
  const source = profileOf(item.tiles)
  const profile = join(ROOT, `sotto-e2e-run-${item.id}-${process.pid}`)
  await rm(profile, { recursive: true, force: true })
  await cp(source, profile, { recursive: true })
  const { threadId } = JSON.parse(await readFile(join(profile, 'fixture.json'), 'utf8')) as { threadId: string }
  const claudeRoot = join(profile, 'native-fixture', 'claude')
  const traces = join(ROOT, 'traces', `${item.id}-${run}`)
  if (pass === 'trace') await mkdir(traces, { recursive: true })
  const expected = item.owl ? item.tiles : 0
  const launched = await launch(profile, item.owl)
  try {
    const { page, app } = launched
    await resizeWindow(launched, 1280, 800)
    await openThreads(page)
    const session = await page.context().newCDPSession(page)
    await session.send('Performance.enable')
    if (THROTTLE !== 1) await session.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
    const pids = await app.evaluate(({ BrowserWindow }) => ({ main: process.pid, renderer: BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!.webContents.getOSProcessId() }))
    await instrumentPage(page)
    if (pass === 'counted') await installCounters(launched)
    await pressRow(page, SIDE_TITLE, SIDE_REPLY, false)
    await sleep(5_000)
    await collectGarbage(session)
    await sleep(500)
    const result: Record<string, unknown> = { case: item.id, run, scale: SCALE, throttle: THROTTLE, pids, load: loadavg()[0], baseline: { rendererMiB: round(await pssMiB(launched, pids.renderer)), mainMiB: round(await pssMiB(launched, pids.main)), heapMiB: await heap(session) } }
    const sampler = memorySampler(launched, pids)
    if (pass === 'counted') await takeCounts(launched)
    await watchMainLoop(launched)
    await startLog(page)
    let before = await metrics(session)
    let timing!: Awaited<ReturnType<typeof pressRow>>
    const open = async () => { timing = await pressRow(page, THREAD_TITLE, LAST_REPLY, expected > 0) }
    if (pass === 'trace') await traceInto(launched, join(traces, 'open.json'), open); else await open()
    expect(timing.tiles).toBe(expected)
    await sleep(1_500)
    result.open = { ...timing, frames: await readLog(page), work: workBetween(before, await metrics(session)), mainLoop: await readMainLoop(launched), peak: sampler.take() }
    if (pass === 'counted') result.openCounts = await takeCounts(launched)
    await sleep(6_000)
    result.settled = { rendererMiB: round(await pssMiB(launched, pids.renderer)), mainMiB: round(await pssMiB(launched, pids.main)), heapMiB: await heap(session), nodes: (await metrics(session)).Nodes }
    if (pass === 'counted') {
      result.settledDump = await memoryDump(session, pids.renderer); result.settledSources = await heldSources(page)
      result.shape = await page.evaluate(async id => {
        const answer = await window.sotto!.agents!.threadDetail!(id) as { activities?: { media?: unknown[]; kind?: string }[]; messages?: unknown[] } | null
        return { records: answer?.activities?.length, messages: answer?.messages?.length, pictures: answer?.activities?.reduce((sum, record) => sum + (record.media?.length ?? 0), 0) }
      }, threadId)
      await page.screenshot({ path: join(ROOT, `open-${item.id}.png`) })
    }
    // Switching away and back, three times; the pane is met again each time.
    const switches: unknown[] = []
    for (let index = 0; index < 3; index++) {
      await pressRow(page, SIDE_TITLE, SIDE_REPLY, false)
      await sleep(1_500)
      await startLog(page)
      before = await metrics(session)
      let back!: Awaited<ReturnType<typeof pressRow>>
      const press = async () => { back = await pressRow(page, THREAD_TITLE, LAST_REPLY, expected > 0) }
      if (pass === 'trace' && index === 2) await traceInto(launched, join(traces, 'switch.json'), press); else await press()
      await sleep(1_000)
      switches.push({ ...back, frames: await readLog(page), work: workBetween(before, await metrics(session)) })
    }
    result.switchBack = switches
    await readMainLoop(launched)
    if (pass === 'counted') result.switchCounts = await takeCounts(launched)
    sampler.take()
    await sleep(2_000)
    await startLog(page)
    before = await metrics(session)
    let trip!: Awaited<ReturnType<typeof scrollThrough>>
    const scroll = async () => { trip = await scrollThrough(page) }
    if (pass === 'trace') await traceInto(launched, join(traces, 'scroll.json'), scroll); else await scroll()
    result.scroll = { ...trip, frames: await readLog(page), work: workBetween(before, await metrics(session)), mainLoop: await readMainLoop(launched), peak: sampler.take() }
    if (pass === 'counted') result.scrollCounts = await takeCounts(launched)
    await sleep(2_000)
    if (expected > 0) {
      result.jump = await jumpToTop(page)
      await readMainLoop(launched)
      if (pass === 'counted') result.jumpCounts = await takeCounts(launched)
      await sleep(1_000)
    }
    await scrollToEnd(page)
    await sleep(6_000)
    result.afterScroll = { rendererMiB: round(await pssMiB(launched, pids.renderer)), mainMiB: round(await pssMiB(launched, pids.main)), heapMiB: await heap(session) }
    if (pass === 'counted') { result.afterScrollDump = await memoryDump(session, pids.renderer); result.afterScrollSources = await heldSources(page) }
    await collectGarbage(session)
    await sleep(1_000)
    result.afterGc = { rendererMiB: round(await pssMiB(launched, pids.renderer)), heapMiB: await heap(session) }
    if (pass === 'counted') await takeCounts(launched)
    // The working turn holds pictures in the cases that have them, at most the thread's biggest run; plain steps otherwise.
    const inTurn = Math.min(expected, 76)
    const updates = () => updatesPhase(launched, session, claudeRoot, threadId, inTurn, 76 - inTurn, item.owl && item.tiles > 0)
    let worked!: Awaited<ReturnType<typeof updates>>
    if (pass === 'trace') await traceInto(launched, join(traces, 'updates.json'), async () => { worked = await updates() }); else worked = await updates()
    result.updates = worked
    result.updatesPeak = sampler.take()
    if (pass === 'counted') {
      result.updateCounts = await takeCounts(launched)
      // More trips through the same thread: does what the window holds level off, or keep growing?
      await scrollToEnd(page)
      const trips: unknown[] = []
      for (let trip = 1; trip <= 3; trip++) {
        await startLog(page)
        await scrollThrough(page)
        await sleep(2_000)
        trips.push({ trip, rendererMiB: round(await pssMiB(launched, pids.renderer)), mainMiB: round(await pssMiB(launched, pids.main)), frames: await readLog(page), counts: await takeCounts(launched), dump: await memoryDump(session, pids.renderer) })
      }
      result.trips = trips
      await sleep(30_000)
      result.after30s = { rendererMiB: round(await pssMiB(launched, pids.renderer)), mainMiB: round(await pssMiB(launched, pids.main)), dump: await memoryDump(session, pids.renderer) }
      // What the window hands back when the computer says it is short of memory, as a laptop near its limit would.
      await session.send('Memory.simulatePressureNotification', { level: 'critical' })
      await sleep(3_000)
      result.afterPressure = { rendererMiB: round(await pssMiB(launched, pids.renderer)), dump: await memoryDump(session, pids.renderer) }
    }
    await sampler.stop()
    return result
  } finally {
    await closeSotto(launched)
    await rm(profile, { recursive: true, force: true })
  }
}

/** The update's cost by how many pictures the working turn holds: a thread of 1,322 plain steps, then 275 more steps of which `tiles` have pictures. */
/** Self time by function from a V8 CPU profile, the busiest first: names and file ends only. */
function selfTimes(profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples?: number[]; timeDeltas?: number[] }): { name: string; ms: number }[] {
  const byNode = new Map(profile.nodes.map(node => [node.id, node.callFrame]))
  const totals = new Map<string, number>()
  profile.samples?.forEach((sample, index) => {
    const frame = byNode.get(sample)
    if (!frame) return
    const name = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop() ?? ''}`.trim()
    totals.set(name, (totals.get(name) ?? 0) + (profile.timeDeltas?.[index] ?? 0) / 1000)
  })
  return [...totals].map(([name, ms]) => ({ name, ms: round(ms) })).sort((a, b) => b.ms - a.ms).slice(0, 40)
}

/** Each thread of a process with the CPU it has used, in ms, on Linux. */
async function threadTimes(pid: number): Promise<Record<string, number>> {
  const times: Record<string, number> = {}
  for (const task of await readdir(`/proc/${pid}/task`).catch(() => [] as string[])) {
    const stat = await readFile(`/proc/${pid}/task/${task}/stat`, 'utf8').catch(() => '')
    const end = stat.lastIndexOf(')')
    if (end < 0) continue
    const fields = stat.slice(end + 2).split(' ')
    const name = stat.slice(stat.indexOf('(') + 1, end)
    times[name] = (times[name] ?? 0) + (Number(fields[11]) + Number(fields[12])) * 10
  }
  return times
}

/** Runs `work` with main and the window under the CPU profiler, and keeps both profiles' busiest functions. */
function profilingInto(launched: LaunchedSotto, session: CDPSession, into: Record<string, unknown>) {
  return async <T>(work: () => Promise<T>): Promise<T> => {
    const pid = await launched.app.evaluate(() => process.pid)
    await takeCounts(launched)
    const threads0 = await threadTimes(pid)
    await session.send('Profiler.enable')
    await session.send('Profiler.start')
    await launched.app.evaluate(() => {
      const { Session } = process.getBuiltinModule('node:inspector')
      const inspector = new Session()
      inspector.connect()
      inspector.post('Profiler.enable')
      inspector.post('Profiler.start')
      ;(globalThis as unknown as { __profiler: typeof inspector }).__profiler = inspector
    })
    const answer = await work()
    const threads1 = await threadTimes(pid)
    into.mainThreadsMs = Object.fromEntries(Object.entries(threads1).map(([name, ms]) => [name, ms - (threads0[name] ?? 0)]).filter(([, ms]) => (ms as number) >= 20))
    into.counts = await takeCounts(launched)
    const main = await launched.app.evaluate(() => new Promise<string>((done, fail) => {
      const inspector = (globalThis as unknown as { __profiler: import('node:inspector').Session }).__profiler
      inspector.post('Profiler.stop', (error, result) => { inspector.disconnect(); if (error) fail(error); else done(JSON.stringify(result.profile)) })
    }))
    into.main = selfTimes(JSON.parse(main) as Parameters<typeof selfTimes>[0])
    into.window = selfTimes((await session.send('Profiler.stop')).profile as Parameters<typeof selfTimes>[0])
    return answer
  }
}

async function sweepRun(tiles: number, run: number, profiled = false): Promise<Record<string, unknown>> {
  guardMemory()
  const profile = join(ROOT, `sotto-e2e-sweep-${tiles}-${process.pid}`)
  await rm(profile, { recursive: true, force: true })
  await cp(profileOf(0), profile, { recursive: true })
  const { threadId } = JSON.parse(await readFile(join(profile, 'fixture.json'), 'utf8')) as { threadId: string }
  const launched = await launch(profile, true)
  try {
    const { page } = launched
    await resizeWindow(launched, 1280, 800)
    await openThreads(page)
    const session = await page.context().newCDPSession(page)
    await session.send('Performance.enable')
    await instrumentPage(page)
    if (profiled) await installCounters(launched)
    await pressRow(page, THREAD_TITLE, LAST_REPLY, false)
    await sleep(3_000)
    const profiles: Record<string, unknown> = {}
    const updates = await updatesPhase(launched, session, join(profile, 'native-fixture', 'claude'), threadId, tiles, 275 - tiles, false, profiled ? profilingInto(launched, session, profiles) : undefined)
    return { tilesInTurn: tiles, run, load: loadavg()[0], updates, ...profiled ? { profiles } : {} }
  } finally {
    await closeSotto(launched)
    await rm(profile, { recursive: true, force: true })
  }
}

/** The app started with Node's inspector on main and nothing on the window, and how to ask main and the window things. */
async function launchUndriven(profile: string, owl: boolean) {
  process.env.SOTTO_E2E_NATIVE_FIXTURE_ROOT = join(profile, 'native-fixture')
  process.env.SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE = process.execPath
  process.env.SOTTO_OWL_FEATURES = `inline-media=${owl ? 1 : 0}`
  const child = spawn(createRequire(resolve('package.json'))('electron') as unknown as string, ['--inspect=0', 'out/main/index.js'], { env: e2eEnvironment('success', profile), stdio: ['ignore', 'ignore', 'pipe'] })
  const url = await new Promise<string>((done, fail) => {
    let seen = ''
    child.stderr.on('data', (part: Buffer) => { seen += String(part); const found = /ws:\/\/\S+/u.exec(seen); if (found) done(found[0]) })
    child.once('exit', () => fail(new Error('The app exited before its inspector opened.')))
  })
  const socket = new WebSocket(url)
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail })
  let nextId = 0
  interface InspectorAnswer { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } } }
  const waiting = new Map<number, (answer: InspectorAnswer) => void>()
  socket.onmessage = event => { const answer = JSON.parse(String(event.data)) as InspectorAnswer; if (answer.id !== undefined) { waiting.get(answer.id)?.(answer); waiting.delete(answer.id) } }
  const inMain = async (expression: string): Promise<unknown> => {
    const id = ++nextId
    const answer = await new Promise<InspectorAnswer>(done => {
      waiting.set(id, done)
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, includeCommandLineAPI: true, awaitPromise: true, returnByValue: true } }))
    })
    if (answer.result?.exceptionDetails) throw new Error(answer.result.exceptionDetails.exception?.description ?? answer.result.exceptionDetails.text)
    return answer.result?.result?.value
  }
  const WINDOW = "require('electron').BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/index.html'))"
  // Main's own start can be mid-module when the inspector first answers, so an early refusal is only a retry.
  await expect.poll(() => inMain(`Boolean(${WINDOW}?.webContents.isLoading() === false)`).catch(() => false), { timeout: 60_000 }).toBe(true)
  const inPage = (code: string): Promise<unknown> => inMain(`${WINDOW}.webContents.executeJavaScript(${JSON.stringify(code)}, true)`)
  const pids = await inMain(`({ main: process.pid, renderer: ${WINDOW}.webContents.getOSProcessId() })`) as Pids
  await inMain(`${WINDOW}.setSize(1280, 800)`)
  await expect.poll(() => inPage('Boolean(window.sotto?.agents)'), { timeout: 60_000 }).toBe(true)
  const close = async () => {
    socket.close()
    child.kill()
    await new Promise(done => { if (child.exitCode !== null) done(null); else child.once('exit', done); setTimeout(done, 10_000) })
  }
  return { inMain, inPage, pids, close }
}

/** CPU a process has used, whole and on its main thread, in ms, from /proc. */
async function cpuOf(pid: number): Promise<{ all: number; thread: number }> {
  const parse = (stat: string) => { const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); return (Number(fields[11]) + Number(fields[12])) * 10 }
  return { all: parse(await readFile(`/proc/${pid}/stat`, 'utf8')), thread: parse(await readFile(`/proc/${pid}/task/${pid}/stat`, 'utf8')) }
}

/** One launch with no debugger on the window: open, one trip, and updates, read from outside. */
async function undrivenRun(tiles: number, tilesInTurn: number, plainInTurn: number, warning: boolean, run: number, phases: 'all' | 'updates'): Promise<Record<string, unknown>> {
  guardMemory()
  const profile = join(ROOT, `sotto-e2e-undriven-${process.pid}`)
  await rm(profile, { recursive: true, force: true })
  await cp(profileOf(tiles), profile, { recursive: true })
  const { threadId } = JSON.parse(await readFile(join(profile, 'fixture.json'), 'utf8')) as { threadId: string }
  const root = join(profile, 'native-fixture', 'claude')
  const app = await launchUndriven(profile, true)
  const pss = async (pid: number) => { const found = /^Pss:\s+(\d+) kB/mu.exec(await readFile(`/proc/${pid}/smaps_rollup`, 'utf8')); return round(Number(found?.[1] ?? 0) / 1024) }
  const quietOutside = async () => {
    for (let waited = 0; waited < 45_000; waited += 500) {
      const main0 = await cpuOf(app.pids.main), window0 = await cpuOf(app.pids.renderer)
      await sleep(500)
      const main1 = await cpuOf(app.pids.main), window1 = await cpuOf(app.pids.renderer)
      if (main1.all - main0.all < 100 && window1.all - window0.all < 100) return
    }
  }
  /** Per-update CPU of main and the window beyond the same stretch idle, read from /proc. */
  const timed = async (count: number, gapMs: number, drive: (index: number) => Promise<void>) => {
    await quietOutside()
    const idleMs = Math.max(2_000, count * gapMs)
    const idle0 = { main: await cpuOf(app.pids.main), window: await cpuOf(app.pids.renderer) }
    await sleep(idleMs)
    const idle1 = { main: await cpuOf(app.pids.main), window: await cpuOf(app.pids.renderer) }
    await app.inPage('(() => { const log = window.__undriven; log.length = 0 })()')
    const before = { main: await cpuOf(app.pids.main), window: await cpuOf(app.pids.renderer) }
    const started = performance.now()
    for (let index = 0; index < count; index++) { await drive(index); await sleep(Math.max(0, started + (index + 1) * gapMs - performance.now())) }
    await sleep(500)
    const elapsed = performance.now() - started
    const after = { main: await cpuOf(app.pids.main), window: await cpuOf(app.pids.renderer) }
    const net = (side: 'main' | 'window', part: 'all' | 'thread') => round(((after[side][part] - before[side][part]) - (idle1[side][part] - idle0[side][part]) * elapsed / idleMs) / count, 1)
    const frames = await app.inPage(FRAME_SUMMARY) as Record<string, number>
    return { updates: count, windowAll: net('window', 'all'), windowThread: net('window', 'thread'), mainAll: net('main', 'all'), mainThread: net('main', 'thread'), ...frames }
  }
  try {
    await app.inPage(`(async () => {
      if (!document.querySelector('.threads-view')) [...document.querySelectorAll('a,[role="tab"]')].find(item => item.textContent.trim() === 'Threads' || item.getAttribute('aria-label') === 'Threads')?.click()
      for (let tries = 0; tries < 300 && !document.querySelector('.threads-view'); tries++) await new Promise(done => setTimeout(done, 100))
    })()`)
    await app.inPage(`(() => { const log = window.__undriven = []; const tick = () => { log.push(performance.now()); requestAnimationFrame(tick) }; requestAnimationFrame(tick) })()`)
    if (!warning) await app.inPage(`(${SILENCE_TILE_WARNING.toString()})()`)
    const press = (title: string, marker: string, expectTiles: boolean) => app.inPage(`(${PRESS_IN_PAGE.toString()})(${JSON.stringify(title)}, ${JSON.stringify(marker)}, ${String(expectTiles)})`) as Promise<{ openedMs: number; tilesMs: number; tiles: number }>
    await press(SIDE_TITLE, SIDE_REPLY, false)
    await sleep(4_000)
    const result: Record<string, unknown> = { tiles, tilesInTurn, warning, run, load: loadavg()[0], baseline: { renderer: await pss(app.pids.renderer), main: await pss(app.pids.main) } }
    const cpu0 = { main: await cpuOf(app.pids.main), window: await cpuOf(app.pids.renderer) }
    result.open = await press(THREAD_TITLE, LAST_REPLY, tiles > 0 && phases === 'all')
    await sleep(1_500)
    const cpu1 = { main: await cpuOf(app.pids.main), window: await cpuOf(app.pids.renderer) }
    result.openCpu = { main: cpu1.main.all - cpu0.main.all, mainThread: cpu1.main.thread - cpu0.main.thread, window: cpu1.window.all - cpu0.window.all, windowThread: cpu1.window.thread - cpu0.window.thread }
    if (phases === 'all') {
      await sleep(3_000)
      result.settled = { renderer: await pss(app.pids.renderer), main: await pss(app.pids.main) }
      await press(SIDE_TITLE, SIDE_REPLY, false)
      await sleep(3_000)
      result.back = await press(THREAD_TITLE, LAST_REPLY, tiles > 0)
      await sleep(3_000)
      await app.inPage('window.__undriven.length = 0')
      const cpu2 = { main: await cpuOf(app.pids.main), window: await cpuOf(app.pids.renderer) }
      const trip = await app.inPage(`(${SCROLL_IN_PAGE.toString()})(${SCROLL_PX_PER_SECOND})`)
      const cpu3 = { main: await cpuOf(app.pids.main), window: await cpuOf(app.pids.renderer) }
      result.scroll = { trip, frames: await app.inPage(FRAME_SUMMARY), cpu: { main: cpu3.main.all - cpu2.main.all, mainThread: cpu3.main.thread - cpu2.main.thread, window: cpu3.window.all - cpu2.window.all, windowThread: cpu3.window.thread - cpu2.window.thread } }
      await sleep(6_000)
      result.afterScroll = { renderer: await pss(app.pids.renderer), main: await pss(app.pids.main) }
      await app.inPage("(() => { const scroller = document.querySelector('section.thread-pane:not([data-hidden]) .thread-workspace__transcript'); scroller.scrollTop = scroller.scrollHeight })()")
    }
    await app.inPage(`window.sotto.agents.command({ type: 'manual-send', threadId: ${JSON.stringify(threadId)}, text: 'One more change, then look at the page again.' }).then(() => null)`)
    const fake = await aliveSession(root)
    const steps: object[][] = []
    for (let at = 0; at < tilesInTurn; at++) steps.push(stepFrames(fake, await pictureFile(at)))
    for (let at = 0; at < plainInTurn; at++) steps.push(stepFrames(fake, undefined))
    for (let at = 0; at < steps.length; at += 30) await act(root, fake, { type: 'raw-burst', persist: true, frames: steps.slice(at, at + 30).flat() })
    await sleep(2_000)
    result.steps = await timed(20, 250, async () => { await act(root, fake, { type: 'raw-burst', persist: true, frames: stepFrames(fake, undefined) }) })
    await act(root, fake, { type: 'raw', frame: replyStartFrame(fake) })
    result.chunks = await timed(40, 50, async index => { await act(root, fake, { type: 'raw', frame: chunkFrame(fake, `word${index} `) }) })
    return result
  } finally {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  }
}

test.describe.configure({ mode: 'serial' })
test.skip(!PERF_BENCH, 'A timing benchmark: run with SOTTO_PERF_BENCH=1 after npm run build.')

test(`thread pictures: ${PASS}`, async () => {
  test.setTimeout(0)
  await mkdir(ROOT, { recursive: true })
  const output = join(ROOT, `results-${PASS}${LABEL ? `-${LABEL}` : ''}.jsonl`)
  const save = async (line: Record<string, unknown>) => {
    await appendFile(output, `${JSON.stringify(line)}\n`)
    // Sizes, counts and times only: nothing here holds a thread's words.
    console.log(`${String(line.case ?? line.tilesInTurn)} run ${String(line.run)} saved`)
  }
  if (PASS === 'seed') {
    for (const tiles of [...new Set(CASES.map(item => item.tiles))]) {
      if (existsSync(join(profileOf(tiles), 'fixture.json'))) continue
      await seed(tiles)
      console.log(`seeded ${tiles} pictures, ${FIXTURE_STEPS} steps`)
    }
    return
  }
  if (PASS === 'undriven') {
    // One launch that fails is said and tried again, so a long series is not lost to it; the failure stays in the log.
    const once = async (arm: string, ...options: Parameters<typeof undrivenRun>) => {
      try { await save({ arm, ...await undrivenRun(...options) }) } catch (error) {
        console.log(`undriven run failed, trying again: ${String(error).slice(0, 400)}`)
        await save({ arm, retried: true, ...await undrivenRun(...options) })
      }
    }
    for (let run = 0; run < RUNS; run++) {
      // The fixture thread as a whole, with and without the warning, then a step's cost by the working turn's tiles.
      await once('thread', 0, 0, 76, true, run, 'all')
      await once('thread', 275, 76, 0, true, run, 'all')
      await once('thread', 275, 76, 0, false, run, 'all')
      for (const tilesInTurn of [0, 100, 275]) for (const warning of [true, false]) await once('sweep', 0, tilesInTurn, 275 - tilesInTurn, warning, run, 'updates')
    }
    return
  }
  if (PASS === 'profile') {
    for (let run = 0; run < RUNS; run++) for (const tiles of [0, 100, 275]) await save(await sweepRun(tiles, run, true))
    return
  }
  if (PASS === 'sweep') {
    // Round and round rather than one count at a time, so a neighbour's load falls on all of them alike.
    for (let run = 0; run < RUNS; run++) for (const tiles of SWEEP) await save(await sweepRun(tiles, run))
    return
  }
  for (let run = 0; run < RUNS; run++) for (const item of CASES) await save(await measureRun(item, run, PASS))
})
