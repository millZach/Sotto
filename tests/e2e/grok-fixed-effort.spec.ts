import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { promptField } from './support/prompt'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

/**
 * A started Grok thread's effort chip (#228, Zach's pick B on November 9, 2026): Grok keeps the level a thread began on,
 * so the chip has a dashed edge and a lock and opens nothing, and says why in a tip when the pointer rests on it or the
 * keyboard reaches it, and to a screen reader as its description.
 */
const ARTIFACTS = evidenceDirectory('artifacts/grok-fixed-effort-run')
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const
const REASON = 'Grok Build keeps the effort a thread started on. To use another level, start a new thread.'

/** The tip sits inside the window with nothing clipped, and nothing scrolls sideways. */
async function tipFits(page: Page): Promise<boolean> {
  return page.locator('.effort-fixed__tip').evaluate(tip => {
    const rect = tip.getBoundingClientRect()
    return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth
  })
}

test('a started Grok thread says why its effort stays, from the pointer, the keyboard and to a screen reader', async () => {
  test.setTimeout(180_000)
  await mkdir(ARTIFACTS, { recursive: true })
  const launched = await launchSotto('grok-fixed-effort')
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'system' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
      await window.sotto!.agents!.command({ type: 'connect' })
      await window.sotto!.agents!.command({ type: 'select-thread', threadId: 'workshop' })
    })
    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await resizeWindow(launched, 1280, 800)

    const chip = page.getByRole('button', { name: 'Thread reasoning, High', exact: true })
    const tip = page.locator('.effort-fixed__tip')
    await expect(chip).toBeVisible()
    await expect(chip).toHaveAttribute('aria-disabled', 'true')
    await expect(chip).toHaveAccessibleDescription(REASON)
    await expect(page.getByRole('combobox', { name: 'Thread reasoning' })).toHaveCount(0)
    await expect(tip).toBeHidden()
    await page.screenshot({ path: `${ARTIFACTS}/rest-dark-1280.png` })

    // The pointer: resting on the chip shows why; a press opens nothing; leaving puts the tip away.
    await chip.hover()
    await expect(tip).toBeVisible()
    await expect(tip).toHaveText(REASON)
    // aria-disabled, so Playwright won't press it without force; a person can, and it must open nothing.
    await chip.click({ force: true })
    await expect(page.getByRole('dialog', { name: 'Thread reasoning' })).toHaveCount(0)
    await expect(page.getByRole('listbox')).toHaveCount(0)
    await page.mouse.move(0, 0)
    await expect(tip).toBeHidden()

    // The keyboard: Tab reaches the chip and shows why; Escape puts the tip away and leaves focus on the chip.
    // From the message box, as a person writing would; the model chip is fixed too, so Tab passes over it.
    await promptField(page).focus()
    for (let step = 0; step < 12 && !(await chip.evaluate(node => node === document.activeElement)); step++) await page.keyboard.press('Tab')
    await expect(chip).toBeFocused()
    await expect(tip).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(tip).toBeHidden()
    await expect(chip).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    await expect(tip).toBeVisible()

    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
      for (const [width, height] of SIZES) {
        await resizeWindow(launched, width, height)
        await expect(tip).toBeVisible()
        expect(await tipFits(page), `${appearance} ${width}`).toBe(true)
        await page.screenshot({ path: `${ARTIFACTS}/tip-${appearance}-${width}.png` })
      }
    }
    // Nothing was saved: the thread is where it started.
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id.endsWith('workshop'))?.reasoningEffort)).toBe('high')
    expect(errors).toEqual([])
  } finally {
    await closeSotto(launched)
  }
})
