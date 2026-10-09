import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto } from './support/sottoLaunch'

test('the idle pill starts dictation and keeps its controls inside the capsule', async () => {
  const launched = await launchSotto('design-threads')
  const { page, app } = launched
  try {
    await page.evaluate(async () => {
      await window.sotto!.updateSettings({ onboardingComplete: true, theme: 'dark', reducedMotion: 'on', showWidgetWhenIdle: true })
      await window.sotto!.agents!.command({ type: 'configure', patch: { enabled: true, speak: false } })
      await window.sotto!.agents!.command({ type: 'connect' })
    })
    await page.reload()
    const widget = app.windows().find(window => window.url().endsWith('/widget.html'))!
    await expect(widget.getByTestId('widget-sliver')).toBeVisible()
    await expect(widget.locator('.agent-widget')).toHaveCount(0)
    await expect(widget.getByRole('region', { name: 'Threads', exact: true })).toHaveCount(0)
    await widget.screenshot({ animations: 'disabled', path: 'artifacts/crossing/pill-resting.png' })
    await widget.getByTestId('widget-sliver').hover()
    await widget.getByTestId('widget-sliver').click({ position: { x: 40, y: 14 }, timeout: 5000 })
    await expect(widget.getByTestId('listening-bars')).toBeVisible()
    await expect(widget.getByRole('button', { name: 'Stop dictation' })).toBeVisible()
    await widget.screenshot({ animations: 'disabled', path: 'artifacts/crossing/pill-listening-controls.png' })
    expect(await widget.locator('.widget-capsule').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await widget.getByRole('button', { name: 'Cancel dictation' }).click()
    await expect(widget.getByTestId('listening-bars')).toHaveCount(0)
  } finally { await closeSotto(launched) }
})
