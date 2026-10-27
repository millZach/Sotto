import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { hostKeys } from './support/hostKeys'
import { closeSotto, launchSotto, openThreads } from './support/sottoLaunch'
import { resizeWindow } from './support/sottoWindow'
import { evidenceDirectory } from '../fixtures/evidence'

// Ultracode (ADR-0148): the stop past Max on a Claude model, its hint, its chip, and the setting that names the effort
// it runs at, in the built app at each window size, dark and light.
const ARTIFACTS = evidenceDirectory('artifacts/ultracode-effort')

async function savedEffort(page: Page): Promise<string | undefined> {
  const workshop = (await hostKeys(page))('workshop')
  return page.evaluate(async id => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === id)?.reasoningEffort, workshop)
}
/** The composer's edge, which it never wears (ADR-0110): its border's colour and whatever its ::after draws. */
async function composerEdge(composer: Locator): Promise<{ border: string; ring: string }> {
  return composer.evaluate(node => {
    const after = getComputedStyle(node, '::after')
    return { border: getComputedStyle(node).borderTopColor, ring: after.content === 'none' || after.content === 'normal' ? 'none' : after.backgroundImage }
  })
}
/** Whether a box sits wholly inside the window. */
async function inWindow(page: Page, locator: Locator): Promise<boolean> {
  const box = (await locator.boundingBox())!
  const size = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height
}

test('Ultracode is the stop past Max, says what it costs, and runs at the effort Settings names', async () => {
  test.setTimeout(120_000)
  await mkdir(ARTIFACTS, { recursive: true })
  const launched = await launchSotto('ultracode')
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'system', effortColor: 'ember' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
      await window.sotto!.agents!.command({ type: 'connect' })
      await window.sotto!.agents!.command({ type: 'select-thread', threadId: 'workshop' })
      await window.sotto!.agents!.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'max' })
    })
    await page.reload()
    await resizeWindow(launched, 1280, 800)
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    const chip = page.getByRole('combobox', { name: 'Thread reasoning', exact: true })
    const card = page.getByRole('dialog', { name: 'Reasoning effort', exact: true })
    const range = card.getByRole('slider', { name: 'Thread reasoning effort', exact: true })
    const hint = card.locator('.effort-card__hint')
    const composer = page.locator('.thread-prompt').filter({ has: chip })

    await chip.click()
    await expect(range).toHaveAttribute('max', '5')
    await expect(range).toHaveAttribute('aria-valuetext', 'Max')
    // The pointer resting on the last stop says what Ultracode costs before it is chosen; on Max's it does not.
    const track = (await range.boundingBox())!
    await page.mouse.move(track.x + 13 + (track.width - 26) * .8, track.y + track.height / 2)
    await expect(hint).toHaveAttribute('data-shown', 'false')
    await page.mouse.move(track.x + track.width - 13, track.y + track.height / 2)
    await expect(hint).toHaveAttribute('data-shown', 'true')
    await expect(hint).toHaveText('Runs a multi-agent workflow; uses many more tokens.')
    await expect(hint).toBeVisible()
    expect(await inWindow(page, hint)).toBe(true)
    await page.screenshot({ path: `${ARTIFACTS}/dark-1280-hint.png` })

    await range.focus()
    await range.press('ArrowRight')
    await expect.poll(() => savedEffort(page)).toBe('ultracode')
    await expect(range).toHaveAttribute('aria-valuetext', 'Ultracode')
    await expect(card.locator('.effort-card__word')).toHaveText('Ultracode')
    await expect(card.getByText('Plans the work and runs it as a team of agents at Extra high effort. Uses many more tokens.')).toBeVisible()
    await expect(chip).toHaveText('Ultracode')
    await expect(chip).toHaveAttribute('data-effort-top', 'true')
    await expect(chip).toHaveAttribute('title', 'Thread reasoning. Runs a multi-agent workflow; uses many more tokens.')
    await expect(chip.locator('.thread-chip__ultracode')).toBeVisible()
    expect(await composerEdge(composer)).toEqual({ border: 'rgba(0, 0, 0, 0)', ring: 'none' })
    await page.mouse.move(0, 0)
    await page.screenshot({ path: `${ARTIFACTS}/dark-1280.png` })

    // At every window size the card stays whole on screen.
    for (const [width, height] of [[1600, 1000], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      await expect.poll(() => inWindow(page, card)).toBe(true)
      await page.screenshot({ path: `${ARTIFACTS}/dark-${width}.png` })
    }
    await resizeWindow(launched, 1280, 800)
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'light' }))
    await expect(card).toBeVisible()
    await page.screenshot({ path: `${ARTIFACTS}/light-1280.png` })
    // Rainbow paints the word through a clipped gradient with a transparent fill; the marks keep an ink of their own.
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark', effortColor: 'rainbow' }))
    for (const mark of [card.locator('.effort-card__mark'), chip.locator('.thread-chip__ultracode')]) {
      await expect.poll(() => mark.evaluate(node => getComputedStyle(node).color)).not.toBe('rgba(0, 0, 0, 0)')
    }
    await page.evaluate(() => window.sotto!.updateSettings({ effortColor: 'ember' }))
    await page.keyboard.press('Escape')
    await expect(card).toBeHidden()
    await expect(chip).toBeFocused()

    // Settings names the effort Ultracode runs at; the card's line follows it.
    await page.evaluate(() => window.sotto!.updateSettings({ appearance: 'dark' }))
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Providers', exact: true }).click()
    const providers = page.getByRole('list', { name: 'Thread providers', exact: true })
    await providers.getByRole('button', { name: 'Claude Code', exact: true }).click()
    const setting = providers.getByRole('combobox', { name: 'Ultracode effort', exact: true })
    await expect(setting).toHaveValue('xhigh')
    await expect(setting.locator('option:checked')).toHaveText('Extra high (Claude Code’s choice)')
    await setting.selectOption('high')
    await expect.poll(() => page.evaluate(async () => (await window.sotto!.agents!.get()).configuration.claudeUltracodeEffort)).toBe('high')
    await setting.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${ARTIFACTS}/dark-1280-setting.png` })

    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    await chip.click()
    await expect(card.getByText('Plans the work and runs it as a team of agents at High effort. Uses many more tokens.')).toBeVisible()
    expect(await savedEffort(page)).toBe('ultracode')
    expect(errors).toEqual([])
  } finally {
    await closeSotto(launched)
  }
})
