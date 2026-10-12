// PROTOTYPE — throwaway. Screenshots each Settings > Cloud iPhone variant from a build made with VITE_SOTTO_PROTOTYPE=1.
import { resizeContentWindow } from './support/sottoWindow'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSotto } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const evidence = evidenceDirectory('artifacts/cloud-iphone-settings-prototype')

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1)
  await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', caret: 'hide' })
}

test('captures every Cloud iPhone settings variant', async () => {
  test.setTimeout(240_000)
  await mkdir(evidence, { recursive: true })
  const launched = await launchSotto('success')
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.evaluate(async () => { await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'on' }) })
    await page.reload()
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Cloud iPhone', exact: true }).click()
    const bar = page.getByRole('group', { name: 'Prototype variants' })
    await expect(bar).toBeVisible()
    for (const [width, height] of [[1280, 900], [820, 560]] as const) {
      await resizeContentWindow(launched, width, height, [800, 540])
      for (const variant of ['A', 'B', 'C', 'Now']) {
        while ((await bar.locator('b').textContent()) !== variant) await bar.getByRole('button', { name: 'Next variant' }).click()
        for (const mode of width === 1280 ? ['dark', 'light'] as const : ['dark'] as const) {
          await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), mode)
          await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
          await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0 })
          await shot(page, `${variant}-${width}-${mode}`)
          await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = element.scrollHeight })
          await shot(page, `${variant}-${width}-${mode}-bottom`)
        }
      }
    }
    // Live data: no key, no minutes, no sessions. And a save still reaches main from inside a variant.
    await resizeContentWindow(launched, 1280, 900, [800, 540])
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await bar.getByLabel('Sample data').uncheck()
    for (const variant of ['A', 'B', 'C']) {
      while ((await bar.locator('b').textContent()) !== variant) await bar.getByRole('button', { name: 'Next variant' }).click()
      await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = 0 })
      await shot(page, `${variant}-1280-dark-empty`)
      await page.locator('.settings-scroll').evaluate(element => { element.scrollTop = element.scrollHeight })
      await shot(page, `${variant}-1280-dark-empty-bottom`)
    }
    const cap = page.getByLabel('Monthly cap')
    await cap.fill('900'); await cap.blur()
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.getSettings()).cloudIphoneMonthlyMinutes)).toBe(900)
    expect(errors).toEqual([])
  } finally {
    await closeSotto(launched)
  }
})
