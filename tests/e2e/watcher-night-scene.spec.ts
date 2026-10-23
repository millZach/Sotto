import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { E2E_THREADS_NOW } from '../../src/shared/e2e'
import type { WatcherRoomState } from '../../src/shared/watcherRoom'
import { WATCHER_STAND_IN_KEY, type WatcherStandInSeed } from '../../src/renderer/src/e2e/watcherStandIn'
import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { onReleaseTrack } from './support/releaseTrack'
import { captureWindow } from './support/sottoCapture'
import { openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { holdOwlSky } from './support/sottoOwl'
import { resizeContentWindow } from './support/sottoWindow'

/**
 * Watcher's night scene on the built app (Zach's picks on October 21 and 22, 2026, `prototype/watcher-owl-scene` and
 * `prototype/watcher-owl-family`): the ASCII night in the side margins of Watcher's room, with Watcher's owl and a thread
 * owl for each watched thread, at the three sizes in dark and light, with reduced motion, and live. Nothing may be drawn
 * in the column. A capture run's fixed clock holds the scene still with every owl sitting, so those captures repeat; a
 * newcomer's flight out of the moon, a press and the paint rates are checked on a live clock. Main's Watcher is stood in
 * for by a seeded projection, as in watcher.spec.ts. Run after `npm run build`. Captures go to disposable run evidence;
 * `SOTTO_E2E_EVIDENCE=publish` writes artifacts/watcher-owl-family.
 */
const evidence = evidenceDirectory('artifacts/watcher-owl-family')
/** The message scrubber's lane beside the column, which the scene keeps clear (ADR-0109). */
const scrubberEvidence = evidenceDirectory('artifacts/message-scrubber')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const CURRENT = 'release-notes'
const recorded: Record<string, unknown> = {}

function launchOptions(appearance: 'dark' | 'light', options: { readonly motion?: 'normal' | 'reduced'; readonly live?: boolean } = {}) {
  return {
    onboardingComplete: true, appearance, motion: options.motion ?? 'normal', agents: 'design-threads',
    // The capture scenario holds every clock still, the scene's included. A live run lets the owls fly, over the same
    // fixture threads: the workspace scenario loads them without the capture's fixed clock.
    scenario: options.live ? 'phase3-workspace' : 'design-threads',
    ...(appearance === 'dark' ? { darkTheme: 't3-code' } : { lightTheme: 't3-code' }),
  } as const
}

type Row = WatcherRoomState['watchedThreads'][number]
type Kind = 'running' | 'waiting' | 'idle'

/**
 * Seeds Watcher's projection: no Watcher yet (the first entry), or `release-notes` as a Watcher with a short
 * conversation, watching `watched` threads of the design fixture, and later the `later` threads too.
 */
async function seedRoom(page: Page, current: boolean, watched: ReadonlyArray<readonly [string, Kind]> = [], later?: { readonly afterMs: number; readonly watched: ReadonlyArray<readonly [string, Kind]> }): Promise<void> {
  const hostId = await page.evaluate(async () => (await window.sotto!.agents!.get()).hostId)
  expect(hostId, 'the window names its host').toBeTruthy()
  const target = (threadId: string) => ({ hostId: hostId!, threadId })
  const row = ([threadId, kind]: readonly [string, Kind]): Row => ({ target: target(threadId), title: threadId, watched: true, paused: false,
    status: kind === 'running' ? 'running' : 'idle', connected: true, settled: false, backgroundWorkCount: 0, participation: [],
    waitsOn: kind === 'waiting' ? [{ id: randomUUID(), kind: 'permission', openTarget: target(threadId) }] : [] })
  const identity = { target: target(CURRENT), projectId: 'workshop', provider: 'codex' as const, creationOperationId: randomUUID(),
    createdAt: new Date(E2E_THREADS_NOW - 60_000).toISOString() }
  const seed: WatcherStandInSeed = {
    state: {
      current: current ? identity : null,
      currentOptions: current ? { modelId: 'codex:gpt', reasoningEffort: null, runtimeMode: 'approval-required', status: 'idle', connected: true } : null,
      history: [], runtimeMode: 'approval-required', ownChanges: [], standingWatches: [], requests: [], watchedThreads: watched.map(row),
      receipts: [], recoveryNotice: null, observedAt: new Date(E2E_THREADS_NOW).toISOString(),
    },
    created: identity,
    ...(later === undefined ? {} : { script: [{ afterMs: later.afterMs, state: { watchedThreads: later.watched.map(row) } }] }),
  }
  await page.evaluate(async ({ key, seed, thread, current, asked }) => {
    localStorage.setItem(key, JSON.stringify(seed))
    if (current) await window.sottoE2E!.agentEvent!({ type: 'history', threadId: thread, text: '', messages: [
      { id: 'ask', role: 'user', text: 'Keep an eye on the footer links and the visual gate.', createdAt: asked },
    ] })
  }, { key: WATCHER_STAND_IN_KEY, seed, thread: CURRENT, current, asked: new Date(E2E_THREADS_NOW - 30_000).toISOString() })
  await page.reload()
  await openThreads(page)
}

async function openRoom(page: Page): Promise<void> {
  await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Watcher' })).toBeVisible()
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0)
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
}

