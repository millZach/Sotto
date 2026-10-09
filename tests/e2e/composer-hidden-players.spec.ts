import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'

test('hidden players do not scan the window during composer edits', async () => {
  const launched = await launchSotto('phase3-workspace')
  const { page } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    await openThreads(page)
    await page.getByRole('complementary', { name: 'Thread sidebar' }).getByRole('button', { name: 'Grok voice previews', exact: true }).click()
    const input = page.locator('#thread-workspace-prompt')
    await input.fill('Start')
    await expect(page.locator('.phone-player, .browser-player')).toHaveCount(0)
    await page.evaluate(() => {
      const original = document.querySelectorAll.bind(document)
      const audit = { scans: 0 }
      Object.assign(window, { __hiddenPlayerAudit: audit })
      document.querySelectorAll = ((selector: string) => {
        if (selector.includes('[data-covers-native-view]')) audit.scans++
        return original(selector)
      }) as typeof document.querySelectorAll
    })
    await input.pressSequentially(' typing a few more letters', { delay: 20 })
    await expect(input).toHaveValue('Start typing a few more letters')
    const result = await page.evaluate(() => (window as unknown as { __hiddenPlayerAudit: { scans: number } }).__hiddenPlayerAudit)
    expect(result.scans, 'A hidden player scanned the entire document during ordinary typing').toBe(0)
  } finally { await closeSotto(launched) }
})
