interface QuitEvent { preventDefault(): void }
interface QuitApp { on(event: 'before-quit', listener: (event: QuitEvent) => void): unknown; quit(): void }
/** Electron must remain alive until accepted writes and owned child processes have settled. */
export function registerQuitDrain(app: QuitApp, drain: () => Promise<void>, failed: () => void): void {
  let pending: Promise<void> | undefined
  let complete = false
  app.on('before-quit', event => {
    if (complete) return
    event.preventDefault()
    pending ??= Promise.resolve().then(drain).catch(() => failed()).finally(() => { complete = true; app.quit() })
  })
}
