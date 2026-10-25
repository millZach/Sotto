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
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Threads', exact: true }).click()
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
    // A real wheel over the rail, the way a mouse turns it. A pause longer than the rail's ends one turn.
    const box = (await rail.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const pause = (): Promise<void> => page.waitForTimeout(300)
    expect(start + 2).toBeLessThan(names.length)
    await page.mouse.wheel(0, 100)
    await expect.poll(chosen).toBe(names[start + 1])
    await expect(menu.getByRole('listbox', { name: `${names[start + 1]} models`, exact: true })).toBeVisible()
    await expect(menu.getByRole('textbox', { name: 'Search models', exact: true })).toBeFocused()
    await captureWindow(launched.app, join(evidence, 'after-one-notch.png'))
    await pause()
    await page.mouse.wheel(0, -100)
    await expect.poll(chosen).toBe(names[start])
    // Three notches turned quickly together are one turn, so they step once.
    await pause()
    for (let notch = 0; notch < 3; notch += 1) await page.mouse.wheel(0, 100)
    await pause()
    expect(await chosen()).toBe(names[start + 1])
    // Past the end it stays on the last provider rather than wrapping round.
    for (let step = 0; step < names.length + 1; step += 1) { await page.mouse.wheel(0, 100); await pause() }
    await expect.poll(chosen).toBe(names.at(-1))
    await expect(chip).toBeVisible()
    await expect(menu).toBeVisible()
  } finally { await closeSotto(launched) }
})
