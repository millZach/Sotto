import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto, sottoWidget } from './support/sottoLaunch'

test('starts and stops dictation from the floating widget', async () => {
  const launched = await launchSotto()
  try {
    await launched.page.evaluate(() => window.sotto!.updateSettings({ onboardingComplete: true }))
    const widget = await sottoWidget(launched.app)
    await expect(widget.getByTestId('widget-sliver')).toBeVisible()
    await widget.getByTestId('widget-sliver').click()
    await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
    await widget.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect(widget.locator('.widget-shell[data-status="success"]')).toBeVisible()
  } finally { await closeSotto(launched) }
})
