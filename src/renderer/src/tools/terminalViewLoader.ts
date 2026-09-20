import { useEffect, useState } from 'react'
import type { TerminalViewFactory } from './terminalStore'

// xterm and its addons are a large module; they load the first time a terminal is on screen.
// Chromium caches failed module imports for this document, so recovery needs a window reload.
let loading: Promise<TerminalViewFactory> | undefined
export const loadXtermView = (): Promise<TerminalViewFactory> => loading ??= import('./terminalView')
  .then(module => module.createXtermView)

/**
 * The injected factory when a caller passes one (tests do), otherwise the xterm one once its chunk arrives.
 * Nothing loads while `enabled` is false, so a closed panel or an empty Terminal mode costs no chunk.
 */
export function useTerminalViewFactory(override?: TerminalViewFactory, enabled = true): { factory: TerminalViewFactory | null; failed: boolean } {
  const [factory, setFactory] = useState<TerminalViewFactory | null>(() => override ?? null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (override || factory || failed || !enabled) return
    let live = true
    void loadXtermView().then(loaded => { if (live) setFactory(() => loaded) }, () => { if (live) setFailed(true) })
    return () => { live = false }
  }, [override, factory, failed, enabled])
  return { factory: override ?? factory, failed: !override && failed }
}
