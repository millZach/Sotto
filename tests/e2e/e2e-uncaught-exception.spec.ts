import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto } from './support/sottoLaunch'

/**
 * An uncaught exception in an e2e-launched main fails its test instead of putting Electron's "A JavaScript error
 * occurred in the main process" box on the desktop of whoever runs the suite (#1577). The box is modal: it held main until
 * someone dismissed it, so the test hung to its deadline. The one that prompted this came from a timer that read a
 * window after the app had closed it, so this one throws the same way, from a timer that outlives its window.
 */
test('an uncaught exception in main fails the test with where it was thrown, and never its words', async () => {
  const launched = await launchSotto()
  await launched.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    const timer = setInterval(() => {
      if (!window.isDestroyed()) return
      clearInterval(timer)
      throw new TypeError('words a thread said')
    }, 50)
  })
  const closed = closeSotto(launched)
  await expect(closed).rejects.toThrow(/uncaught exception\.\n\[Sotto\] e2e-uncaught-exception TypeError\n\s+at /u)
  await expect(closed).rejects.not.toThrow(/words a thread said/u)
})
