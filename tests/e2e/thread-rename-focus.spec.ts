import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'

test('rename keeps its keyboard place in both themes and all window sizes', async () => {
  test.setTimeout(120_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await openThreads(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
        await resizeWindow(launched, width!, height!)
        const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
        await sidebar.getByRole('button', { name: 'Docs', exact: true }).click()
        const rename = sidebar.getByRole('button', { name: 'Rename Docs', exact: true })
        await rename.click()
        await sidebar.getByRole('textbox', { name: 'Rename Docs', exact: true }).press('Escape')
        await expect(rename).toBeFocused()
        await page.keyboard.press('Enter')
        await sidebar.getByRole('textbox', { name: 'Rename Docs', exact: true }).press('Enter')
        await expect(rename).toBeFocused()
        const header = page.locator('.thread-workspace__head')
        const more = header.getByRole('button', { name: 'More actions', exact: true })
        for (const key of ['Escape', 'Enter']) {
          await more.click()
          await header.getByRole('menuitem', { name: 'Rename', exact: true }).click()
          await header.getByRole('textbox', { name: 'Rename Docs', exact: true }).press(key)
          await expect(more).toBeFocused()
        }
        await expect(header.getByRole('heading', { name: 'Docs', exact: true })).toBeVisible()
        await page.screenshot({ animations: 'disabled', path: test.info().outputPath(`${appearance}-${width}.png`) })
      }
    }
  } finally { await closeSotto(launched) }
})
