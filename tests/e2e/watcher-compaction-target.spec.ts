/**
 * Compact Watcher at, in Settings under Watcher, on the Owl track (Zach's pick C, October 24, 2026): a bar that is
 * Watcher's conversation and a line on it where Watcher compacts, 200k to 1M on a 50k step, 400k by default. It sits
 * under its own Compaction heading after Watched threads, works from the keyboard, saves when it is let go, and nothing
 * clips at any size, in dark or light. Watcher's room is a seeded stand-in, as in watcher-night-scene.spec.ts, so the bar
 * shows a conversation of 312k.
 *
 *   npm run build && npx playwright test tests/e2e/watcher-compaction-target.spec.ts
 */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { WATCHER_STAND_IN_KEY, type WatcherStandInSeed } from '../../src/renderer/src/e2e/watcherStandIn'
import { evidenceDirectory } from '../fixtures/evidence'
import { pageBoundProblems } from './support/designCapture'
import { onReleaseTrack } from './support/releaseTrack'
import { settingsLayoutProblems, settingsTextContrast } from './support/settingsChecks'
import { closeSotto, launchSotto, openPage, type LaunchedSotto } from './support/sottoLaunch'
import { resizeWindow } from './support/sottoWindow'

const evidence = evidenceDirectory('artifacts/watcher-compaction-target')

async function capture(page: Page, name: string): Promise<void> {
  await mkdir(evidence, { recursive: true })
  await page.mouse.move(0, 0)
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}
const saved = (page: Page): Promise<number> => page.evaluate(async () => (await window.sotto!.getSettings()).watcherCompactAtTokens)

/** A current Watcher whose conversation its provider last put at 312k tokens. */
async function seedRoom(page: Page): Promise<void> {
  const hostId = await page.evaluate(async () => (await window.sotto!.agents!.get()).hostId)
  expect(hostId, 'the window names its host').toBeTruthy()
  const identity = { target: { hostId: hostId!, threadId: 'watcher-compaction-target' }, projectId: 'workshop', provider: 'claude' as const,
    creationOperationId: randomUUID(), createdAt: new Date(Date.now() - 60_000).toISOString() }
  const seed: WatcherStandInSeed = {
    state: {
      current: identity, currentOptions: { modelId: 'claude:opus', reasoningEffort: null, runtimeMode: 'approval-required', status: 'idle', connected: true },
      history: [], runtimeMode: 'approval-required', ownChanges: [], standingWatches: [], requests: [], watchedThreads: [],
      receipts: [], recoveryNotice: null, observedAt: new Date().toISOString(),
      context: { tokens: 312_000, compactAt: 400_000, canCompact: true, compacting: false },
    },
    created: identity,
  }
  await page.evaluate(({ key, seed }) => { localStorage.setItem(key, JSON.stringify(seed)) }, { key: WATCHER_STAND_IN_KEY, seed })
  await page.reload()
}

test('Compact Watcher at is a slider on Watcher’s conversation, 400k by default, that saves from the keyboard', async () => {
  test.setTimeout(180_000)
  let launched: LaunchedSotto | undefined
  try {
    await onReleaseTrack('owl', async () => {
      launched = await launchSotto('success')
      const { page } = launched
      await page.evaluate(async () => { await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' }) })
      await seedRoom(page)
      await openPage(page, 'Settings')
      await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
      const panel = page.locator('#settings-watcher')
      await expect(panel.getByRole('heading', { name: 'Compaction' })).toBeVisible()
      // Under its own heading, after Watched threads.
      const order = await panel.evaluate(element => [...element.querySelectorAll('h3')].map(heading => heading.textContent?.trim()))
      expect(order.slice(0, 2)).toEqual(['Watched threads', 'Compaction'])
      const slider = panel.getByRole('slider', { name: 'Compact Watcher at' })
      await expect(slider).toHaveValue('400000')
      await expect(slider).toHaveAttribute('aria-valuetext', '400k tokens')
      expect(await saved(page)).toBe(400_000)
      await expect(panel.getByText('Watcher is at 312k.', { exact: true })).toBeVisible()

      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(async mode => { await window.sotto!.updateSettings({ appearance: mode }) }, appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0 })
          const where = `${width}x${height} ${appearance}`
          expect(await pageBoundProblems(page), where).toEqual([])
          expect(await settingsLayoutProblems(page, 'settings-watcher', '.settings-group, .watcher-compaction, .watcher-compaction__flag, .watcher-compaction__foot span'), where)
            .toEqual({ pageOverflow: false, formOverflow: false, clipped: [] })
          const low = (await settingsTextContrast(page, 'settings-watcher', '.watcher-compaction .tt-field__label, .watcher-compaction .tt-field__description, .watcher-compaction__flag, .watcher-compaction__foot span'))
            .filter(item => item.text.trim() && item.ratio < 4.5)
          expect(low, where).toEqual([])
          await capture(page, `compact-watcher-at-${width}x${height}-${appearance}`)
        }
      }

      // From the keyboard: the arrows move it 50k at a time and letting go saves. Below Watcher's 312k, the room says it
      // compacts at its next rest.
      await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })
      await resizeWindow(launched, 1280, 800)
      await slider.focus()
      for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowLeft')
      await expect(slider).toHaveValue('200000')
      await expect.poll(() => saved(page)).toBe(200_000)
      await expect(panel.getByText('Watcher is at 312k: it compacts at its next rest.', { exact: true })).toBeVisible()
      await capture(page, 'compact-watcher-at-1280x800-dark-below')
      await page.keyboard.press('End')
      await expect(slider).toHaveValue('1000000')
      await expect.poll(() => saved(page)).toBe(1_000_000)
      await capture(page, 'compact-watcher-at-1280x800-dark-1m')
    })
  } finally {
    if (launched) await closeSotto(launched)
  }
})
