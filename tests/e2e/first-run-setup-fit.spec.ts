import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { evidenceDirectory } from '../fixtures/evidence'
import { closeSotto, launchSotto, setupForwardButton, setupNote, setupStop, type SetupStopId } from './support/sottoLaunch'
import { holdContentSize } from './support/sottoWindow'

/** Sotto's default window, the smallest it allows (`src/main/windows/windowManager.ts`), and the two larger sizes every UI change is checked at. */
const SIZES = [[1080, 720], [820, 560], [1280, 800], [1600, 1000]] as const
/** The note follows its control by animation frame as the page lays out, so each measurement waits this long after a change. */
const SETTLE_MS = 600
/** More presses than the walk has stops, so a walk that never reaches its last note fails rather than loops. */
const MOST_STOPS = 13

/**
 * First-run setup is a walk of notes over the real pages (ADR-0200). At Sotto's default window, the smallest it allows
 * and the two larger sizes every UI change is checked at, dark and light, every stop's note is inside the window, sits
 * beside the control it lights rather than over it, shows all of itself without scrolling, and leaves the page no wider
 * than the window. An agent is connected first, so the walk visits its project and thread stops too; the project stop
 * is measured without opening its folder dialog. The microphone stop is measured after Settings' test has heard a voice.
 */
test('every first-run setup note fits the window beside the control it lights, at every size, dark and light', async () => {
  test.setTimeout(600_000)
  const launched = await launchSotto()
  const { page } = launched
  const evidence = evidenceDirectory('artifacts/first-run-setup-fit')
  await mkdir(evidence, { recursive: true })
  const problems: string[] = []
  const checks: { stop: SetupStopId; width: number; height: number; appearance: 'dark' | 'light'; overlap: number; scrolls: number; inWindow: boolean }[] = []
  const visited: SetupStopId[] = []
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ reducedMotion: 'on' })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    for (let presses = 0; presses < MOST_STOPS; presses += 1) {
      const stop = await setupStop(page)
      visited.push(stop)
      // With an agent ready, the walk goes on to its project and thread stops rather than passing over them.
      if (stop === 'agents') await expect(setupForwardButton(page)).toHaveText('Continue')
      if (stop === 'microphone') {
        await page.locator('.settings-microphone-test').getByRole('button', { name: 'Test microphone', exact: true }).click()
        await expect(setupNote(page)).toContainText('Sotto heard you. Your microphone works.')
      }
      for (const [width, height] of SIZES) {
        await holdContentSize(launched, width, height)
        for (const appearance of ['dark', 'light'] as const) {
          await page.evaluate(async appearance => window.sotto!.updateSettings({ appearance }), appearance)
          await expect(page.locator('html')).toHaveAttribute('data-theme', appearance)
          await page.waitForTimeout(SETTLE_MS)
          const size = `${width}x${height}`
          const measured = await page.evaluate(() => {
            const note = document.querySelector<HTMLElement>('.setup-walk__note')!
            const lit = document.querySelector<HTMLElement>('.setup-walk__lit')
            const box = note.getBoundingClientRect(), litBox = lit?.getBoundingClientRect()
            // The area the note and the lit control's outline share, which a note beside its control keeps at nothing.
            const overlap = litBox
              ? Math.max(0, Math.min(box.right, litBox.right) - Math.max(box.left, litBox.left)) * Math.max(0, Math.min(box.bottom, litBox.bottom) - Math.max(box.top, litBox.top))
              : 0
            return {
              overlap: Math.round(overlap),
              inWindow: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
              scrolls: note.scrollHeight - note.clientHeight,
              wide: document.documentElement.scrollWidth <= innerWidth,
            }
          })
          checks.push({ stop, width, height, appearance, overlap: measured.overlap, scrolls: measured.scrolls, inWindow: measured.inWindow })
          if (!measured.inWindow) problems.push(`${stop} at ${size} ${appearance}: the note leaves the window`)
          if (measured.overlap > 0) problems.push(`${stop} at ${size} ${appearance}: the note covers ${measured.overlap}px² of the control it lights`)
          if (measured.scrolls > 0) problems.push(`${stop} at ${size} ${appearance}: the note scrolls ${measured.scrolls}px`)
          expect(measured.wide, `${stop} at ${size} ${appearance} is wider than the window`).toBe(true)
          await page.screenshot({ path: resolve(evidence, `${visited.length}-${stop}-${size}-${appearance}.png`) })
        }
      }
      await page.evaluate(async () => window.sotto!.updateSettings({ appearance: 'dark' }))
      if (stop === 'end') break
      // Skip for now, Continue or Continue to dictation; on the project stop this passes its folder dialog by.
      await setupForwardButton(page).click()
      await expect(page.locator('.setup-walk')).not.toHaveAttribute('data-stop', stop)
      await page.waitForTimeout(SETTLE_MS)
    }
    expect(visited, 'the walk visits its project and thread stops with an agent connected').toEqual(expect.arrayContaining(['project', 'thread']))
    expect(visited.at(-1), 'the walk reaches its last note').toBe('end')
    expect(problems).toEqual([])
  } finally {
    await writeFile(resolve(evidence, 'checks.json'), `${JSON.stringify({ visited, checks }, null, 2)}\n`)
    await closeSotto(launched)
  }
})
