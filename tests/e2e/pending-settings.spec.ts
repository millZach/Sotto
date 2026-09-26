import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { closeSotto, launchSottoWithVoice, openThreads, resizeWindow, type LaunchedSotto } from './support/sottoLaunch'

/** Every capture this spec takes; the verification note copies the few it cites into `artifacts/pending-settings/`. */
const ARTIFACTS = 'artifacts/pending-settings-run'
const SIZES = [[1600, 1000], [1280, 800], [820, 560]] as const

async function savedMode(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === 'workshop' || thread.id.endsWith(':workshop'))?.runtimeMode)
}
/** Drives the fixture provider's thread settings: hold each change, let them through, refuse the next one, or start the thread on a kept one. */
async function settings(page: Page, text: 'hold' | 'release' | 'refuse' | 'apply'): Promise<void> {
  await page.evaluate(async value => window.sottoE2E!.agentEvent!({ type: 'settings', threadId: 'workshop', text: value }), text)
}
async function choose(page: Page, chip: Locator, name: string): Promise<void> {
  await chip.click()
  await page.getByRole('listbox', { name: 'Thread permissions' }).getByRole('option', { name, exact: true }).click()
}
/** The chips, the caption and any line under them sit inside the window with nothing clipped or scrolled sideways. */
async function fits(page: Page): Promise<boolean> {
  return page.locator('form.thread-prompt').evaluate(form => {
    const inside = (element: Element): boolean => {
      const rect = element.getBoundingClientRect()
      return rect.width === 0 || (rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight)
    }
    const caption = form.querySelector('.thread-options__caption')
    return [...form.querySelectorAll('.thread-chip, .thread-options__notice, .thread-prompt__send')].every(inside) && (caption === null || inside(caption))
      && (caption === null || caption.scrollWidth <= caption.clientWidth + 1) && document.documentElement.scrollWidth <= innerWidth
  })
}
/**
 * Where the footer row's controls sit in the composer: the attach button, each chip and the send button, measured
 * from the composer's top left corner. The composer grows upward from the bottom of the pane when a line is added
 * under its row, so the row is compared where it sits in the composer, not in the window.
 */
async function footerRow(page: Page): Promise<string> {
  return page.locator('form.thread-prompt').evaluate(form => {
    const frame = form.getBoundingClientRect()
    return JSON.stringify([...form.querySelectorAll('.screenshot-input__tools > .tt-button, .thread-chip, .thread-prompt__send')].map(element => {
      const rect = element.getBoundingClientRect()
      return [Math.round(rect.left - frame.left), Math.round(rect.top - frame.top), Math.round(rect.width), Math.round(rect.height)]
    }))
  })
}
async function pendingDotAnimations(chip: Locator): Promise<number> {
  return chip.evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running'
    && (animation.effect as KeyframeEffect | null)?.target?.classList.contains('thread-chip__pending')).length)
}
/** Each appearance at each size: the row stays where it is without the line under it, and nothing clips. */
async function across(launched: LaunchedSotto, name: string, rows: Map<string, string> | null, visible: Locator): Promise<void> {
  const { page } = launched
  for (const appearance of ['dark', 'light'] as const) {
    await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
    for (const [width, height] of SIZES) {
      await resizeWindow(launched, width, height)
      await expect(visible).toBeVisible()
      expect(await fits(page)).toBe(true)
      if (rows) expect(await footerRow(page), `${name} ${appearance} ${width}`).toBe(rows.get(`${appearance}-${width}`))
      await page.screenshot({ path: `${ARTIFACTS}/${name}-${appearance}-${width}.png` })
    }
  }
  await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
  await resizeWindow(launched, 1280, 800)
}

