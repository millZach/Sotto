import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { ownedE2EProfile } from './support/e2eProfile'
import { onReleaseTrack } from './support/releaseTrack'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'

/**
 * Night falls' Stars look on the built app (ADR-0119, decision 6; docs/plans/night-falls-look.md), with Watcher and
 * night falls on as an Owl build has them. A Stars run plays on the way into Watcher's room and back: the canvas over the
 * window carries the theme's accent, the band's own ink does not, and the clip reveals the room being opened. Under
 * reduced motion the page swaps in one frame and no run starts. Each run is held at 40% for its capture by pausing the
 * page's animations and frames, then let go to finish. Run after `npm run build`. Captures go to disposable run evidence;
 * `SOTTO_E2E_EVIDENCE=publish` writes artifacts/night-falls-look.
 */
const evidence = evidenceDirectory('artifacts/night-falls-look')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const HOLD_AT = 0.4

const switchTab = (page: Page, name: 'Watcher' | 'Threads') => page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name, exact: true })

/** What a held run showed: its direction, its length, and how many canvas pixels were painted in each ink. */
interface HeldRun {
  readonly direction: string | null
  readonly durationMs: number
  readonly accent: number
  readonly text: number
  readonly clipped: boolean
}

/** Watches for the next run from inside the page, and holds it at `at` of its length once it starts. */
async function watchNextRun(page: Page, at: number): Promise<void> {
  await page.evaluate(at => {
    type Probe = { started: boolean, ended: boolean, held: Promise<unknown>, release: () => void }
    const root = document.documentElement
    let hold: (value: unknown) => void = () => {}
    const probe: Probe = { started: false, ended: false, held: new Promise(resolve => { hold = resolve }), release: () => {} }
    ;(window as unknown as { nightFallsProbe: Probe }).nightFallsProbe = probe
    const rgbOf = (value: string): [number, number, number] => {
      const pixel = document.createElement('canvas').getContext('2d')!
      pixel.fillStyle = value
      pixel.fillRect(0, 0, 1, 1)
      const [r, g, b] = pixel.getImageData(0, 0, 1, 1).data
      return [r!, g!, b!]
    }
    const observer = new MutationObserver(() => {
      if (!probe.started && root.dataset.roomTransition) {
        probe.started = true
        const direction = root.dataset.roomTransition
        const durationMs = parseFloat(root.style.getPropertyValue('--room-transition-ms'))
        setTimeout(() => {
          // Hold the run: the clip and the owl stop where they are, and the canvas paints no further frame.
          const animations = document.getAnimations()
          for (const animation of animations) animation.pause()
          const original = window.requestAnimationFrame, frame = original.bind(window)
          const waiting: FrameRequestCallback[] = []
          window.requestAnimationFrame = callback => { waiting.push(callback); return 0 }
          // The frame already asked for still paints once, then asks again and waits; read the canvas after it.
          frame(() => frame(() => {
            const style = getComputedStyle(root)
            const accent = rgbOf(style.getPropertyValue('--tt-accent').trim())
            const text = rgbOf(style.getPropertyValue('--tt-text').trim())
            const canvas = document.querySelector<HTMLCanvasElement>('.night-falls-band')
            const data = canvas?.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
            const near = (i: number, [r, g, b]: [number, number, number]): boolean => Math.abs(data![i]! - r) + Math.abs(data![i + 1]! - g) + Math.abs(data![i + 2]! - b) < 24
            let accentPixels = 0, textPixels = 0
            if (data) for (let i = 0; i < data.length; i += 4) {
              if (data[i + 3]! < 128) continue
              if (near(i, accent)) accentPixels++
              else if (near(i, text)) textPixels++
            }
            const clipped = animations.some(animation => (animation.effect as KeyframeEffect | null)?.pseudoElement === '::view-transition-new(root)')
            probe.release = () => {
              window.requestAnimationFrame = original
              for (const callback of waiting.splice(0)) frame(callback)
              for (const animation of animations) animation.play()
            }
            hold({ direction, durationMs, accent: accentPixels, text: textPixels, clipped })
          }))
        }, durationMs * at)
      }
      if (probe.started && !root.dataset.roomTransition) { probe.ended = true; observer.disconnect() }
    })
    observer.observe(root, { attributes: true, attributeFilter: ['data-room-transition'] })
  }, at)
}

