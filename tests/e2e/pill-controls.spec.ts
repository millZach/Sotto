import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto } from './support/sottoLaunch'

test('one pill keeps dictation, mute controls, and explicit thread expansion together', async () => {
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
    await expect(widget.getByRole('button', { name: 'Mute microphone', exact: true })).toBeVisible()
    await widget.getByRole('button', { name: 'Mute microphone', exact: true }).click()
    await expect(widget.getByRole('button', { name: 'Unmute microphone' })).toHaveAttribute('aria-pressed', 'true')
    await widget.getByRole('button', { name: 'Unmute voice', exact: true }).click()
    await expect(widget.getByRole('button', { name: 'Mute voice', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await widget.getByRole('button', { name: 'Mute voice', exact: true }).click()
    await expect(widget.getByRole('button', { name: 'Unmute voice', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(widget.getByTestId('widget-sliver')).toBeVisible()
    await widget.getByTestId('widget-sliver').hover()
    await expect(widget.locator('.widget-sliver__prompt')).toHaveCSS('opacity', '1')
    await widget.screenshot({ animations: 'disabled', path: 'artifacts/crossing/pill-controls.png' })

    await widget.getByRole('button', { name: 'Expand threads' }).click()
    await expect(widget.getByRole('region', { name: 'Threads', exact: true })).toBeVisible()
    await expect(widget.locator('.widget-shell')).toHaveAttribute('data-orientation', 'horizontal')
    await expect(widget.locator('.widget-threads__thread:visible')).toHaveCount(5)
    await widget.getByText('Settled (4)', { exact: true }).click()
    await expect(widget.getByRole('button', { name: /Release notes/ })).toBeVisible()
    await widget.getByRole('button', { name: /Release notes/ }).click()
    await expect(widget.locator('.widget-threads__detail > h2')).toHaveText('Release notes 1.4')
    expect(await widget.locator('.widget-threads').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await widget.screenshot({ animations: 'disabled', path: 'artifacts/crossing/pill-threads.png' })
    await widget.getByRole('button', { name: 'Collapse threads' }).click()
    await expect(widget.getByRole('region', { name: 'Threads', exact: true })).toHaveCount(0)
    await widget.getByTestId('widget-sliver').hover()
    await widget.getByTestId('widget-sliver').click({ position: { x: 40, y: 14 }, timeout: 5000 })
    await expect(widget.getByTestId('listening-bars')).toBeVisible()
    await expect(widget.getByRole('button', { name: 'Mute microphone', exact: true })).toBeVisible()
    await expect(widget.getByRole('button', { name: 'Stop dictation' })).toBeVisible()
    await widget.screenshot({ animations: 'disabled', path: 'artifacts/crossing/pill-listening-controls.png' })
    expect(await widget.locator('.widget-capsule').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await widget.getByRole('button', { name: 'Mute microphone', exact: true }).click()
    await expect(widget.getByTestId('listening-bars')).toHaveCount(0)
  } finally { await closeSotto(launched) }
})
