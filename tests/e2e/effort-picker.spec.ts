import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { closeSotto, launchSottoWithVoice, openThreads, resizeWindow } from './support/sottoLaunch'

async function savedEffort(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === 'workshop')?.reasoningEffort)
}

test('the effort furnace previews smoothly, saves on release, melts before gold, and stays usable across window sizes', async () => {
  test.setTimeout(90_000)
  await mkdir('artifacts/effort-furnace', { recursive: true })
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
      await window.sotto!.agents!.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'low' })
    })
    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    const chip = page.getByRole('combobox', { name: 'Thread reasoning', exact: true })
    const panel = page.getByRole('dialog', { name: 'Reasoning effort', exact: true })
    const range = panel.getByRole('slider', { name: 'Thread reasoning effort', exact: true })
    await chip.click()
    await expect(range).toBeFocused()
    await expect(panel.getByRole('button', { name: / effort$/ })).toHaveCount(5)

    const track = (await range.boundingBox())!
    await page.mouse.move(track.x + 8, track.y + track.height / 2)
    await page.mouse.down()
    await page.mouse.move(track.x + 8 + (track.width - 16) * .38, track.y + track.height / 2, { steps: 12 })
    const preview = await range.inputValue()
    expect(Number(preview)).toBeGreaterThan(1)
    expect(Number(preview)).toBeLessThan(2)
    expect(await savedEffort(page)).toBe('low')
    await page.mouse.up()
    await expect.poll(() => savedEffort(page)).toBe('high')
    await expect(range).toHaveValue('2')
    await expect(panel).toBeVisible()

    await range.focus()
    const selectedAt = Date.now()
    await range.press('End')
    await expect.poll(() => savedEffort(page)).toBe('max')
    await expect(panel).toHaveAttribute('data-gold', 'false')
    const max = panel.getByRole('button', { name: 'Max effort', exact: true })
    const unheatedText = await max.evaluate(node => getComputedStyle(node).color)
    await expect(max).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: 'artifacts/effort-furnace/max-ignition.png' })
    await expect(panel).toHaveAttribute('data-gold', 'true', { timeout: 6_000 })
    expect(Date.now() - selectedAt).toBeGreaterThan(1_900)
    expect(await max.evaluate(node => getComputedStyle(node).color)).not.toBe(unheatedText)
    await page.screenshot({ path: 'artifacts/effort-furnace/max-gold.png' })
    await range.press('Home')
    await expect.poll(() => savedEffort(page)).toBe('low')
    await expect(panel).toHaveAttribute('data-gold', 'false')

    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    const focusAfterEscape = await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') }))
    await expect(chip, JSON.stringify(focusAfterEscape)).toBeFocused()
    await chip.click()
    await page.getByRole('heading', { name: 'What is next for this thread?', exact: true }).click()
    await expect(panel).toHaveCount(0)
    await chip.click()
    await panel.getByRole('button', { name: 'Done', exact: true }).focus()
    await page.keyboard.press('Tab')
    await expect(panel).toHaveCount(0)

    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Review the parser.')
    await chip.click()
    await panel.getByRole('button', { name: 'Add Ultrathink to prompt', exact: true }).click()
    await expect(prompt).toHaveValue('Review the parser.\n\nultrathink')
    await expect(prompt).toBeFocused()
    expect(await savedEffort(page)).toBe('low')
    expect((await page.evaluate(async () => window.sotto!.agents!.threadDetail!('workshop')))?.messages).toHaveLength(0)
    await chip.click()
    await expect(panel.getByRole('button', { name: 'Ultrathink is in this prompt', exact: true })).toBeDisabled()

    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await expect(panel).toHaveAttribute('data-still', 'true')
    await range.press('End')
    await expect(panel).toHaveAttribute('data-gold', 'true', { timeout: 1_000 })
    expect(await panel.evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length)).toBe(0)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        await expect(panel).toBeVisible()
        await expect.poll(async () => {
          const anchor = (await chip.boundingBox())!
          const popup = (await panel.boundingBox())!
          return Math.abs(anchor.y - popup.y - popup.height - 8)
        }).toBeLessThanOrEqual(2)
        expect(await panel.evaluate(node => {
          const rect = node.getBoundingClientRect()
          return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
            && node.scrollWidth <= node.clientWidth && document.documentElement.scrollWidth <= innerWidth
        })).toBe(true)
        await page.screenshot({ path: `artifacts/effort-furnace/${appearance}-${width}.png` })
      }
    }
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'system' }))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(panel).toHaveAttribute('data-still', 'true')
    await range.press('Home')
    await expect.poll(() => savedEffort(page)).toBe('low')
    await expect(chip).toBeEnabled()
    await expect(panel).toHaveAttribute('data-gold', 'false')
    await range.press('End')
    await expect(panel).toHaveAttribute('data-gold', 'true', { timeout: 1_000 })
    expect(errors).toEqual([])
  } finally { await closeSotto(launched) }
})
