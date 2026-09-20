import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { closeSotto, launchSottoWithVoice, openThreads, resizeWindow } from './support/sottoLaunch'

const ARTIFACTS = 'artifacts/effort-slider'

async function savedEffort(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === 'workshop')?.reasoningEffort)
}

/** The composer's outline is its ::after ring; its opacity says whether the thread wears the colourway. */
async function outlineOpacity(composer: Locator): Promise<string> {
  return composer.evaluate(node => getComputedStyle(node, '::after').opacity)
}

async function runningAnimations(page: Page): Promise<number> {
  // Document.getAnimations() covers every element and pseudo-element in the page, the composer's outline included.
  return page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length)
}

test('the effort card previews a drag, saves on release, plays the arrival at the top and dresses the composer, across window sizes', async () => {
  test.setTimeout(120_000)
  await mkdir(ARTIFACTS, { recursive: true })
  const launched = await launchSottoWithVoice()
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'system', effortColor: 'ember' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
      await window.sotto!.agents!.command({ type: 'select-thread', threadId: 'workshop' })
      await window.sotto!.agents!.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'low' })
    })
    await page.reload()
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    const chip = page.getByRole('combobox', { name: 'Thread reasoning', exact: true })
    const card = page.getByRole('dialog', { name: 'Reasoning effort', exact: true })
    const range = card.getByRole('slider', { name: 'Thread reasoning effort', exact: true })
    const composer = page.locator('.thread-prompt').filter({ has: chip })
    await expect(chip).toHaveAttribute('data-effort-top', 'false')
    expect(await outlineOpacity(composer)).toBe('0')
    await chip.click()
    await expect(range).toBeFocused()
    await expect(range).toHaveAttribute('aria-valuetext', 'Low')
    await expect(card.getByText('Fast. For small, clear tasks.')).toBeVisible()
    // The fixture model reports Low as its default, so Default has nothing to do yet.
    await expect(card.getByRole('button', { name: 'Default', exact: true })).toBeDisabled()
    await expect(card.getByRole('button', { name: / effort$/ })).toHaveCount(0)

    // A drag previews without saving; release saves the level the thumb settled on.
    const track = (await range.boundingBox())!
    await page.mouse.move(track.x + 13, track.y + track.height / 2)
    await page.mouse.down()
    await page.mouse.move(track.x + 13 + (track.width - 26) * .38, track.y + track.height / 2, { steps: 12 })
    const preview = await range.inputValue()
    expect(Number(preview)).toBeGreaterThan(1)
    expect(Number(preview)).toBeLessThan(2)
    expect(await savedEffort(page)).toBe('low')
    await page.mouse.up()
    await expect.poll(() => savedEffort(page)).toBe('high')
    await expect(chip).toBeEnabled()
    await expect(range).toHaveValue('2')
    await expect(card).toBeVisible()
    await expect(card.getByRole('button', { name: 'Default', exact: true })).toBeEnabled()

    // Reaching the top: the arrival plays once, the chip and the composer wear the colourway, and the line names the cost.
    await range.focus()
    await range.press('End')
    await expect.poll(() => savedEffort(page)).toBe('max')
    await expect(chip).toBeEnabled()
    await expect(card).toHaveAttribute('data-top', 'true')
    await expect(card).toHaveAttribute('data-arriving', 'true')
    await expect(chip).toHaveAttribute('data-effort-top', 'true')
    await expect(card.getByText('Everything the model has. Slowest, costliest.')).toBeVisible()
    await page.screenshot({ path: `${ARTIFACTS}/max-arrival.png` })
    await expect(card).toHaveAttribute('data-arriving', 'false', { timeout: 6_000 })
    await expect.poll(() => outlineOpacity(composer)).toBe('1')
    await page.screenshot({ path: `${ARTIFACTS}/max-settled.png` })
    // Lowering the level takes the colourway off again.
    await range.press('Home')
    await expect.poll(() => savedEffort(page)).toBe('low')
    await expect(chip).toBeEnabled()
    await expect(card).toHaveAttribute('data-top', 'false')
    await expect(chip).toHaveAttribute('data-effort-top', 'false')
    await expect.poll(() => outlineOpacity(composer)).toBe('0')
    // The Default button returns to the model's default, and the wheel steps a level.
    await range.press('End')
    await expect.poll(() => savedEffort(page)).toBe('max')
    await expect(chip).toBeEnabled()
    await card.getByRole('button', { name: 'Default', exact: true }).click()
    await expect.poll(() => savedEffort(page)).toBe('low')
    await expect(chip).toBeEnabled()
    await range.hover()
    await page.mouse.wheel(0, -120)
    await expect.poll(() => savedEffort(page)).toBe('medium')
    await expect(chip).toBeEnabled()
    await range.press('Home')
    await expect.poll(() => savedEffort(page)).toBe('low')
    await expect(chip).toBeEnabled()

    // Escape, a pointer outside and Tab out of the card all close it; Escape hands focus back to the chip.
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
    const focusAfterEscape = await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') }))
    await expect(chip, JSON.stringify(focusAfterEscape)).toBeFocused()
    await chip.click()
    await page.getByRole('heading', { name: 'What is next for this thread?', exact: true }).click()
    await expect(card).toHaveCount(0)
    await chip.click()
    // Ultrathink is the card's last control; Tab from it leaves the card, and the card closes behind it.
    await card.getByRole('button', { name: 'Add Ultrathink to prompt', exact: true }).focus()
    await page.keyboard.press('Tab')
    await expect(card).toHaveCount(0)

    // Ultrathink stays a visible instruction in the Claude draft, added once.
    const prompt = page.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Review the parser.')
    await chip.click()
    await card.getByRole('button', { name: 'Add Ultrathink to prompt', exact: true }).click()
    await expect(prompt).toHaveValue('Review the parser.\n\nultrathink')
    await expect(prompt).toBeFocused()
    expect(await savedEffort(page)).toBe('low')
    expect((await page.evaluate(async () => window.sotto!.agents!.threadDetail!('workshop')))?.messages).toHaveLength(0)
    await chip.click()
    await expect(card.getByRole('button', { name: 'Ultrathink is in this prompt', exact: true })).toBeDisabled()

    // Reduced motion, by the app's setting: the settled state, nothing running, the outline a still ring.
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    await expect(card).toHaveAttribute('data-still', 'true')
    await range.press('End')
    await expect.poll(() => savedEffort(page)).toBe('max')
    await expect(chip).toBeEnabled()
    await expect(card).toHaveAttribute('data-top', 'true')
    await expect(card).toHaveAttribute('data-arriving', 'false')
    await expect.poll(() => outlineOpacity(composer)).toBe('1')
    expect(await runningAnimations(page)).toBe(0)
    for (const appearance of ['dark', 'light'] as const) {
      await page.evaluate(async value => window.sotto!.updateSettings({ appearance: value }), appearance)
      for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
        await resizeWindow(launched, width, height)
        await expect(card).toBeVisible()
        await expect.poll(async () => {
          const anchor = (await chip.boundingBox())!
          const popup = (await card.boundingBox())!
          return Math.abs(anchor.y - popup.y - popup.height - 8)
        }).toBeLessThanOrEqual(2)
        expect(await card.evaluate(node => {
          const rect = node.getBoundingClientRect()
          return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
            && node.scrollWidth <= node.clientWidth && document.documentElement.scrollWidth <= innerWidth
        })).toBe(true)
        await page.screenshot({ path: `${ARTIFACTS}/${appearance}-${width}.png` })
      }
    }
    // Reduced motion by the operating system reads the same way.
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'system' }))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(card).toHaveAttribute('data-still', 'true')
    await range.press('Home')
    await expect.poll(() => savedEffort(page)).toBe('low')
    await expect(chip).toBeEnabled()
    await range.press('End')
    await expect.poll(() => savedEffort(page)).toBe('max')
    await expect(chip).toBeEnabled()
    await expect(card).toHaveAttribute('data-arriving', 'false')
    // The system's preference reaches the card and the outline the same way; other surfaces keep their own 1ms transitions.
    expect(await card.evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running')
      .map(animation => `${(animation.effect as KeyframeEffect | null)?.target?.tagName ?? '?'}${(animation.effect as KeyframeEffect | null)?.pseudoElement ?? ''}:${'animationName' in animation ? String(animation.animationName) : 'transitionProperty' in animation ? String(animation.transitionProperty) : animation.id}`))).toEqual([])
    expect(await composer.evaluate(node => getComputedStyle(node, '::after').animationName)).toBe('none')
    expect(errors).toEqual([])
  } finally { await closeSotto(launched) }
})

