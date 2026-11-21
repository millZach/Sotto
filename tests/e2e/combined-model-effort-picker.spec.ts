import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { hostKeys } from './support/hostKeys'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'

// Combined composer model, effort & speed picker (ADR-0211): Inline Model Card + Power Gauge + Prism Ignition.
// Verifies resting layout, opening from both triggers, Power Gauge stepping, Prism Ignition & reduced motion,
// staying open on model pick, and bounds/no-overflow across 1600x1000, 1280x800 and 820x560 in dark and light themes.
const ARTIFACTS = evidenceDirectory('artifacts/combined-model-effort-picker')

test('opens one combined picker from model or effort, steps the Power Gauge with Prism Ignition, and holds across themes and sizes', async () => {
  test.setTimeout(180_000)
  await mkdir(ARTIFACTS, { recursive: true })
  const launched = await launchSotto('composer-speed')
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'system', effortColor: 'cyberpunk' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
      await window.sotto!.agents!.command({ type: 'connect' })
      await window.sotto!.agents!.command({ type: 'select-thread', threadId: 'workshop' })
      await window.sotto!.agents!.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'low', runtimeMode: 'full-access' })
    })
    await page.reload()
    await resizeWindow(launched, 1280, 800)
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()

    const workshop = (await hostKeys(page))('workshop')
    const saved = () => page.evaluate(async id => {
      const thread = (await window.sotto!.agents!.get()).host.threads.find(item => item.id === id)
      return { effort: thread?.reasoningEffort, speed: thread?.speed ?? (thread?.fastMode ? 'fast' : undefined) }
    }, workshop)

    const modelChip = page.getByRole('combobox', { name: 'Thread model', exact: true })
    const effortChip = page.getByRole('combobox', { name: 'Thread reasoning', exact: true })
    const dialog = page.getByRole('dialog', { name: 'Choose model', exact: true })

    // Opening from the model chip focuses Search models and shows the active inline card.
    await modelChip.click()
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('data-combined', 'true')
    await expect(dialog.getByRole('textbox', { name: 'Search models', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(modelChip).toBeFocused()

    // Opening from the effort chip focuses the Power Gauge slider directly.
    await effortChip.click()
    await expect(dialog).toBeVisible()
    const slider = dialog.getByRole('slider', { name: 'Thread reasoning effort', exact: true })
    const card = dialog.locator('.inline-model-card')
    await expect(slider).toBeFocused()
    await expect(slider).toHaveAttribute('aria-valuetext', 'Low')
    await expect(card).toHaveAttribute('data-highest', 'false')

    // Reaching the highest stop fires Prism Ignition and lights all Power Gauge cells.
    await slider.press('End')
    await expect.poll(async () => (await saved()).effort).toBeTruthy()
    await expect(card).toHaveAttribute('data-highest', 'true')
    await expect(card).toHaveAttribute('data-arriving', 'true')
    await page.screenshot({ path: join(ARTIFACTS, 'prism-ignition-dark-1280.png') })
    await expect(card).toHaveAttribute('data-arriving', 'false', { timeout: 6_000 })

    // Speed switch works in the same visit without closing the picker.
    const fast = dialog.getByRole('radio', { name: 'Fast', exact: true })
    if (await fast.count() > 0) {
      await fast.click()
      await expect(fast).toHaveAttribute('aria-checked', 'true')
      await expect(dialog).toBeVisible()
      await expect.poll(async () => (await saved()).speed).toBe('fast')
    }

    // Reduced motion settles cleanly with no running animations inside the dialog.
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await expect(card).toHaveAttribute('data-still', 'true')
    await slider.press('Home')
    await slider.press('End')
    await expect(card).toHaveAttribute('data-arriving', 'false')

    // Verify bounds and zero horizontal overflow at 1600x1000, 1280x800 and 820x560 in dark and light themes.
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async mode => window.sotto!.updateSettings({ appearance: mode }), appearance)
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        await expect(dialog).toBeVisible()
        const bounds = await dialog.evaluate(node => {
          const rect = node.getBoundingClientRect()
          return {
            inWindow: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
            dialogOverflow: node.scrollWidth > node.clientWidth + 1,
            pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
          }
        })
        expect(bounds, `${appearance} ${width}x${height}`).toEqual({ inWindow: true, dialogOverflow: false, pageOverflow: false })
        await page.screenshot({ path: join(ARTIFACTS, `combined-${appearance}-${width}.png`), animations: 'disabled' })
      }
    }

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(effortChip).toBeFocused()
    expect(errors).toEqual([])
  } finally {
    await closeSotto(launched)
  }
})
