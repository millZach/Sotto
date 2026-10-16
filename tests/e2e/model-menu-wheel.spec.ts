import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { captureWindow, closeSotto, launchSotto, openPage } from './support/sottoLaunch'

const evidence = evidenceDirectory('artifacts/model-menu-wheel')

test('the mouse wheel over the model menu steps through its providers', async () => {
  // A scenario whose host offers more than one provider, so the menu has a rail.
  const launched = await launchSotto('design-threads-empty')
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await openPage(page, 'Settings')
    await page.getByRole('tab', { name: 'Agents', exact: true }).click()
    const chip = page.getByRole('combobox', { name: 'Thread model', exact: true })
    await chip.click()
    const menu = page.getByRole('dialog', { name: 'Choose model', exact: true })
    const rail = menu.getByRole('tablist', { name: 'Model providers', exact: true })
    const tabs = rail.getByRole('tab')
    await expect.poll(() => tabs.count()).toBeGreaterThan(1)
    const names = await tabs.evaluateAll(items => items.map(item => item.getAttribute('aria-label') ?? ''))
    const chosen = (): Promise<string> => rail.locator('[role="tab"][aria-selected="true"]').getAttribute('aria-label').then(name => name ?? '')
    const start = names.indexOf(await chosen())
    await mkdir(evidence, { recursive: true })
    await captureWindow(launched.app, join(evidence, 'before.png'))
    // A real wheel over the rail, one notch at a time, the way a mouse turns it.
    const box = (await rail.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const forward = start < names.length - 1 ? 1 : -1
    await page.mouse.wheel(0, 100 * forward)
    await expect.poll(chosen).toBe(names[start + forward])
    await expect(menu.getByRole('listbox', { name: `${names[start + forward]} models`, exact: true })).toBeVisible()
    await expect(menu.getByRole('textbox', { name: 'Search models', exact: true })).toBeFocused()
    await captureWindow(launched.app, join(evidence, 'after-one-notch.png'))
    // Past the end it stays on the last provider rather than wrapping round.
    for (let step = 0; step < names.length + 1; step += 1) await page.mouse.wheel(0, 100 * forward)
    await expect.poll(chosen).toBe(forward > 0 ? names.at(-1) : names[0])
    await expect(chip).toBeVisible()
    await expect(menu).toBeVisible()
  } finally { await closeSotto(launched) }
})