test('Settings → Appearance offers the effort colourways, paints the pick at once and carries it to the composer', async () => {
  test.setTimeout(90_000)
  await mkdir(ARTIFACTS, { recursive: true })
  const launched = await launchSottoWithVoice()
  const { page } = launched
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, appearance: 'dark', reducedMotion: 'system', effortColor: 'ember' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
      await window.sotto!.agents!.command({ type: 'configure-thread', threadId: 'workshop', reasoningEffort: 'max' })
    })
    await page.reload()
    await resizeWindow(launched, 1280, 800)
    await expect(page.locator('html')).toHaveAttribute('data-effort-color', 'ember')
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'Appearance', exact: true }).click()
    const section = page.locator('#settings-appearance')
    const group = section.getByRole('group', { name: 'Effort color', exact: true })
    await group.scrollIntoViewIfNeeded()
    await expect(group.getByRole('button')).toHaveCount(6)
    await expect(group.getByRole('button', { name: 'Use Ember as the effort color, currently active' })).toHaveAttribute('aria-pressed', 'true')
    const sample = section.locator('.effort-sample')
    await expect(sample).toHaveAttribute('data-arriving', 'false')
    await group.getByRole('button', { name: 'Use Cyberpunk as the effort color', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-effort-color', 'cyberpunk')
    await expect(group.getByRole('button', { name: 'Use Cyberpunk as the effort color, currently active' })).toHaveAttribute('aria-pressed', 'true')
    await expect(sample).toHaveAttribute('data-arriving', 'true')
    await page.screenshot({ path: `${ARTIFACTS}/appearance-cyberpunk.png` })
    await expect.poll(async () => (await page.evaluate(async () => window.sotto!.getSettings())).effortColor).toBe('cyberpunk')
    await expect(sample).toHaveAttribute('data-arriving', 'false', { timeout: 6_000 })
    // The colourway is a setting, so it survives a reload, and the thread at its highest level wears it.
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-effort-color', 'cyberpunk')
    await openThreads(page)
    await page.getByRole('button', { name: 'Workshop', exact: true }).click()
    const chip = page.getByRole('combobox', { name: 'Thread reasoning', exact: true })
    await expect(chip).toHaveAttribute('data-effort-top', 'true')
    const composer = page.locator('.thread-prompt').filter({ has: chip })
    await expect.poll(() => outlineOpacity(composer)).toBe('1')
    await page.screenshot({ path: `${ARTIFACTS}/composer-cyberpunk.png` })
    expect(errors).toEqual([])
  } finally { await closeSotto(launched) }
})
