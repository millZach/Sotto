import { useEffect, useState } from 'react'
import type { TerminalViewFactory } from './terminalStore'

// xterm and its addons are a large module; they load the first time a terminal is on screen.
let loading: Promise<TerminalViewFactory> | undefined
export const loadXtermView = (): Promise<TerminalViewFactory> => loading ??= import('./terminalView').then(module => module.createXtermView)

/** The injected factory when a caller passes one (tests do), otherwise the xterm one once its chunk arrives. */
export function useTerminalViewFactory(override?: TerminalViewFactory): TerminalViewFactory | null {
  const [factory, setFactory] = useState<TerminalViewFactory | null>(() => override ?? null)
  useEffect(() => {
    if (override || factory) return
    let live = true
    void loadXtermView().then(loaded => { if (live) setFactory(() => loaded) })
    return () => { live = false }
  }, [override, factory])
  return override ?? factory
}