async function capture(launched: LaunchedSotto, name: string): Promise<void> {
  await settle(launched.page)
  await holdOwlSky(launched.page)
  await captureWindow(launched.app, resolve(evidence, name))
}

/**
 * How many frames the scene paints over `ms`, and over how long, by the count an end-to-end run keeps on Watcher's pane.
 * Pixels alone cannot tell a scene holding still from one repainting the same picture.
 */
async function framesOver(page: Page, ms: number): Promise<{ readonly frames: number; readonly elapsed: number; readonly display: number }> {
  return page.evaluate(async wait => {
    const count = (): number => Number(document.getElementById('watcher-pane')?.dataset.nightSceneFrames ?? 0)
    const before = count(), start = performance.now()
    // The display's own frames over the same time, so a window the system throttles is told from a scene at rest.
    let display = 0, ticking = true
    const tick = (): void => { display++; if (ticking) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    await new Promise(done => setTimeout(done, wait))
    ticking = false
    return { frames: count() - before, elapsed: performance.now() - start, display }
  }, ms)
}

const land = (page: Page) => page.locator('#watcher-pane > canvas.watcher-scene--land')
const owl = (page: Page) => page.locator('#watcher-pane > canvas.watcher-scene--owl')
const owlButtons = (page: Page) => page.locator('#watcher-pane > .watcher-scene--owls > .watcher-scene__owl')

/**
 * The scene is decoration and lives only in the margins: both canvases hidden, never focusable, never pressed, and
 * not one painted pixel on either between the composer's sides, below the header, where the room's words are.
 */
async function sceneHolds(page: Page, key: string): Promise<void> {
  for (const canvas of [land(page), owl(page)]) {
    await expect(canvas).toHaveAttribute('aria-hidden', 'true')
    expect(await canvas.evaluate(node => [node.tabIndex, getComputedStyle(node).pointerEvents])).toEqual([-1, 'none'])
  }
  await expect(page.locator('#watcher-pane > .watcher-scene--owls')).toHaveAttribute('aria-hidden', 'true')
  const reading = await page.evaluate(() => {
    const pane = document.getElementById('watcher-pane')!
    const base = pane.getBoundingClientRect()
    const composer = pane.querySelector('.thread-workspace__compose .thread-prompt')!.getBoundingClientRect()
    const header = Math.max(...[...pane.querySelectorAll(':scope > :is(.watcher-head, .watcher-glance)')].map(node => node.getBoundingClientRect().bottom))
    const out: Record<string, number> = {}
    for (const canvas of pane.querySelectorAll<HTMLCanvasElement>(':scope > canvas.watcher-scene')) {
      const scale = canvas.width / canvas.clientWidth
      const x0 = Math.ceil((composer.left - base.left + 2) * scale), x1 = Math.floor((composer.right - base.left - 2) * scale)
      const y0 = Math.ceil((header - base.top) * scale), y1 = canvas.height
      const data = canvas.getContext('2d')!.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data
      let painted = 0
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) painted++
      out[canvas.className] = painted
    }
    return out
  })
  for (const [canvas, painted] of Object.entries(reading)) expect(painted, `${canvas} pixels in the column, ${key}`).toBe(0)
  recorded[key] = reading
}

/**
 * The message scrubber's lane, when a long conversation shows it, holds none of the scene: not one painted pixel on
 * either canvas inside it, and no thread owl's button over it (ADR-0109).
 */
