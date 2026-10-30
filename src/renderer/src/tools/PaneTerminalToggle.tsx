import React, { useMemo } from 'react'
import { PanelBottom } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import type { SottoPlatform } from '../../../shared/platform'
import type { PaneMenuItem } from '../agents/PaneMenu'
import { useOptionalApp } from '../state/AppContext'
import { chosenThreadChord } from '../agents/threadShortcuts'
import { paneTerminalChord, paneTerminalShortcutKeys, paneTerminalShortcutLabel, type PaneTerminalShortcut } from './paneTerminalShortcut'
import { paneTerminalChromeStore, usePaneTerminalChrome, type PaneTerminalChromeStore } from './paneTerminalStore'

/** The drawer's shortcut in this window, or null while the dictation hotkey owns the chord. */
export function usePaneTerminalShortcut(): PaneTerminalShortcut | null {
  const app = useOptionalApp()
  const platform: SottoPlatform = app?.platform ?? 'win32'
  const chord = paneTerminalChord(chosenThreadChord(app?.settings, 'terminal-drawer'), app?.settings?.hotkey, platform)
  return useMemo(() => chord === null ? null : { chord, platform, label: paneTerminalShortcutLabel(chord, platform), keys: paneTerminalShortcutKeys(chord, platform) }, [chord, platform])
}

/**
 * Shows or hides this pane's own terminal drawer, as a row of the pane's More menu (ADR-0163), in every pane that has
 * a drawer. Its name stays put, "Terminal drawer" (Terminal alone is the Tools tab's), and its tick says whether the
 * drawer is open, so it never shares a name with the drawer's own Hide terminal button. Its keys follow it.
 */
export function usePaneTerminalMenuItem(threadId: string, offered: boolean, store: PaneTerminalChromeStore = paneTerminalChromeStore): PaneMenuItem | null {
  const { t } = useLingui()
  const chrome = usePaneTerminalChrome(threadId, store)
  const shortcut = usePaneTerminalShortcut()
  if (!offered) return null
  return { id: 'terminal-drawer', label: t`Terminal drawer`, icon: <PanelBottom size={15} aria-hidden="true" />, shown: chrome.open,
    shortcut: shortcut ? { plain: shortcut.label, keys: shortcut.keys } : undefined, run: () => store.setOpen(threadId, !chrome.open) }
}
