import React, { useMemo, type ReactNode } from 'react'
import { PanelBottom } from 'lucide-react'
import type { SottoPlatform } from '../../../shared/platform'
import { useOptionalApp } from '../state/AppContext'
import { paneTerminalChord, paneTerminalShortcutKeys, paneTerminalShortcutLabel, type PaneTerminalShortcut } from './paneTerminalShortcut'
import { paneTerminalChromeStore, usePaneTerminalChrome, type PaneTerminalChromeStore } from './paneTerminalStore'

export interface PaneTerminalToggleProps {
  readonly threadId: string
  readonly store?: PaneTerminalChromeStore
}

/** The drawer's shortcut in this window, or null while the dictation hotkey owns the chord. */
export function usePaneTerminalShortcut(): PaneTerminalShortcut | null {
  const app = useOptionalApp()
  const platform: SottoPlatform = app?.platform ?? 'win32'
  const chord = paneTerminalChord(app?.settings?.hotkey, platform)
  return useMemo(() => chord === null ? null : { chord, platform, label: paneTerminalShortcutLabel(platform), keys: paneTerminalShortcutKeys(platform) }, [chord, platform])
}

/**
 * Shows or hides this pane's own terminal drawer. Every pane carries one, not only the focused one, just after
 * the Tools toggle, so the Tools toggle appearing in a pane as it takes focus never shifts this one. Like the
 * Tools toggle, its name stays put, "Terminal drawer" (Terminal alone is Terminal mode's), and aria-pressed says
 * whether the drawer is open, so it never shares a name with the drawer's own Hide terminal button.
 */
export function PaneTerminalToggle({ threadId, store = paneTerminalChromeStore }: PaneTerminalToggleProps): ReactNode {
  const chrome = usePaneTerminalChrome(threadId, store)
  const shortcut = usePaneTerminalShortcut()
  const does = chrome.open ? 'Hide terminal drawer' : 'Show terminal drawer'
  return <button type="button" className="pane-action tt-focusable" data-pane-terminal-toggle aria-pressed={chrome.open}
    aria-label="Terminal drawer" aria-keyshortcuts={shortcut?.keys} title={shortcut ? `${does} (${shortcut.label})` : does}
    onClick={() => store.setOpen(threadId, !chrome.open)}>
    <PanelBottom size={16} aria-hidden="true" />
  </button>
}
