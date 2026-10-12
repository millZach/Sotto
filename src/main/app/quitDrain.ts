interface QuitEvent { preventDefault(): void }
interface QuitApp { prependListener(event: 'before-quit', listener: (event: QuitEvent) => void): unknown; quit(): void; exit(): void }
/** The public powerMonitor methods used by the desktop shutdown drain. */
export interface SystemShutdownSource {
  on(event: 'shutdown', listener: (event?: QuitEvent) => void): unknown
  removeListener(event: 'shutdown', listener: (event?: QuitEvent) => void): unknown
}
export interface SystemShutdown {
  source: SystemShutdownSource
  platform: 'darwin' | 'linux'
  /** Start urgent local cleanup even when an ordinary quit is already waiting elsewhere. */
  prepare?: () => void
}

/** How long a system shutdown notice lets the next quit through without draining. */
export const SYSTEM_ENDING_WINDOW_MS = 30_000
/** Leave one second inside logind's default five-second delay for process exit. Shorter host limits still win. */
export const LINUX_SHUTDOWN_DRAIN_MS = 4_000

/**
 * Give accepted writes and owned child processes ten seconds to settle before forcing exit.
 * macOS system quits go through at once: holding them interrupts logout. Linux
 * explicitly quits under a delay inhibitor with the shorter bound above.
 */
export function registerQuitDrain(app: QuitApp, drain: () => Promise<void>, failed: () => void, systemShutdown?: SystemShutdown): void {
  let pending: Promise<void> | undefined
  let complete = false
  let systemEnding = false
  let linuxShutdown = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let expire: (() => void) | undefined
  // Not prevented: preventing it on macOS stops the terminate that follows, and the log out with it.
  // Another app can cancel the log out, and then no quit follows; a later Command-Q drains again.
  const shutdown = (event?: QuitEvent): void => {
    if (systemShutdown?.platform === 'linux') {
      if (complete) return
      event?.preventDefault()
      if (linuxShutdown) return
      linuxShutdown = true
      try { systemShutdown.prepare?.() } catch { failed() }
      // Linux only emits the notice; unlike macOS it never sends an app quit.
      // A quit already draining gets the same bounded window from this notice.
      if (expire) { clearTimeout(timer); timer = setTimeout(expire, LINUX_SHUTDOWN_DRAIN_MS) }
      app.quit()
      return
    }
    systemEnding = true
    setTimeout(() => { systemEnding = false }, SYSTEM_ENDING_WINDOW_MS).unref?.()
  }
  // Intercept quit before bootstrap disposes the native windows and tray.
  app.prependListener('before-quit', event => {
    if (complete) return
    if (systemEnding) {
      complete = true
      pending ??= Promise.resolve().then(drain).catch(() => failed())
      return
    }
    event.preventDefault()
    if (pending) return
    let timedOut = false
    const timeout = new Promise<void>(resolve => {
      expire = () => { timedOut = true; resolve() }
      timer = setTimeout(expire, linuxShutdown ? LINUX_SHUTDOWN_DRAIN_MS : 10_000)
    })
    pending = Promise.race([Promise.resolve().then(drain), timeout]).catch(() => failed()).finally(() => {
      clearTimeout(timer)
      if (complete) return
      complete = true
      if (timedOut) app.exit()
      else app.quit()
    })
  })
  if (systemShutdown) {
    systemShutdown.source.on('shutdown', shutdown)
    if (systemShutdown.platform === 'linux') {
      // Electron 43 checks listenerCount in its first newListener callback,
      // before that listener is added. Re-register so the native delay inhibitor is acquired.
      systemShutdown.source.removeListener('shutdown', shutdown)
      systemShutdown.source.on('shutdown', shutdown)
    }
  }
}
