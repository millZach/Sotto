import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { fillPrompt, promptField } from './support/prompt'
import { closeSotto, launchSotto, openThreads, resizeWindow } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const ARTIFACTS = evidenceDirectory('artifacts/new-thread-greeting')

interface Box { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number; readonly width: number }

/** The pane, the greeting and the composer's own box, in the window's coordinates. */
async function layout(page: Page): Promise<{ pane: Box; greeting: Box | null; composer: Box; transcript: Box }> {
  return page.evaluate(() => {
    const box = (element: Element | null): Box | null => {
      if (element === null) return null
      const rect = element.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width }
    }
    const pane = document.querySelector('.thread-pane:not([data-hidden])')!
    return {
      pane: box(pane)!, greeting: box(pane.querySelector('.thread-greeting')),
      composer: box(pane.querySelector('.thread-prompt'))!, transcript: box(pane.querySelector('.thread-workspace__transcript'))!,
    }
  })
}

test('a new thread greets above its composer in the middle of the pane, and the first send settles the composer at the bottom', async () => {
  test.setTimeout(120_000)
  await mkdir(ARTIFACTS, { recursive: true })
  const launched = await launchSotto()
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
    const greeting = page.locator('.thread-greeting')
    await expect(greeting).toBeVisible()
    await expect(greeting.getByRole('heading', { level: 3 })).toHaveText(/\S/u)

    for (const [width, height] of [[1600, 1000], [1280, 800], [820, 560]] as const) {
      await resizeWindow(launched, width, height)
      await expect(greeting).toBeVisible()
      const { pane, greeting: words, composer } = await layout(page)
      // The greeting and composer stand as one block in the middle of the room under the header.
      const room = { top: (await page.locator('.thread-pane:not([data-hidden]) .thread-workspace__head').boundingBox())!.height + pane.top, bottom: pane.bottom }
      const above = words!.top - room.top
      const below = room.bottom - composer.bottom
      expect(Math.abs(above - below), `${width}x${height}: ${above} above, ${below} below`).toBeLessThan(48)
      // Narrower than a started thread's composer, and nothing past the pane's edges.
      expect(composer.width).toBeLessThanOrEqual(722)
      expect(words!.left).toBeGreaterThanOrEqual(pane.left)
      expect(words!.right).toBeLessThanOrEqual(pane.right)
      expect(composer.bottom).toBeLessThanOrEqual(pane.bottom)
      await page.screenshot({ path: `${ARTIFACTS}/greeting-${width}x${height}-dark.png` })
    }

    // At the minimum, a picker opened from the middle still fits the window.
    const model = page.getByRole('combobox', { name: 'Thread model', exact: true })
    await model.click()
    const list = page.getByRole('listbox').first()
    await expect(list).toBeVisible()
    const listed = (await list.boundingBox())!
    expect(listed.y).toBeGreaterThanOrEqual(0)
    expect(listed.y + listed.height).toBeLessThanOrEqual(560)
    await page.screenshot({ path: `${ARTIFACTS}/greeting-820x560-model-picker.png` })
    await page.keyboard.press('Escape')

    await resizeWindow(launched, 1280, 800)
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'light' }) })
    await expect(page.locator('html')).toHaveAttribute('data-theme', /light/u)
    await page.screenshot({ path: `${ARTIFACTS}/greeting-1280x800-light.png` })
    await page.evaluate(async () => { await window.sotto!.updateSettings({ appearance: 'dark' }) })

    const prompt = promptField(page)
    await fillPrompt(prompt, 'Check the greeting leaves on the first send.')
    await page.keyboard.press('Enter')
    await expect(greeting).toHaveCount(0)
    await expect.poll(async () => page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running'
      && (animation.effect as KeyframeEffect | null)?.target?.classList.contains('thread-workspace__compose')).length)).toBe(0)
    const settled = await layout(page)
    // Back at the bottom, at a started thread's width.
    expect(settled.pane.bottom - settled.composer.bottom).toBeLessThan(80)
    expect(settled.composer.width).toBeGreaterThan(722)
    await page.screenshot({ path: `${ARTIFACTS}/greeting-1280x800-after-send.png` })
    expect(errors).toEqual([])
  } finally {
    await closeSotto(launched)
  }
})
