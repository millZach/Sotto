import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, resizeWindow } from './support/sottoLaunch'
import { evidenceDirectory } from '../fixtures/evidence'

const evidence = evidenceDirectory('artifacts/review-388')

test('Settings mode row fits and keeps keyboard navigation', async () => {
  test.setTimeout(120_000)
  const launched = await launchSotto()
  const { page } = launched
  const geometry: unknown[] = []
  await mkdir(evidence, { recursive: true })
  try {
    await page.evaluate(async () => window.sotto!.updateSettings({ onboardingComplete: true, reducedMotion: 'on' }))
    await page.reload()
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    for (const [width, height] of [[820, 560], [1280, 800], [1600, 1000]] as const) {
      await resizeWindow(launched, width, height)
      for (const appearance of ['dark', 'light'] as const) {
        await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
        await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
        const bounds = await page.locator('.settings-sidebar').evaluate(sidebar => {
          const frame = sidebar.getBoundingClientRect()
          const row = sidebar.querySelector<HTMLElement>('.thread-nav__seg')!
          const buttons = [...row.querySelectorAll('button')]
          const labels = buttons.map(button => {
            const range = document.createRange(); range.selectNodeContents(button)
            const text = range.getBoundingClientRect(), box = button.getBoundingClientRect()
            return { name: button.textContent, width: box.width, font: getComputedStyle(button).fontSize,
              fits: text.left >= box.left && text.right <= box.right }
          })
          const controls = [...sidebar.querySelectorAll<HTMLElement>('.thread-nav__foot button, .thread-nav__foot a')]
          return { left: frame.left, right: frame.right, rowRight: row.getBoundingClientRect().right, labels,
            clipped: controls.filter(control => {
              const box = control.getBoundingClientRect()
              return box.left < frame.left || box.right > frame.right || box.bottom > innerHeight
            }).length }
        })
        geometry.push({ width, height, appearance, ...bounds })
        expect(bounds.rowRight).toBeLessThanOrEqual(bounds.right)
        expect(bounds.clipped).toBe(0)
        expect(bounds.labels.map(label => label.name)).toEqual(['Dictate', 'Threads'])
        expect(bounds.labels.every(label => label.fits && label.font === '12.5px')).toBe(true)
        expect(Math.max(...bounds.labels.map(label => label.width)) - Math.min(...bounds.labels.map(label => label.width))).toBeLessThan(1)
        await page.screenshot({ path: join(evidence, `settings-two-${width}-${appearance}.png`) })
      }
    }
    const modes = page.getByRole('tablist', { name: 'Page', exact: true })
    await modes.getByRole('tab', { name: 'Dictate', exact: true }).focus()
    await page.keyboard.press('End')
    await expect(page.getByRole('tab', { name: 'Threads', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await modes.getByRole('tab', { name: 'Dictate', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'Threads', exact: true })).toHaveAttribute('aria-selected', 'true')
  } finally {
    await writeFile(join(evidence, 'geometry.json'), JSON.stringify(geometry, null, 2))
    await closeSotto(launched)
  }
})
