import { expect, test } from '@playwright/test'

import { withSotto } from '../fixtures/designCaptureProfile'
import { widgetThemes, capturePage, captureWidget, widgetPage } from './support/designCapture'
import { openPage } from './support/sottoLaunch'

const captureEnabled = process.env.SOTTO_DESIGN_CAPTURE === '1'

test.describe('authoritative design-review captures', () => {
  test.skip(!captureEnabled, 'Run through npm run design:capture or npm run design:verify')
  test.describe.configure({ mode: 'serial', timeout: 10 * 60_000 })

  test('orb and session states follow the voice and permission journeys', async () => {
    await withSotto({ voice: true, onboardingComplete: true }, async ({ page }) => {
      await page.evaluate(async () => { await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } }); await window.sotto!.agents!.command({ type: 'connect' }) })
      await page.getByRole('tab', { name: 'Agents', exact: true }).click()
      await page.getByRole('button', { name: 'Not now', exact: true }).click()
      await expect(page.locator('.agent-orb')).toHaveAttribute('data-state', 'wake')
      await capturePage(page, 'agents-wake.png')
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('sotto:e2e:microphone', { detail: 'Hey Sotto' })))
      await expect(page.locator('.agent-orb')).toHaveAttribute('data-state', 'listening')
      await capturePage(page, 'agents-listening.png')
      const threadId = await page.evaluate(async () => {
        const state = await window.sotto!.agents!.get()
        const id = state.host.threads[0]!.id
        await window.sotto!.agents!.command({ type: 'assign', threadId: id })
        await window.sotto!.agents!.command({ type: 'select-thread', threadId: id })
        await window.sottoE2E!.agentEvent!({ type: 'permission', threadId: id, text: 'Allow the agent to update the project files?', requestId: 'crossing-permission' })
        return id
      })
      await expect(page.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
      await capturePage(page, 'agents-attention.png')
      await page.getByRole('button', { name: 'Open Workshop', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Workshop' })).toBeVisible()
      await capturePage(page, 'agents-session.png')
      await page.keyboard.press('Escape')
      expect(await page.evaluate(async id => (await window.sotto!.agents!.get()).host.threads.find(thread => thread.id === id)?.requests.length, threadId)).toBe(1)
    })
  })

  for (const theme of widgetThemes) {
    test(`${theme} widget states missing from the established widget baseline are captured`, async () => {
      await withSotto({ onboardingComplete: true, motion: 'reduced' }, async (launched) => {
        await openPage(launched.page, 'Dictate')
        // Bootstrap seeds the idle snapshot after showing both windows. Wait
        // for that seed so it cannot overwrite the first recording snapshot.
        const widget = await widgetPage(launched, theme, 'reduced')
        await expect(widget.locator('.widget-shell[data-status="idle"]')).toBeVisible()
        await launched.page.getByRole('button', { name: 'Start dictation' }).click()
        await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
        await widget.getByRole('button', { name: 'Cancel dictation' }).click()
        await expect(widget.locator('.widget-shell[data-status="idle"]')).toBeVisible({ timeout: 15_000 })
        await expect(widget.locator('.widget-sliver')).toBeVisible()
        await captureWidget(
          widget,
          `widget-idle-${theme}.png`,
          { category: 'widget', state: 'idle-sliver', theme, reducedMotion: true },
          { width: 124, height: 54 },
        )
      })

      await withSotto({ onboardingComplete: true, motion: 'reduced', scenario: 'design-permission' }, async (launched) => {
        await openPage(launched.page, 'Dictate')
        const widget = await widgetPage(launched, theme, 'reduced')
        await expect(widget.locator('.widget-shell[data-status="idle"]')).toBeVisible()
        await launched.page.getByRole('button', { name: 'Start dictation' }).click()
        await expect(widget.getByText('Waiting for microphone', { exact: true })).toBeVisible()
        await captureWidget(widget, `widget-permission-${theme}.png`, { category: 'widget', state: 'requesting-permission', theme, reducedMotion: true })
      })

      await withSotto({ onboardingComplete: true, motion: 'reduced' }, async (launched) => {
        await openPage(launched.page, 'Dictate')
        const widget = await widgetPage(launched, theme, 'reduced')
        await expect(widget.locator('.widget-shell[data-status="idle"]')).toBeVisible()
        await launched.page.getByRole('button', { name: 'Start dictation' }).click()
        await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
        await widget.getByRole('button', { name: 'Cancel dictation' }).click()
        await expect(widget.getByText('Cancelled', { exact: true })).toBeVisible()
        await captureWidget(widget, `widget-cancelled-${theme}.png`, { category: 'widget', state: 'cancelled', theme, reducedMotion: true })
      })
    })
  }
})
