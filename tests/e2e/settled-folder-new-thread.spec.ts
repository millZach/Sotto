import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'

test('new work reopens only its folder while older threads remain settled', async () => {
  test.setTimeout(90_000)
  const launched = await launchSotto()
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await openThreads(page)
    const sidebar = page.getByRole('complementary', { name: 'Thread sidebar' })
    const projects = sidebar.getByRole('region', { name: 'Projects' })
    const settled = sidebar.getByRole('region', { name: 'Settled', exact: true })
    await projects.getByRole('button', { name: 'Settle project Sotto test', exact: true }).click()
    await sidebar.getByRole('button', { name: /^Settled / }).click()
    await expect(settled.getByRole('button', { name: 'Workshop', exact: true })).toBeVisible()
    const create = sidebar.getByRole('button', { name: 'New thread', exact: true })
    await create.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'New thread', exact: true })
    await dialog.getByRole('button', { name: /^Sotto test/ }).click()
    await dialog.getByRole('textbox', { name: 'Thread name' }).fill('New work')
    await dialog.getByRole('button', { name: 'Create thread', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const check = async () => {
      await expect(projects.getByRole('button', { name: 'Sotto test 1 thread', exact: true })).toBeVisible()
      await expect(projects.getByRole('button', { name: 'New work', exact: true })).toBeVisible()
      await expect(projects.getByRole('button', { name: 'Workshop', exact: true })).toHaveCount(0)
      await expect(settled.getByRole('button', { name: 'Workshop', exact: true })).toBeVisible()
      await expect(settled.getByRole('button', { name: 'Docs', exact: true })).toBeVisible()
      await expect(settled.getByRole('button', { name: 'New work', exact: true })).toHaveCount(0)
    }
    await check()
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]]) {
        await resizeWindow(launched, width!, height!)
        await check()
        expect(await sidebar.evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false)
        await page.screenshot({ animations: 'disabled', path: `artifacts/settled-folder-new-thread/${appearance}-${width}.png` })
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await check()
    await page.screenshot({ animations: 'disabled', path: 'artifacts/settled-folder-new-thread/reduced-motion.png' })
    await page.reload()
    await sidebar.getByRole('button', { name: /^Settled / }).click()
    await check()
    // Individually restoring an older thread remains available after reopening the folder.
    await settled.getByRole('button', { name: 'Docs', exact: true }).hover()
    await settled.getByRole('button', { name: 'Restore Docs', exact: true }).click()
    await expect(projects.getByRole('button', { name: 'Docs', exact: true })).toBeVisible()
    await expect(settled.getByRole('button', { name: 'Workshop', exact: true })).toBeVisible()
  } finally { await closeSotto(launched) }
})
