import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { closeSotto, firstRunForwardButton, launchSotto } from './support/sottoLaunch'
import { holdContentSize } from './support/sottoWindow'

/** Sotto's default window, the smallest it allows (`src/main/windows/windowManager.ts`), and the two larger sizes every UI change is checked at. */
const SIZES = [[1080, 720], [820, 560], [1280, 800], [1600, 1000]] as const
/** The sizes at which no step may scroll at all (#1824); below them a step that is too tall scrolls its body as a whole. */
const ROOMY = new Set(['1280x800', '1600x1000'])
/** The steps most people pass without doing anything, where Skip for now is the filled button until their task starts (#1824). */
const SKIP_FIRST = new Set(['Your coding agents', 'Choose a project folder', 'Run agents on another computer'])

/**
 * First-run setup's card is as tall as its step, up to the window (#1824, ADR-0063): at 1600x1000 and 1280x800 no step
 * scrolls, and none leaves a tall empty card under its last line; at the default window and the minimum a step too tall
 * scrolls its body as a whole, with the footer under it rather than over it. The card is a fill with no outline (#1831).
 * The microphone step is measured after its test has heard a voice, and each size is captured light and dark.
 */
test('every first-run setup step fits its card, which grows with it up to the window and never hides content under its footer', async () => {
  test.setTimeout(420_000)
  const launched = await launchSotto()
  const { page } = launched
  const evidence = evidenceDirectory('artifacts/first-run-setup-fit')
  await mkdir(evidence, { recursive: true })
  const problems: string[] = []
  const checks: { step: string; width: number; height: number; overflow: number; spare: number }[] = []
  try {
    await page.evaluate(async () => window.sotto!.updateSettings({ reducedMotion: 'on' }))
    const body = page.locator('.onboarding-card__body')
    const total = Number(/^Step 1 of (\d+)/u.exec(await page.locator('.onboarding-progress__text').textContent() ?? '')?.[1])
    expect(total, 'the step line names how many steps there are').toBeGreaterThan(8)
    for (let step = 1; step <= total; step += 1) {
      const title = (await page.locator('#onboarding-heading').textContent()) ?? `step ${step}`
      if (title === 'Check your microphone') {
        await page.getByRole('button', { name: 'Test microphone', exact: true }).click()
        await expect(page.getByText('Sotto heard you. Your microphone works.')).toBeVisible()
      }
      if (SKIP_FIRST.has(title) && await page.getByRole('button', { name: 'Skip for now' }).count() > 0) {
        await expect(page.getByRole('button', { name: 'Skip for now' })).toHaveClass(/tt-button--primary/u)
      }
      expect(await page.locator('.onboarding-card').evaluate(card => getComputedStyle(card).borderTopWidth), 'the card has no outline').toBe('0px')
      for (const [width, height] of SIZES) {
        await holdContentSize(launched, width, height)
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          const size = `${width}x${height}`
          const measured = await page.evaluate(() => {
            const body = document.querySelector<HTMLElement>('.onboarding-card__body')!
            const card = document.querySelector<HTMLElement>('.onboarding-card')!.getBoundingClientRect()
            const footer = document.querySelector<HTMLElement>('.onboarding-actions')!.getBoundingClientRect()
            const box = body.getBoundingClientRect()
            const last = [...body.querySelectorAll<HTMLElement>(':scope > *')].filter(child => child.getClientRects().length > 0).at(-1)
            return {
              overflow: body.scrollHeight - body.clientHeight,
              // The room left in the body under its last block, which a card as tall as its step keeps to its padding.
              spare: last === undefined ? 0 : Math.round(box.bottom - last.getBoundingClientRect().bottom),
              footerUnderBody: footer.top >= box.bottom - 1,
              inWindow: card.bottom <= innerHeight + 1 && card.top >= 0,
              wide: document.documentElement.scrollWidth <= innerWidth,
            }
          })
          checks.push({ step: title, width, height, overflow: measured.overflow, spare: measured.spare })
          if (ROOMY.has(size) && measured.overflow > 0) problems.push(`${title} at ${size} ${appearance} scrolls ${measured.overflow}px`)
          if (ROOMY.has(size) && measured.spare > 40) problems.push(`${title} at ${size} ${appearance} leaves ${measured.spare}px of empty card`)
          if (!measured.footerUnderBody) problems.push(`${title} at ${size} ${appearance}: the footer is over the step`)
          if (!measured.inWindow) problems.push(`${title} at ${size} ${appearance}: the card leaves the window`)
          expect(measured.wide, `${title} at ${size} ${appearance} is wider than the window`).toBe(true)
          await page.screenshot({ path: resolve(evidence, `step-${step}-${size}-${appearance}.png`) })
        }
      }
      await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
      if (step === 1) await page.getByRole('button', { name: 'Get started' }).click()
      else if (step < total) await firstRunForwardButton(page).click()
      if (step < total) await expect(page.locator('.onboarding-progress__text')).toContainText(`Step ${step + 1} of ${total}`)
    }
    await expect(body).toBeVisible()
    expect(problems).toEqual([])
  } finally {
    await writeFile(resolve(evidence, 'checks.json'), `${JSON.stringify(checks, null, 2)}\n`)
    await closeSotto(launched)
  }
})