async function laneHolds(page: Page, key: string): Promise<void> {
  const lane = page.locator('#watcher-pane .message-scrubber')
  await expect(lane).toBeVisible()
  const reading = await page.evaluate(() => {
    const pane = document.getElementById('watcher-pane')!
    const base = pane.getBoundingClientRect()
    const box = pane.querySelector('.message-scrubber')!.getBoundingClientRect()
    const out: Record<string, number> = {}
    for (const canvas of pane.querySelectorAll<HTMLCanvasElement>(':scope > canvas.watcher-scene')) {
      const scale = canvas.width / canvas.clientWidth
      const x0 = Math.floor((box.left - base.left) * scale), x1 = Math.ceil((box.right - base.left) * scale)
      const y0 = Math.floor((box.top - base.top) * scale), y1 = Math.ceil((box.bottom - base.top) * scale)
      const data = canvas.getContext('2d')!.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data
      let painted = 0
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) painted++
      out[canvas.className] = painted
    }
    out.owlButtons = [...pane.querySelectorAll(':scope > .watcher-scene--owls > .watcher-scene__owl')].filter(button => {
      const own = button.getBoundingClientRect()
      return own.right > box.left && own.left < box.right && own.bottom > box.top && own.top < box.bottom
    }).length
    return out
  })
  for (const [part, painted] of Object.entries(reading)) expect(painted, `${part} in the scrubber's lane, ${key}`).toBe(0)
  recorded[`lane-${key}`] = reading
}

