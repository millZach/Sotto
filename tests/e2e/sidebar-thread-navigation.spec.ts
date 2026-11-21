import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { evidenceDirectory } from '../fixtures/evidence'
import { ownedE2EProfile } from './support/e2eProfile'
import { closeSotto, launchSotto, openThreads, type LaunchedSotto } from './support/sottoLaunch'
import { holdContentSize } from './support/sottoWindow'

const SHOTS = evidenceDirectory('artifacts/thread-list-keyboard')

async function launchOnThreads(): Promise<LaunchedSotto> {
  const profile = (await ownedE2EProfile({ prefix: 'sotto-e2e-sidebar-navigation-' })).directory
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ ...DEFAULT_SETTINGS, onboardingComplete: true, appearance: 'dark', accent: 'teal', threadListGrouping: 'project' }))
  await writeFile(join(profile, 'agents.json'), JSON.stringify({
    configuration: { ...defaultAgentConfiguration(), enabled: true },
    activeThreadId: 'wav-stall', activeProjectId: 'workshop', draft: '', draftThreadId: null, draftRequestId: null, composing: false, outbox: [],
  }))
  const launched = await launchSotto('design-threads', profile)
  try {
    await launched.page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'connect' }) })
    await holdContentSize(launched, 1600, 1000, [820, 560])
    await openThreads(launched.page)
    return launched
  } catch (error: unknown) {
    await closeSotto(launched)
    throw error
  }
}

test('next and previous thread keys follow the visible project trays on the collapsed rail', async () => {
  test.setTimeout(240_000)
  const previous = process.env['SOTTO_OWL_FEATURES']
  process.env['SOTTO_OWL_FEATURES'] = 'sidebar-rail=1,needs-you-queue=1'
  let launched: LaunchedSotto
  try { launched = await launchOnThreads() } finally {
    if (previous === undefined) delete process.env['SOTTO_OWL_FEATURES']; else process.env['SOTTO_OWL_FEATURES'] = previous
  }
  try {
    const page = launched.page
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    await sidebar.getByRole('button', { name: 'Collapse sidebar' }).click()
    const rail = sidebar.getByRole('navigation', { name: 'Threads' })
    const tiles = rail.locator('button[data-roving-key^="rail:"]')
    await expect(tiles.first()).toBeVisible()
    const order = await tiles.evaluateAll(items => items.map(item => ({ key: item.getAttribute('data-roving-key')!, title: item.getAttribute('title')! })))
    const inputOrder = await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.map(thread => `rail:${thread.id}`))
    expect(order.length).toBeGreaterThan(3)
    expect(order.map(item => item.key)).not.toEqual(inputOrder)
    expect(await rail.locator('.thread-nav__rail-project').count()).toBeGreaterThan(1)
    const selected = rail.locator('[aria-current="page"]')
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    for (const grouping of ['project', 'status'] as const) {
      await page.evaluate(async threadListGrouping => window.sotto!.updateSettings({ threadListGrouping }), grouping)
      const current = await selected.getAttribute('data-roving-key')
      let at = order.findIndex(item => item.key === current)
      expect(at).toBeGreaterThanOrEqual(0)
      for (const step of [1, -1]) {
        for (let press = 0; press < order.length; press++) {
          at = (at + step + order.length) % order.length
          await page.keyboard.press(`${modifier}+Alt+${step === 1 ? 'ArrowDown' : 'ArrowUp'}`)
          await expect(selected).toHaveAttribute('data-roving-key', order[at]!.key)
        }
      }
    }
    // Plain arrows keep their separate focus-only path, without wrapping or selecting a different thread.
    const current = await selected.getAttribute('data-roving-key')
    await tiles.first().focus()
    await page.keyboard.press('ArrowDown')
    await expect(tiles.nth(1)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(tiles.first()).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(tiles.first()).toBeFocused()
    await expect(selected).toHaveAttribute('data-roving-key', current!)
    await mkdir(SHOTS, { recursive: true })
    await writeFile(join(SHOTS, 'rail-navigation-order.json'), JSON.stringify(order, null, 2))
    await page.screenshot({ path: join(SHOTS, 'rail-navigation-order.png'), animations: 'disabled' })
  } finally {
    await closeSotto(launched)
  }
})
