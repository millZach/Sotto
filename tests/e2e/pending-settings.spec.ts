import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { closeSotto, launchSottoWithVoice, openThreads, resizeWindow } from './support/sottoLaunch'

/** Every capture this spec takes; the verification note copies the few it cites into `artifacts/pending-settings/`. */
const ARTIFACTS = 'artifacts/pending-settings-run'

async function savedMode(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === 'workshop' || thread.id.endsWith(':workshop'))?.runtimeMode)
}
/** Drives the fixture provider's thread settings: hold each change, let them through, or refuse the next one. */
async function settings(page: Page, text: 'hold' | 'release' | 'refuse'): Promise<void> {
  await page.evaluate(async value => window.sottoE2E!.agentEvent!({ type: 'settings', threadId: 'workshop', text: value }), text)
}
async function choose(page: Page, chip: Locator, name: string): Promise<void> {
  await chip.click()
  await page.getByRole('listbox', { name: 'Thread permissions' }).getByRole('option', { name, exact: true }).click()
}
/** The chips, the caption and any alert sit inside the window with nothing clipped or scrolled sideways. */
async function fits(bar: Locator): Promise<boolean> {
  return bar.evaluate(node => {
    const inside = (element: Element): boolean => {
      const rect = element.getBoundingClientRect()
      return rect.width === 0 || (rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight)
    }
    const caption = node.querySelector('.thread-options__caption')
    return [...node.querySelectorAll('.thread-chip, .thread-options__refusal')].every(inside) && (caption === null || inside(caption))
      && (caption === null || caption.scrollWidth <= caption.clientWidth + 1) && document.documentElement.scrollWidth <= innerWidth
  })
}
async function pendingDotAnimations(chip: Locator): Promise<number> {
  return chip.evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running'
    && (animation.effect as KeyframeEffect | null)?.target?.classList.contains('thread-chip__pending')).length)
}

test('a permission choice shows at once, marked pending with what is in force, and a refusal puts it back with Try again', async () => {
  test.setTimeout(180_000)
  await mkdir(ARTIFACTS, { recursive: true })
  const launched = await launchSottoWithVoice()
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'system' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
      await window.sotto!.agents!.command({ type: 'select-thread', threadId: 'workshop' })
      await window.sotto!.agents!.command({ type: 'configure-thread', threadId: 'workshop', runtimeMode: 'approval-required' })
    })
    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await resizeWindow(launched, 1280, 800)
    const chip = page.getByRole('combobox', { name: 'Thread permissions', exact: true })
    const bar = page.locator('.thread-options-bar').filter({ has: chip })
    const caption = bar.getByRole('status')
    await expect(chip).toHaveText('Ask for approval')
    await expect(caption).toBeEmpty()

    // The keyboard path: the list opens from the chip, Escape closes it and hands focus back, nothing is saved.
    await chip.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('listbox', { name: 'Thread permissions' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('listbox', { name: 'Thread permissions' })).toHaveCount(0)
    await expect(chip).toBeFocused()

    // Held at the provider: the chip shows the choice at once, marked, and the caption says what is still in force.
    await settings(page, 'hold')
    await choose(page, chip, 'Full access')
    await expect(chip).toHaveText('Full access')
    await expect(chip).toHaveAttribute('data-pending', 'true')
    await expect(chip).toBeFocused()
    await expect(chip).toBeEnabled()
    await expect(caption).toHaveText('Claude still asks for approval until it confirms.')
    await expect(chip).toHaveAccessibleDescription('Switching to Full access. Ask for approval stays in force until Claude confirms.')
    await expect(page.getByText('Saving...')).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Thread model', exact: true })).toBeEnabled()
    await expect(page.getByRole('combobox', { name: 'Thread reasoning', exact: true })).toBeEnabled()
    expect(await savedMode(page)).toBe('approval-required')
    expect(await chip.evaluate(node => getComputedStyle(node).borderStyle)).toBe('dashed')
    await expect.poll(() => pendingDotAnimations(chip)).toBe(1)

    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        await expect(caption).toBeVisible()
        expect(await fits(bar)).toBe(true)
        await page.screenshot({ path: `${ARTIFACTS}/pending-${appearance}-${width}.png` })
      }
    }
    // Reduced motion, by the app's setting and by the system's: the dot is still, the rest reads the same.
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark', reducedMotion: 'on' }))
    await resizeWindow(launched, 1280, 800)
    await expect.poll(() => pendingDotAnimations(chip)).toBe(0)
    await expect(chip).toHaveAttribute('data-pending', 'true')
    await page.screenshot({ path: `${ARTIFACTS}/pending-reduced-motion.png` })
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'system' }))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => pendingDotAnimations(chip)).toBe(0)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await expect.poll(() => pendingDotAnimations(chip)).toBe(1)

    // Confirmed: the chip reads normally and the caption is gone.
    await settings(page, 'release')
    await expect(chip).not.toHaveAttribute('data-pending')
    await expect(chip).toHaveText('Full access')
    await expect(caption).toBeEmpty()
    expect(await savedMode(page)).toBe('full-access')
    await page.screenshot({ path: `${ARTIFACTS}/confirmed-dark-1280.png` })

    // Refused outright: the chip goes back to the mode in force and the alert under the chips says so.
    await settings(page, 'hold')
    await settings(page, 'refuse')
    await choose(page, chip, 'Allow edits')
    await expect(chip).toHaveText('Allow edits')
    await expect(caption).toHaveText('Claude still runs anything without asking until it confirms.')
    await settings(page, 'release')
    const alert = bar.getByRole('alert')
    await expect(alert).toContainText('Claude did not switch to Allow edits. The thread stays on Full access; nothing else changed.')
    await expect(chip).toHaveText('Full access')
    await expect(chip).not.toHaveAttribute('data-pending')
    await expect(caption).toBeEmpty()
    expect(await savedMode(page)).toBe('full-access')
    // The pane's own error line leaves the refusal to the alert under the chips.
    await expect(page.locator('.thread-workspace__error')).toHaveCount(0)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        await expect(alert).toBeVisible()
        expect(await fits(bar)).toBe(true)
        await page.screenshot({ path: `${ARTIFACTS}/refused-${appearance}-${width}.png` })
      }
    }
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await resizeWindow(launched, 1280, 800)

    // Try again sends the refused choice once more and puts focus on its chip.
    await alert.getByRole('button', { name: 'Try again', exact: true }).click()
    await expect(bar.getByRole('alert')).toHaveCount(0)
    await expect(chip).toHaveText('Allow edits')
    await expect(chip).toBeFocused()
    await expect.poll(() => savedMode(page)).toBe('auto-accept-edits')
    await expect(chip).not.toHaveAttribute('data-pending')

    // A refusal that says more is shown in the provider's words, with no claim that nothing else changed.
    const lost = 'Claude Code did not confirm the settings change, so Sotto stopped this thread\'s session, and "npm test" stopped with it. The session starts again with the new settings the next time you use the thread.'
    await page.evaluate(async text => window.sottoE2E!.agentEvent!({ type: 'reject', threadId: 'workshop', text }), lost)
    await choose(page, chip, 'Auto')
    await expect(bar.getByRole('alert')).toContainText(`Claude did not switch to Auto. ${lost}`)
    await expect(bar.getByRole('alert')).not.toContainText('nothing else changed')
    await expect(chip).toHaveText('Allow edits')
    await page.screenshot({ path: `${ARTIFACTS}/refused-lost-answer-dark-1280.png` })
    expect(errors).toEqual([])
  } finally { await settings(page, 'release').catch(() => undefined); await closeSotto(launched) }
})
