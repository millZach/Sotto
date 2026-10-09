import { ownedE2EProfile, removeOwnedE2EProfile } from './support/e2eProfile'
import { expect, test, type Page } from '@playwright/test'
import { launchSotto, openPage, openThreads } from './support/sottoLaunch'

async function connect(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.sotto!.updateSettings({ onboardingComplete: true })
    await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
    await window.sotto!.agents!.command({ type: 'connect' })
  })
  await page.reload()
  await openThreads(page)
}

// The harness starts folders open (ThreadSidebar.tsx), so a folder the user closes is the toggle under test: it lasts
// while the window lives, across pages that remount the sidebar, and a fresh launch forgets it.
test('a folder toggle lasts while Sotto runs and is forgotten on the next launch', async () => {
  test.setTimeout(120_000)
  const userData = (await ownedE2EProfile({ prefix: 'sotto-e2e-' })).directory
  try {
    const first = await launchSotto('success', userData)
    let name: string
    try {
      await connect(first.page)
      const projects = first.page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('region', { name: 'Projects' })
      const toggle = projects.locator('.thread-folder__toggle').first()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      name = (await toggle.getAttribute('aria-label'))!
      await toggle.click()
      await expect(projects.getByRole('button', { name, exact: true })).toHaveAttribute('aria-expanded', 'false')
      await openPage(first.page, 'Dictate')
      await openThreads(first.page)
      await expect(projects.getByRole('button', { name, exact: true })).toHaveAttribute('aria-expanded', 'false')
    } finally { await first.app.close().catch(() => undefined) }

    const second = await launchSotto('success', userData)
    try {
      await connect(second.page)
      const projects = second.page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('region', { name: 'Projects' })
      await expect(projects.getByRole('button', { name, exact: true })).toHaveAttribute('aria-expanded', 'true')
    } finally { await second.app.close().catch(() => undefined) }
  } finally { await removeOwnedE2EProfile(userData) }
})
