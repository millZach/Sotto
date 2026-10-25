import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'

import { withSotto } from '../fixtures/designCaptureProfile'
import { evidenceDirectory } from '../fixtures/evidence'
import { composerEdges } from './support/composerEdge'
import { hostKeysPerTest } from './support/hostKeys'
import { longHistory } from './support/longHistory'
import { onReleaseTrack } from './support/releaseTrack'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'
import { resizeContentWindow } from './support/sottoWindow'
import { seedWatcherRoom } from './support/watcherRoom'

/**
 * The composer has no edge in any state (ADR-0110, the user's ask on October 24, 2026): no border, outline, shadow or
 * ring on the composer, its card or its field, at rest, pointed at, with focus from a click or from Tab, slim, while a
 * turn runs and at a model's highest effort, in a thread and in Watcher, in every built-in theme, dark and light. The
 * caret alone says where typing goes. Run after `npm run build`. Captures go to disposable run evidence;
 * `SOTTO_E2E_EVIDENCE=publish` writes artifacts/composer-slim-steady.
 */
const evidence = evidenceDirectory('artifacts/composer-slim-steady')
const THEMES = ['t3-code', 'hush', 'linen', 'nocturne', 'tropic', 'citrine'] as const
const hostKeys = hostKeysPerTest()
test.beforeEach(() => { hostKeys.reset() })

type Appearance = 'dark' | 'light'

async function theme(page: Page, appearance: Appearance, id: string): Promise<void> {
  await page.evaluate(async ([appearance, id]) => window.sotto!.updateSettings(appearance === 'dark' ? { appearance, darkTheme: id } : { appearance, lightTheme: id }), [appearance, id] as const)
  await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
  await expect(page.locator('html')).toHaveAttribute('data-theme-id', new RegExp(id))
}

/** The composer's card, cut out of the window with a margin, for the evidence. */
async function captureCard(page: Page, pane: string, name: string): Promise<void> {
  const box = (await page.locator(`${pane} > .thread-workspace__compose > .thread-prompt`).boundingBox())!
  await page.screenshot({ path: resolve(evidence, `edge-${name}.png`), clip: { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 } })
}

/** Puts focus in the composer's textbox by Tab from the transcript, as a keyboard does. */
async function tabInto(page: Page, pane: string, textbox: Locator): Promise<void> {
  await page.locator(`${pane} .thread-workspace__transcript`).focus()
  for (let press = 0; press < 40 && !await textbox.evaluate(node => node === document.activeElement || node.contains(document.activeElement)); press++) await page.keyboard.press('Tab')
  await expect(textbox).toBeFocused()
}

/** Checks the composer in `pane` at rest, pointed at, focused by a click and by Tab, and slim, in every theme. */
async function checkStates(page: Page, pane: string, label: string, readBack: (fromEnd: number) => Promise<void>, textbox: Locator): Promise<void> {
  const compose = page.locator(`${pane} > .thread-workspace__compose`)
  for (const appearance of ['dark', 'light'] as const) {
    for (const id of THEMES) {
      await theme(page, appearance, id)
      await page.mouse.move(0, 0)
      await readBack(0)
      await expect(compose).not.toHaveAttribute('data-slim')
      expect.soft(await composerEdges(page, pane), `${label} ${appearance} ${id} at rest`).toEqual([])
      if (id === 't3-code') await captureCard(page, pane, `${label}-rest-${appearance}`)
      await page.locator(`${pane} > .thread-workspace__compose > .thread-prompt`).hover()
      expect.soft(await composerEdges(page, pane), `${label} ${appearance} ${id} pointed at`).toEqual([])
      await textbox.click()
      expect.soft(await composerEdges(page, pane), `${label} ${appearance} ${id} focused by a click`).toEqual([])
      if (id === 't3-code') await captureCard(page, pane, `${label}-focus-${appearance}`)
      await page.mouse.move(0, 0)
      await tabInto(page, pane, textbox)
      expect.soft(await composerEdges(page, pane), `${label} ${appearance} ${id} focused by Tab`).toEqual([])
      await page.locator(`${pane} .thread-workspace__transcript`).focus()
      await readBack(420)
      await expect(compose).toHaveAttribute('data-slim', 'true')
      await expect.poll(() => compose.evaluate(node => node.hasAttribute('data-slim-moving'))).toBe(false)
      expect.soft(await composerEdges(page, pane), `${label} ${appearance} ${id} slim`).toEqual([])
      if (id === 't3-code') await captureCard(page, pane, `${label}-slim-${appearance}`)
    }
  }
}

