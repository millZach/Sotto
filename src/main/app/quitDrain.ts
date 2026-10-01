interface QuitEvent { preventDefault(): void }
interface QuitApp { prependListener(event: 'before-quit', listener: (event: QuitEvent) => void): unknown; quit(): void; exit(): void }
/** Electron's powerMonitor on macOS: 'shutdown' comes before the quit that logout, restart or shutdown sends. */
export interface SystemShutdownSource { on(event: 'shutdown', listener: () => void): unknown }

/**
 * Give accepted writes and owned child processes ten seconds to settle before forcing exit.
 * When the system is logging out, restarting or shutting down, the quit goes through at once and the drain only
 * gets a head start: holding that quit would make macOS report that Sotto interrupted the log out.
 */
export function registerQuitDrain(app: QuitApp, drain: () => Promise<void>, failed: () => void, systemShutdown?: SystemShutdownSource): void {
  let pending: Promise<void> | undefined
  let complete = false
  let systemEnding = false
  // Not prevented: preventing it on macOS stops the terminate that follows, and the log out with it.
  systemShutdown?.on('shutdown', () => { systemEnding = true })
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
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(() => { timedOut = true; resolve() }, 10_000)
    })
    pending = Promise.race([Promise.resolve().then(drain), timeout]).catch(() => failed()).finally(() => {
      clearTimeout(timer)
      if (complete) return
      complete = true
      if (timedOut) app.exit()
      else app.quit()
    })
  })
}
