import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { expect, test, type Page } from '@playwright/test'

import { E2E_THREADS_NOW } from '../../src/shared/e2e'
import { contrastRatio } from '../../src/shared/themes/color'
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
 * Watcher's night scene on the built app (Zach's pick on October 21, 2026, variant A of `prototype/watcher-owl-scene`):
 * the ASCII night behind Watcher's room while it is empty, the first time and in an empty conversation, at the three
 * sizes in dark and light, with reduced motion, and fading once the first message is sent. A capture run's fixed clock
 * holds the scene settled with the owl on the composer, so those captures repeat; the flight and a ripple are checked
 * on a live clock. Main's Watcher is stood in for by a seeded projection, as in watcher.spec.ts. Run after
 * `npm run build`. Captures go to disposable run evidence; `SOTTO_E2E_EVIDENCE=publish` writes artifacts/watcher-night-scene.
 */
const evidence = evidenceDirectory('artifacts/watcher-night-scene')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const CURRENT = 'release-notes'
const recorded: Record<string, unknown> = {}

function launchOptions(appearance: 'dark' | 'light', options: { readonly motion?: 'normal' | 'reduced'; readonly live?: boolean } = {}) {
  return {
    onboardingComplete: true, appearance, motion: options.motion ?? 'normal', agents: 'design-threads',
    // The capture scenario holds every clock still, the scene's included; a live run lets the owl fly.
    scenario: options.live ? 'success' : 'design-threads',
    ...(appearance === 'dark' ? { darkTheme: 't3-code' } : { lightTheme: 't3-code' }),
  } as const
}

/** Seeds Watcher's projection: no Watcher yet (the first entry), or `release-notes` as a Watcher with nothing sent to it. */
async function seedRoom(page: Page, current: boolean): Promise<void> {
  const hostId = await page.evaluate(async () => (await window.sotto!.agents!.get()).hostId)
  expect(hostId, 'the window names its host').toBeTruthy()
  const identity = { target: { hostId: hostId!, threadId: CURRENT }, projectId: 'workshop', provider: 'codex' as const, creationOperationId: randomUUID(),
    createdAt: new Date(E2E_THREADS_NOW - 60_000).toISOString() }
  const seed: WatcherStandInSeed = {
    state: {
      current: current ? identity : null,
      currentOptions: current ? { modelId: 'codex:gpt', reasoningEffort: null, runtimeMode: 'approval-required', status: 'idle', connected: true } : null,
      history: [], runtimeMode: 'approval-required', ownChanges: [], standingWatches: [], requests: [], watchedThreads: [],
      receipts: [], recoveryNotice: null, observedAt: new Date(E2E_THREADS_NOW).toISOString(),
    },
    created: identity,
  }
  await page.evaluate(async ({ key, seed, thread, current }) => {
    localStorage.setItem(key, JSON.stringify(seed))
    if (current) await window.sottoE2E!.agentEvent!({ type: 'history', threadId: thread, text: '', messages: [] })
  }, { key: WATCHER_STAND_IN_KEY, seed, thread: CURRENT, current })
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

const land = (page: Page) => page.locator('#watcher-pane > canvas.watcher-scene--land')
const owl = (page: Page) => page.locator('#watcher-pane > canvas.watcher-scene--owl')

/**
 * The scene is decoration: both canvases hidden, never focusable, never pressed, with the owl perched once settled. Its
 * ink under the intro's words and the line under the composer leaves their text at 4.5:1 or more against the surface
 * blended with the scene's strongest ink there.
 */
async function sceneHolds(page: Page, key: string): Promise<void> {
  for (const canvas of [land(page), owl(page)]) {
    await expect(canvas).toHaveAttribute('aria-hidden', 'true')
    expect(await canvas.evaluate(node => [node.tabIndex, getComputedStyle(node).pointerEvents])).toEqual([-1, 'none'])
  }
  await expect(owl(page)).toHaveAttribute('data-owl', 'perched')
  const readings = await page.evaluate(() => {
    const pane = document.getElementById('watcher-pane')!
    const canvas = pane.querySelector<HTMLCanvasElement>('canvas.watcher-scene--land')!
    const scale = canvas.width / canvas.clientWidth
    const base = pane.getBoundingClientRect()
    const pixel = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
    const rgb = (value: string): [number, number, number] => {
      pixel.clearRect(0, 0, 1, 1); pixel.fillStyle = value; pixel.fillRect(0, 0, 1, 1)
      const [r = 0, g = 0, b = 0] = pixel.getImageData(0, 0, 1, 1).data
      return [r, g, b]
    }
    let surface: [number, number, number] = [0, 0, 0]
    for (let node: Element | null = pane; node !== null; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor
      if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') { surface = rgb(color); break }
    }
    const context = canvas.getContext('2d')!
    const results: Array<{ name: string; text: [number, number, number]; worst: [number, number, number]; inkAlpha: number }> = []
    for (const element of pane.querySelectorAll<HTMLElement>('.watcher-first__intro :is(h2, p), .thread-workspace__empty :is(h3, p), .thread-pane__meta .watched-note > span')) {
      const box = element.getBoundingClientRect()
      if (box.width < 1 || box.height < 1) continue
      const data = context.getImageData(Math.round((box.left - base.left) * scale), Math.round((box.top - base.top) * scale), Math.max(1, Math.round(box.width * scale)), Math.max(1, Math.round(box.height * scale))).data
      // The scene's strongest ink under the words, as it shows over the surface.
      let worst = surface, alpha = 0
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3]! / 255
        if (a <= alpha) continue
        alpha = a
        worst = [0, 1, 2].map(k => Math.round(data[i + k]! * a + surface[k]! * (1 - a))) as [number, number, number]
      }
      results.push({ name: element.textContent!.trim().slice(0, 32), text: rgb(getComputedStyle(element).color), worst, inkAlpha: Number(alpha.toFixed(3)) })
    }
    return results
  })
  expect(readings.length, `words measured, ${key}`).toBeGreaterThan(0)
  const measured = readings.map(({ name, text, worst, inkAlpha }) => {
    const ratio = contrastRatio({ r: text[0], g: text[1], b: text[2] }, { r: worst[0], g: worst[1], b: worst[2] })
    return { name, inkAlpha, ratio: Number(ratio.toFixed(2)) }
  })
  for (const { name, ratio } of measured) expect(ratio, `${name}, ${key}`).toBeGreaterThanOrEqual(4.5)
  recorded[key] = measured
}

