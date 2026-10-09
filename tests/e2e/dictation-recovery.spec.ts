import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { E2E_PRESERVED_CLIPBOARD, E2E_TRANSCRIPT } from '../../src/shared/e2e'
import { closeSotto, launchSotto, openPage, resizeWindow } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const evidence = evidenceDirectory('artifacts/review-380')

test('completed dictation survives clipboard failure, navigation and later dictation with history off', async () => {
  const launched = await launchSotto('clipboard-recovery')
  const { page } = launched
  await mkdir(evidence, { recursive: true })
  try {
    await page.evaluate(async () => window.sotto!.updateSettings({ onboardingComplete: true, historyEnabled: false, autoPaste: true, reducedMotion: 'on' }))
    await page.reload()
    await openPage(page, 'Dictate')
    const dictate = async () => {
      await page.getByRole('button', { name: 'Start dictation', exact: true }).click()
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
    }
    await dictate()
    const text = page.getByRole('textbox', { name: 'Completed dictation text' })
    await expect(text).toHaveValue(E2E_TRANSCRIPT)
    expect(await page.evaluate(() => window.sottoE2E!.snapshot())).toMatchObject({ clipboardText: E2E_PRESERVED_CLIPBOARD, pasteAttempts: 0 })
    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        await text.scrollIntoViewIfNeeded()
        await expect(text).toBeInViewport()
        await expect(page.getByRole('button', { name: 'Start dictation', exact: true })).toBeInViewport({ ratio: 1 })
        await expect(page.getByRole('button', { name: 'Copy text', exact: true })).toBeInViewport({ ratio: 1 })
        await expect(page.getByRole('button', { name: 'Dismiss text', exact: true })).toBeInViewport({ ratio: 1 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: join(evidence, `recovery-${width}-${appearance}.png`) })
      }
    }
    await openPage(page, 'Settings')
    await openPage(page, 'Dictate')
    await expect(text).toHaveValue(E2E_TRANSCRIPT)
    await dictate()
    await expect(text).toHaveCount(2)
    await expect(text.nth(0)).toHaveValue(E2E_TRANSCRIPT)
    await expect(text.nth(1)).toHaveValue(E2E_TRANSCRIPT)
    const recovered = page.getByRole('article', { name: 'Recovered transcript' }).first()
    await recovered.getByRole('button', { name: 'Copy text' }).focus()
    await page.keyboard.press('Enter')
    await expect(recovered.getByRole('status')).toContainText('Copy failed. Your text is still here.')
    await expect(text).toHaveCount(2)
    await recovered.getByRole('button', { name: 'Copy text' }).focus()
    await page.keyboard.press('Enter')
    await expect(recovered.getByRole('status')).toHaveText('Copied.')
    expect(await page.evaluate(() => window.sottoE2E!.snapshot())).toMatchObject({ clipboardText: E2E_TRANSCRIPT, pasteAttempts: 0 })
    expect(await page.evaluate(() => window.sotto!.listHistory())).toEqual([])
    await recovered.getByRole('button', { name: 'Dismiss text' }).click()
    await expect(text).toHaveCount(1)
    await dictate()
    await expect(page.getByRole('heading', { name: 'Pasted.', exact: true })).toBeVisible()
    await expect(text).toHaveValue(E2E_TRANSCRIPT)
    expect(await page.evaluate(() => window.sottoE2E!.snapshot())).toMatchObject({ pasteAttempts: 1 })
    expect(await page.evaluate(() => window.sotto!.listHistory())).toEqual([])
  } finally { await closeSotto(launched) }
})