/** Presses the room switch toward `to`, holds the run it starts, captures it, and lets it finish. */
async function playHeld(page: Page, to: 'Watcher' | 'Threads', capture: string): Promise<HeldRun> {
  await watchNextRun(page, HOLD_AT)
  await switchTab(page, to).click()
  const held = await page.evaluate(() => (window as unknown as { nightFallsProbe: { held: Promise<HeldRun> } }).nightFallsProbe.held)
  await page.screenshot({ path: capture })
  await page.evaluate(() => (window as unknown as { nightFallsProbe: { release: () => void } }).nightFallsProbe.release())
  await expect.poll(() => page.evaluate(() => (window as unknown as { nightFallsProbe: { ended: boolean } }).nightFallsProbe.ended)).toBe(true)
  await expect(page.locator('.night-falls-band')).toHaveCount(0)
  return held
}

async function launchOwl(run: (launched: LaunchedSotto) => Promise<void>, reducedMotion: 'system' | 'on'): Promise<void> {
  await onReleaseTrack('owl', async () => {
    const profile = await ownedE2EProfile({ prefix: 'sotto-e2e-night-falls-look-', settings: {
      ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark', reducedMotion, showWidgetWhenIdle: false,
      roomTransition: true, roomTransitionLook: 'stars', roomTransitionSpeed: 1,
    } })
    const launched = await launchSotto('success', profile.directory)
    try {
      await openThreads(launched.page)
      await expect.poll(() => launched.page.evaluate(async () => { const update = await window.sotto!.getUpdateStatus(); return 'owlFeatures' in update ? update.owlFeatures?.['night-falls'] : undefined })).toBe(true)
      await run(launched)
    } finally {
      await closeSotto(launched)
    }
  })
}

test.describe('night falls in the Stars look', () => {
  test.setTimeout(240_000)

  test('plays stars on the way into Watcher\'s room and back, in dark and light at every size', async () => {
    await launchOwl(async launched => {
      const { page } = launched
      await mkdir(evidence, { recursive: true })
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => { await window.sotto!.updateSettings({ appearance }) }, appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        for (const [width, height] of SIZES) {
          await resizeContentWindow(launched, width, height, [800, 540])
          await page.mouse.move(0, 0)
          for (const [to, direction] of [['Watcher', 'in'], ['Threads', 'out']] as const) {
            const held = await playHeld(page, to, join(evidence, `stars-${direction}-${appearance}-${width}x${height}.png`))
            expect(held.direction).toBe(direction)
            expect(held.durationMs).toBe(840)
            expect(held.clipped).toBe(true)
            // Stars paints its front in the accent, which the band never does: the band is all the text's ink.
            expect(held.accent, `${appearance} ${width}x${height} ${direction}`).toBeGreaterThan(0)
            if (to === 'Watcher') await expect(page.getByRole('heading', { level: 1, name: 'Watcher' })).toBeVisible()
            else await expect(page.locator('.threads-view')).toBeVisible()
            expect(await pageBoundProblems(page)).toEqual([])
          }
        }
      }
    }, 'system')
  })

  test('swaps the page at once under reduced motion, with Stars set', async () => {
    await launchOwl(async ({ page }) => {
      await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'on')
      await page.evaluate(() => {
        const seen: string[] = []
        ;(window as unknown as { nightFallsSeen: string[] }).nightFallsSeen = seen
        new MutationObserver(records => {
          for (const record of records) {
            if (record.type === 'attributes' && document.documentElement.dataset.roomTransition) seen.push('transition')
            for (const node of record.addedNodes) if (node instanceof HTMLCanvasElement && node.classList.contains('night-falls-band')) seen.push('canvas')
          }
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-room-transition'], childList: true, subtree: true })
      })
      await switchTab(page, 'Watcher').click()
      await expect(page.getByRole('heading', { level: 1, name: 'Watcher' })).toBeVisible()
      await switchTab(page, 'Threads').click()
      await expect(page.locator('.threads-view')).toBeVisible()
      expect(await page.evaluate(() => (window as unknown as { nightFallsSeen: string[] }).nightFallsSeen)).toEqual([])
    }, 'on')
  })
})