function scroller(page: Page, pane: string): (fromEnd: number) => Promise<void> {
  return fromEnd => page.locator(`${pane} .thread-workspace__transcript`).evaluate((log, fromEnd) => {
    log.scrollTop = log.scrollHeight - log.clientHeight - fromEnd
    log.dispatchEvent(new Event('scroll'))
  }, fromEnd)
}

test.describe('The composer has no edge', () => {
  test.describe.configure({ timeout: 5 * 60_000 })
  test.beforeAll(async () => { await mkdir(evidence, { recursive: true }) })

  test('a thread’s composer: at rest, pointed at, focused, slim, running and at the highest effort, in every theme', async () => {
    const previous = process.env.SOTTO_OWL_FEATURES
    process.env.SOTTO_OWL_FEATURES = 'composer-shrink=1'
    const launched = await launchSotto().finally(() => { if (previous === undefined) delete process.env.SOTTO_OWL_FEATURES; else process.env.SOTTO_OWL_FEATURES = previous })
    const { page } = launched
    try {
      await page.evaluate(async () => {
        await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'system', effortColor: 'ember' })
        await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
        await window.sotto!.agents!.command({ type: 'connect' })
        await window.sotto!.agents!.command({ type: 'select-thread', threadId: 'workshop' })
        await window.sotto!.agents!.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'low' })
      })
      await page.reload()
      await hostKeys.read(page)
      await openThreads(page)
      await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Workshop', exact: true }).click()
      const pane = `section.thread-pane[data-thread-id="${hostKeys.key('workshop')}"]`
      await expect(page.locator(pane)).toBeVisible()
      await resizeContentWindow(launched, 1280, 800)
      await longHistory(page, 'workshop', 'edge')
      await expect(page.locator('[data-message-id="edge-15"]')).toBeVisible()
      const textbox = page.locator(pane).getByRole('textbox', { name: 'Prompt' })
      await checkStates(page, pane, 'thread', scroller(page, pane), textbox)

      // A running turn, the highest effort and both together, which each drew an edge of their own.
      const chip = page.locator(pane).getByRole('combobox', { name: 'Thread reasoning', exact: true })
      const card = page.locator(`${pane} > .thread-workspace__compose > .thread-prompt`)
      for (const appearance of ['dark', 'light'] as const) {
        await theme(page, appearance, 't3-code')
        await scroller(page, pane)(0)
        await page.mouse.move(0, 0)
        // The effort is set while the thread is idle: the chip waits while a turn runs.
        await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'max' }) })
        await expect(chip).toHaveAttribute('data-effort-top', 'true')
        // The arrival's tide plays once through the card; the capture waits for it to settle.
        await expect(page.locator(`${pane} [data-effort-arriving='true']`)).toHaveCount(0, { timeout: 6_000 })
        await page.waitForTimeout(400)
        await expect.poll(() => composerEdges(page, pane), { message: `thread ${appearance} at the highest effort` }).toEqual([])
        await captureCard(page, pane, `thread-highest-${appearance}`)
        await page.evaluate(async () => { await window.sottoE2E!.agentEvent!({ type: 'stream', threadId: 'workshop', messageId: 'edge-running', text: 'Running the suite.', status: 'running' }) })
        await expect(card).toHaveAttribute('data-running', /.*/)
        expect.soft(await composerEdges(page, pane), `thread ${appearance} running at the highest effort`).toEqual([])
        await captureCard(page, pane, `thread-running-${appearance}`)
        await page.evaluate(async () => { await window.sottoE2E!.agentEvent!({ type: 'ready', threadId: 'workshop', text: 'Finished.', status: 'idle' }) })
        await expect(card).not.toHaveAttribute('data-running', /.*/)
        await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'low' }) })
        await expect(chip).toHaveAttribute('data-effort-top', 'false')
      }
    } finally { await closeSotto(launched) }
  })

  test('Watcher’s glass composer: at rest, pointed at, focused and slim, in every theme', async () => {
    await onReleaseTrack('owl', () => withSotto({ onboardingComplete: true, appearance: 'dark', motion: 'normal', agents: 'design-threads', scenario: 'design-threads', darkTheme: 't3-code' }, async (launched) => {
      const { page } = launched
      await openThreads(page)
      await seedWatcherRoom(page, { watched: ['footer-links', 'visual-gate', 'weekly-note'], idPrefix: 'edge' })
      await page.getByRole('tablist', { name: 'Page' }).getByRole('tab', { name: 'Watcher', exact: true }).click()
      await expect(page.locator('#watcher-pane [data-message-id="edge-23"]')).toBeVisible()
      await resizeContentWindow(launched, 1280, 800)
      await checkStates(page, '#watcher-pane', 'watcher', scroller(page, '#watcher-pane'), page.getByRole('textbox', { name: 'Watcher message' }))
    }))
  })
})
