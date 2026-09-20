import { useEffect, useState } from 'react'
import type { TerminalViewFactory } from './terminalStore'

// xterm and its addons are a large module; they load the first time a terminal is on screen.
// A rejected import clears the cache so a later mount tries again rather than holding the failure.
let loading: Promise<TerminalViewFactory> | undefined
export const loadXtermView = (): Promise<TerminalViewFactory> => loading ??= import('./terminalView')
  .then(module => module.createXtermView, error => { loading = undefined; throw error })

/**
 * The injected factory when a caller passes one (tests do), otherwise the xterm one once its chunk arrives.
 * Nothing loads while `enabled` is false, so a closed panel or an empty Terminal mode costs no chunk.
 */
export function useTerminalViewFactory(override?: TerminalViewFactory, enabled = true): TerminalViewFactory | null {
  const [factory, setFactory] = useState<TerminalViewFactory | null>(() => override ?? null)
  // Runs after every render: while the chunk loads the cached promise is reused, and after a failed
  // load the next render (a retry, a pane change) asks again. A failure leaves the frame empty and busy.
  useEffect(() => {
    if (override || factory || !enabled) return
    let live = true
    void loadXtermView().then(loaded => { if (live) setFactory(() => loaded) }, () => undefined)
    return () => { live = false }
  })
  return override ?? factory
}
