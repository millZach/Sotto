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
        const row = sidebar.getByRole('button', { name: 'Docs', exact: true })
        await row.click()
        // A double-click on the name renames; F2 does the same from the keyboard. Either way the focus comes back to the row.
        await row.locator('.thread-nav__title').dblclick()
        await sidebar.getByRole('textbox', { name: 'Rename Docs', exact: true }).press('Escape')
        await expect(row).toBeFocused()
        await page.keyboard.press('F2')
        await sidebar.getByRole('textbox', { name: 'Rename Docs', exact: true }).press('Enter')
        await expect(row).toBeFocused()
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
