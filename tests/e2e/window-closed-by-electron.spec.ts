import { expect, test } from '@playwright/test'
import { closeSotto, launchSotto } from './support/sottoLaunch'

/**
 * macOS's installer closes every window itself when Sotto restarts to update, and a window that has closed throws
 * "Object has been destroyed" for some native calls. Sotto's own clean-up after a window must not touch it that way: it
 * raised Electron's "A JavaScript error occurred in the main process" dialog on Restart now.
 */
test('a window that Electron closes on its own leaves no uncaught exception in main', async () => {
  const launched = await launchSotto()
  try {
    const { uncaught, logs } = await launched.app.evaluate(({ BrowserWindow }) => new Promise<{ uncaught: string[]; logs: string[] }>(resolve => {
      const uncaught: string[] = []
      const logs: string[] = []
      // A listener keeps Electron from showing its dialog, so the test run reads the error instead of waiting on it.
      process.on('uncaughtException', error => uncaught.push(error.message))
      const log = console.error.bind(console)
      console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); log(...args) }
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html'))!
      // Sotto's own closed listener was added first. When one of them throws, this one never runs, so the deadline answers.
      main.once('closed', () => setImmediate(() => resolve({ uncaught, logs })))
      setTimeout(() => resolve({ uncaught, logs }), 5_000)
      main.destroy()
    }))
    expect(uncaught).toEqual([])
    // A clean-up step that threw and was caught would still say so here.
    expect(logs).not.toContain('[Sotto] renderer-cleanup-failed')
  } finally { await closeSotto(launched) }
})