test('a permission choice shows at once, marked pending with what is in force; a refusal puts it back with Try again, and a lost answer keeps it', async () => {
  test.setTimeout(240_000)
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
    const lines = page.locator('form.thread-prompt .thread-options-notices')
    await expect(chip).toHaveText('Ask for approval')
    await expect(caption).toBeEmpty()

    // The keyboard path: the list opens from the chip, Escape closes it and hands focus back, nothing is saved.
    await chip.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('listbox', { name: 'Thread permissions' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('listbox', { name: 'Thread permissions' })).toHaveCount(0)
    await expect(chip).toBeFocused()

    // Where the footer row sits with nothing under it, in each appearance and size, before anything is pressed.
    const rows = new Map<string, string>()
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
      for (const [width, height] of SIZES) { await resizeWindow(launched, width, height); rows.set(`${appearance}-${width}`, await footerRow(page)) }
    }
    await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
    await resizeWindow(launched, 1280, 800)

    // Held at the provider: the chip shows the choice at once, marked, and the caption says what is still in force.
    await settings(page, 'hold')
    await choose(page, chip, 'Full access')
    await expect(chip).toHaveText('Full access')
    await expect(chip).toHaveAttribute('data-pending', 'true')
    await expect(chip).toBeFocused()
    await expect(chip).toBeEnabled()
    await expect(caption).toHaveText('Claude still asks for approval until it confirms.')
    // The chip is described by the caption itself: the same words, said once.
    await expect(chip).toHaveAccessibleDescription('Claude still asks for approval until it confirms.')
    await expect(page.getByText('Saving...')).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Thread model', exact: true })).toBeEnabled()
    await expect(page.getByRole('combobox', { name: 'Thread reasoning', exact: true })).toBeEnabled()
    expect(await savedMode(page)).toBe('approval-required')
    expect(await chip.evaluate(node => getComputedStyle(node).borderStyle)).toBe('dashed')
    await expect.poll(() => pendingDotAnimations(chip)).toBe(1)
    await across(launched, 'pending', null, caption)

    // Reduced motion, by the app's setting and by the system's: the dot is still, the rest reads the same.
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
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
    // Back where it started, so the footer row compares with the one measured before anything was pressed.
    await choose(page, chip, 'Ask for approval')
    await expect.poll(() => savedMode(page)).toBe('approval-required')
    await expect(chip).not.toHaveAttribute('data-pending')

    // Refused outright: the chip goes back to the mode in force and a line under the whole row says so.
    await settings(page, 'hold')
    await settings(page, 'refuse')
    await choose(page, chip, 'Full access')
    await expect(chip).toHaveText('Full access')
    await settings(page, 'release')
    const alert = lines.getByRole('alert')
    await expect(alert).toContainText('Claude did not switch to Full access. The thread stays on Ask for approval; nothing else changed.')
    await expect(chip).toHaveText('Ask for approval')
    await expect(chip).not.toHaveAttribute('data-pending')
    await expect(caption).toBeEmpty()
    expect(await savedMode(page)).toBe('approval-required')
    // The pane's own error line leaves the refusal to the line under the chips.
    await expect(page.locator('.thread-workspace__error')).toHaveCount(0)
    // The attach button, the chips and the send button stay exactly where they were without the line.
    await across(launched, 'refused', rows, alert)

    // Try again sends the refused choice once more and puts focus on its chip.
    await alert.getByRole('button', { name: 'Try again', exact: true }).click()
    await expect(lines.getByRole('alert')).toHaveCount(0)
    await expect(chip).toHaveText('Full access')
    await expect(chip).toBeFocused()
    await expect.poll(() => savedMode(page)).toBe('full-access')
    await expect(chip).not.toHaveAttribute('data-pending')

    // A refusal with a reason of its own is shown in those words, with no claim that nothing else changed.
    const reason = 'Wait for this Claude turn to finish before changing settings.'
    await page.evaluate(async text => window.sottoE2E!.agentEvent!({ type: 'reject', threadId: 'workshop', text }), reason)
    await choose(page, chip, 'Allow edits')
    await expect(lines.getByRole('alert')).toHaveText(`Claude did not switch to Allow edits. ${reason}Try again`)
    await expect(chip).toHaveText('Full access')
    await page.screenshot({ path: `${ARTIFACTS}/refused-reason-dark-1280.png` })

    // A lost answer: no result, so main keeps the change for the thread's next start and the chip keeps showing it.
    const lost = 'Claude Code did not confirm the settings change, so Sotto stopped this thread\'s session, and "npm test" stopped with it. The session starts again with the new settings the next time you use the thread. Ask Claude to start it again if you still need it.'
    await page.evaluate(async text => window.sottoE2E!.agentEvent!({ type: 'settings-unconfirmed', threadId: 'workshop', text }), lost)
    await choose(page, chip, 'Auto')
    const notice = lines.getByRole('alert')
    await expect(notice).toHaveText(`Claude has not confirmed Auto. ${lost}`)
    await expect(notice.getByRole('button')).toHaveCount(0)
    await expect(chip).toHaveText('Auto')
    await expect(chip).toHaveAttribute('data-pending', 'true')
    await expect(chip).toHaveAccessibleDescription(`Claude has not confirmed Auto. ${lost}`)
    await expect(caption).toBeEmpty()
    // Main takes no other action on the thread until it knows, so the chips wait with it.
    for (const name of ['Thread model', 'Thread reasoning', 'Thread permissions']) await expect(page.getByRole('combobox', { name, exact: true })).toBeDisabled()
    expect(await savedMode(page)).toBe('full-access')
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).unconfirmedSettings?.map(item => item.runtimeMode))).toEqual(['auto'])
    await across(launched, 'unconfirmed', null, notice)
    // The thread's next start carries it: the thread shows Auto, main lets the change go and the chip reads normally.
    await settings(page, 'apply')
    await expect(chip).not.toHaveAttribute('data-pending')
    await expect(chip).toHaveText('Auto')
    await expect(chip).toBeEnabled()
    await expect(lines.getByRole('alert')).toHaveCount(0)
    expect(await savedMode(page)).toBe('auto')
    expect(await page.evaluate(async () => (await window.sotto!.agents!.get()).unconfirmedSettings)).toBeUndefined()
    await page.screenshot({ path: `${ARTIFACTS}/unconfirmed-applied-dark-1280.png` })
    expect(errors).toEqual([])
  } finally { await settings(page, 'release').catch(() => undefined); await closeSotto(launched) }
})
