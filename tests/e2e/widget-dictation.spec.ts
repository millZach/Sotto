import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto } from './support/sottoLaunch'

test('starts and stops dictation from the floating widget', async () => {
  const launched = await launchSotto()
  try {
    const widget = launched.app.windows().find(window => window.url().endsWith('/widget.html'))!
    await expect(widget.getByTestId('widget-sliver')).toBeVisible()
    await widget.getByTestId('widget-sliver').click()
    await expect(widget.locator('.widget-shell[data-status="listening"]')).toBeVisible()
    await widget.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect(widget.locator('.widget-shell[data-status="success"]')).toBeVisible()
  } finally { await closeSotto(launched) }
})