test.describe("Watcher's night scene on the built app", () => {
  test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 })
  test.beforeAll(async () => { await mkdir(evidence, { recursive: true }) })
  test.afterAll(async () => {
    if (Object.keys(recorded).length > 0) await writeFile(resolve(evidence, 'readings.json'), `${JSON.stringify(recorded, null, 2)}\n`, 'utf8')
  })

  for (const appearance of ['dark', 'light'] as const) {
    test(`the first entry and a conversation with thread owls at three sizes, ${appearance}`, async () => {
      await onReleaseTrack('owl', () => withSotto(launchOptions(appearance), async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedRoom(page, false)
        await openRoom(page)
        await expect(page.getByRole('heading', { level: 2, name: 'Start Watcher' })).toBeVisible()
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height)
          await settle(page)
          expect(await pageBoundProblems(page), `first entry at ${width}x${height}`).toEqual([])
          await expect(owl(page)).toHaveAttribute('data-owl', 'perched')
          await sceneHolds(page, `first-${appearance}-${width}x${height}`)
          await capture(launched, `first-entry-${appearance}-${width}x${height}.png`)
        }
        await seedRoom(page, true, [['footer-links', 'running'], ['visual-gate', 'waiting'], ['weekly-note', 'idle']])
        await openRoom(page)
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height)
          await settle(page)
          expect(await pageBoundProblems(page), `conversation at ${width}x${height}`).toEqual([])
          // An owl for each watched thread: on the trees, or at the smallest window on the rail of eyes.
          await expect(owlButtons(page)).toHaveCount(3)
          await sceneHolds(page, `owls-${appearance}-${width}x${height}`)
          await capture(launched, `thread-owls-${appearance}-${width}x${height}.png`)
        }
        // Watched keeps the scene; Visualize, whose picture takes the pane's whole width, puts it away.
        await resizeContentWindow(launched, 1280, 800)
        await page.getByRole('tab', { name: /^Watched, / }).click()
        await settle(page)
        await sceneHolds(page, `watched-${appearance}-1280x800`)
        await capture(launched, `watched-${appearance}-1280x800.png`)
        await page.getByRole('tab', { name: 'Visualize' }).click()
        await expect(land(page)).toHaveCount(0, { timeout: 5_000 })
        await page.getByRole('tab', { name: 'Conversation' }).click()
        await expect(land(page)).toHaveCount(1)
      }))
    })
  }

  for (const appearance of ['dark', 'light'] as const) {
    test(`a long conversation's message scrubber keeps its lane clear of the scene at three sizes, ${appearance}`, async () => {
      await onReleaseTrack('owl', () => withSotto(launchOptions(appearance), async (launched) => {
        const { page } = launched
        await openThreads(page)
        await seedRoom(page, true, [['footer-links', 'running'], ['visual-gate', 'waiting'], ['weekly-note', 'idle']])
        await openRoom(page)
        await page.evaluate(async ({ thread, now }) => {
          await window.sottoE2E!.agentEvent!({ type: 'history', threadId: thread, text: '', messages: Array.from({ length: 40 }, (_, index) => ({
            id: `lane-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const,
            text: index % 2 ? `Watching it. Package (Windows) is still running for message ${(index - 1) / 2 + 1}.` : `Is the release thread green yet? (${index / 2 + 1})`,
            createdAt: new Date(now - (40 - index) * 60_000).toISOString() })) })
        }, { thread: CURRENT, now: E2E_THREADS_NOW })
        await expect(page.getByText('Is the release thread green yet? (20)', { exact: true })).toBeVisible()
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height)
          await settle(page)
          expect(await pageBoundProblems(page), `scrubber at ${width}x${height}`).toEqual([])
          await expect(owlButtons(page)).toHaveCount(3)
          await sceneHolds(page, `scrubber-${appearance}-${width}x${height}`)
          await laneHolds(page, `${appearance}-${width}x${height}`)
          await settle(page)
          await holdOwlSky(page)
          await captureWindow(launched.app, resolve(scrubberEvidence, `watcher-owls-${appearance}-${width}x${height}.png`))
        }
      }))
    })
  }

  test('reduced motion: nothing flies, owls sit from the first frame, and the scene holds still', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('dark', { motion: 'reduced', live: true }), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, true, [['footer-links', 'running'], ['visual-gate', 'waiting']])
      await openRoom(page)
      await resizeContentWindow(launched, 1280, 800)
      await expect(owl(page)).toHaveAttribute('data-owl', 'perched')
      await expect(owlButtons(page)).toHaveCount(2)
      await settle(page)
      await sceneHolds(page, 'reduced-dark-1280x800')
      // Nothing moves, so nothing is painted.
      await page.waitForTimeout(800)
      expect((await framesOver(page, 600)).frames, 'frames painted while still').toBe(0)
      await capture(launched, 'reduced-motion-dark-1280x800.png')
      // A press in the margin only brightens the spot, then it fades and painting stops again.
      await page.mouse.click(120, 300)
      await page.waitForTimeout(1_200)
      expect((await framesOver(page, 600)).frames, 'frames painted once the spot has faded').toBe(0)
    }))
  })

  test('a newcomer comes out of the moon, an owl opens its thread, and a resting scene paints only what changes', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('dark', { live: true }), async (launched) => {
      const { page } = launched
      await openThreads(page)
      const first = [['footer-links', 'running'], ['visual-gate', 'waiting']] as const
      await seedRoom(page, true, first, { afterMs: 12_000, watched: [...first, ['benchmark', 'running']] })
      await resizeContentWindow(launched, 1600, 1000)
      await openRoom(page)
      await expect(owlButtons(page)).toHaveCount(2)
      await settle(page)
      // At rest it checks 8 times a second and paints only a blink, a star's step or the glow's.
      const resting = await framesOver(page, 2_000)
      const restingRate = resting.frames / resting.elapsed * 1000
      expect(restingRate, `frames a second at rest (${resting.frames} in ${Math.round(resting.elapsed)} ms)`).toBeLessThan(8.5)
      recorded['resting-frames-a-second'] = Number(restingRate.toFixed(1))
      // The third thread is watched: the moon's whirlpool opens, ripples, and its owl flies down to its spot. While they
      // move the scene paints about 30 frames a second.
      // The room learns of it the moment the stand-in publishes it, and the scene takes it on the same update.
      await expect(page.getByRole('tab', { name: 'Watched, 3 threads' })).toBeVisible({ timeout: 25_000 })
      const flight = await framesOver(page, 1_000)
      const flightRate = flight.frames / flight.elapsed * 1000
      expect(flightRate, `frames a second in flight (${flight.frames} in ${Math.round(flight.elapsed)} ms, ${flight.display} display frames)`).toBeGreaterThan(22)
      expect(flightRate, `frames a second in flight (${flight.frames} in ${Math.round(flight.elapsed)} ms)`).toBeLessThan(33)
      recorded['flight-frames-a-second'] = Number(flightRate.toFixed(1))
      await captureWindow(launched.app, resolve(evidence, 'newcomer-flight-dark-1600x1000.png'))
      await expect(owlButtons(page)).toHaveCount(3, { timeout: 8_000 })
      await sceneHolds(page, 'newcomer-dark-1600x1000')
      await capture(launched, 'newcomer-landed-dark-1600x1000.png')
      // Hovering an owl names its thread; pressing it opens the thread beside Watcher.
      const button = owlButtons(page).first()
      await button.hover()
      await expect(page.locator('#watcher-pane > .watcher-scene__tip')).toContainText('footer-links')
      await captureWindow(launched.app, resolve(evidence, 'owl-tip-dark-1600x1000.png'))
      await button.click()
      await expect(page.locator('.watcher-room')).toHaveAttribute('data-beside', 'true')
      // With no composer to set the column by, nothing is drawn and no frame waits; the scene comes back with it.
      await page.evaluate(() => { document.querySelector<HTMLElement>('#watcher-pane .thread-workspace__compose')!.style.display = 'none' })
      await page.waitForTimeout(200)
      expect((await framesOver(page, 800)).frames, 'frames painted without a composer').toBe(0)
      await page.evaluate(() => { document.querySelector<HTMLElement>('#watcher-pane .thread-workspace__compose')!.style.removeProperty('display') })
      await expect.poll(async () => (await framesOver(page, 800)).frames).toBeGreaterThan(0)
    }))
  })
})