test.describe("Watcher's night scene on the built app", () => {
  test.describe.configure({ mode: 'serial', timeout: 5 * 60_000 })
  test.beforeAll(async () => { await mkdir(evidence, { recursive: true }) })
  test.afterAll(async () => {
    if (Object.keys(recorded).length > 0) await writeFile(resolve(evidence, 'readings.json'), `${JSON.stringify(recorded, null, 2)}\n`, 'utf8')
  })

  for (const appearance of ['dark', 'light'] as const) {
    test(`the first entry and an empty conversation at three sizes, ${appearance}`, async () => {
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
          await sceneHolds(page, `first-${appearance}-${width}x${height}`)
          await capture(launched, `first-entry-${appearance}-${width}x${height}.png`)
        }
        await seedRoom(page, true)
        await openRoom(page)
        await expect(page.getByText('What is next for this thread?')).toBeVisible()
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height)
          await settle(page)
          await sceneHolds(page, `empty-${appearance}-${width}x${height}`)
          if (width === 1280) await capture(launched, `empty-conversation-${appearance}-${width}x${height}.png`)
        }
      }))
    })
  }

  test('reduced motion starts the owl on the composer and keeps the scene still', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('dark', { motion: 'reduced', live: true }), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, false)
      await openRoom(page)
      await resizeContentWindow(launched, 1280, 800)
      // No flight: perched from the first frame.
      await expect(owl(page)).toHaveAttribute('data-owl', 'perched')
      await settle(page)
      await sceneHolds(page, 'reduced-dark-1280x800')
      // Nothing moves, so nothing is drawn: two reads a few frames apart are the same picture.
      const still = await page.evaluate(async () => {
        const canvas = document.querySelector<HTMLCanvasElement>('#watcher-pane > canvas.watcher-scene--land')!
        const before = canvas.toDataURL()
        await new Promise(done => setTimeout(done, 400))
        return before === canvas.toDataURL()
      })
      expect(still, 'the scene holds still').toBe(true)
      await capture(launched, 'reduced-motion-dark-1280x800.png')
      // A press only brightens the spot, then it fades.
      await page.mouse.click(300, 260)
      await page.waitForTimeout(120)
      await captureWindow(launched.app, resolve(evidence, 'reduced-motion-press-dark-1280x800.png'))
    }))
  })

  test('the owl flies its route once, a press ripples, and sending fades the scene away', async () => {
    await onReleaseTrack('owl', () => withSotto(launchOptions('dark', { live: true }), async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedRoom(page, false)
      await resizeContentWindow(launched, 1280, 800)
      await openRoom(page)
      await expect(owl(page)).toHaveAttribute('data-owl', 'watching')
      await captureWindow(launched.app, resolve(evidence, 'flight-1-watching-dark-1280x800.png'))
      await expect(owl(page)).toHaveAttribute('data-owl', 'flying', { timeout: 10_000 })
      await page.waitForTimeout(1_400)
      await captureWindow(launched.app, resolve(evidence, 'flight-2-flying-dark-1280x800.png'))
      await expect(owl(page)).toHaveAttribute('data-owl', 'perched', { timeout: 15_000 })
      // A press in the open background, away from every control.
      await page.mouse.click(420, 300)
      await page.waitForTimeout(450)
      await captureWindow(launched.app, resolve(evidence, 'ripple-dark-1280x800.png'))
      // Sending the first message starts Watcher, and the scene fades and is gone.
      await page.getByRole('textbox', { name: 'Watcher message' }).click()
      await page.keyboard.type('Keep an eye on the footer links.')
      await page.keyboard.press('Enter')
      await expect(land(page)).toHaveAttribute('data-leaving', 'true')
      await expect(land(page)).toHaveCount(0, { timeout: 5_000 })
      await expect(owl(page)).toHaveCount(0)
      await capture(launched, 'after-send-dark-1280x800.png')
    }))
  })
})
