import React, { useMemo, type ReactNode } from 'react'
import { Landmark, PanelBottom } from 'lucide-react'
import { useLingui } from '@lingui/react/macro'
import type { SottoPlatform } from '../../../shared/platform'
import { useOptionalApp } from '../state/AppContext'
import { chosenThreadChord } from '../agents/threadShortcuts'
import { paneTerminalChord, paneTerminalShortcutKeys, paneTerminalShortcutLabel, type PaneTerminalShortcut } from './paneTerminalShortcut'
import { useCouncilEnabled } from '../features/council/useCouncils'
import { paneTerminalChromeStore, shownView, usePaneTerminalChrome, type PaneTerminalChromeStore } from './paneTerminalStore'

/** The drawer's shortcut in this window, or null while the dictation hotkey owns the chord. */
export function usePaneTerminalShortcut(): PaneTerminalShortcut | null {
  const app = useOptionalApp()
  const platform: SottoPlatform = app?.platform ?? 'win32'
  const chord = paneTerminalChord(chosenThreadChord(app?.settings, 'terminal-drawer'), app?.settings?.hotkey, platform)
  return useMemo(() => chord === null ? null : { chord, platform, label: paneTerminalShortcutLabel(chord, platform), keys: paneTerminalShortcutKeys(chord, platform) }, [chord, platform])
}

/**
 * Shows or hides this pane's own terminal drawer, a symbol in the pane's header after Tools (ADR-0182), in every pane that
 * has a drawer. Its name stays put, "Terminal drawer" (Terminal alone is the Tools tab's), and aria-pressed says whether
 * the drawer shows its shells, so it never shares a name with the drawer's own Hide terminal button. While the drawer
 * shows the Council, a press brings the shells back rather than hiding it.
 */
export function PaneTerminalToggle({ threadId, store = paneTerminalChromeStore }: { readonly threadId: string; readonly store?: PaneTerminalChromeStore }): ReactNode {
  const { t } = useLingui()
  const chrome = usePaneTerminalChrome(threadId, store)
  const council = useCouncilEnabled()
  const shortcut = usePaneTerminalShortcut()
  const keys = shortcut?.label
  const shown = chrome.open && shownView(chrome, council) === 'terminal'
  const does = shown
    ? keys ? t`Hide terminal drawer (${keys})` : t`Hide terminal drawer`
    : keys ? t`Show terminal drawer (${keys})` : t`Show terminal drawer`
  return <button type="button" className="pane-action tt-focusable" data-pane-terminal-toggle aria-pressed={shown}
    aria-label={t`Terminal drawer`} aria-keyshortcuts={shortcut?.keys} title={does}
    onClick={() => store.toggle(threadId, 'terminal', council)}>
    <PanelBottom size={16} aria-hidden="true" /><span className="pane-action__word" aria-hidden="true">{t({ message: 'Terminal', comment: 'The pane header button that shows the terminal drawer under the thread.' })}</span>
  </button>
}

/**
 * Shows or hides the Council in this pane's drawer (ADR-0177; Owl only), a symbol in the pane's header right after Watch.
 * Pressed while the drawer shows the Council; while it shows the shells, a press brings the Council up in their place.
 */
export function PaneCouncilToggle(props: { readonly threadId: string; readonly store?: PaneTerminalChromeStore }): ReactNode {
  // Without the Council, a pane does not follow the drawer's state for a button it never draws.
  return useCouncilEnabled() ? <CouncilToggle {...props} /> : null
}

function CouncilToggle({ threadId, store = paneTerminalChromeStore }: { readonly threadId: string; readonly store?: PaneTerminalChromeStore }): ReactNode {
  const { t } = useLingui()
  const chrome = usePaneTerminalChrome(threadId, store)
  const shown = chrome.open && chrome.view === 'council'
  return <button type="button" className="pane-action tt-focusable" data-pane-council-toggle aria-pressed={shown}
    aria-label={t({ message: 'Council', comment: 'The pane header button that shows the Council in the drawer under the thread (ADR-0177).' })}
    title={shown ? t`Hide Council` : t`Show Council`} onClick={() => store.toggle(threadId, 'council', true)}>
    <Landmark size={16} aria-hidden="true" /><span className="pane-action__word" aria-hidden="true">{t({ message: 'Council', comment: 'The pane header button that shows the Council in the drawer under the thread (ADR-0177).' })}</span>
  </button>
}

/**
 * The same symbol on a thread on a paired host, whose terminal is on that machine (ADR-0049): greyed, and saying where
 * (ADR-0182). It stays reachable from the keyboard, as the Git action does while it is disabled, so the reason can be read.
 */
export function PaneTerminalOnHost({ host }: { readonly host: string | undefined }): ReactNode {
  const { t } = useLingui()
  const where = host === undefined
    ? t`This thread’s terminal is on the host machine. Open it there.`
    : t({ message: `This thread’s terminal is on ${host}. Open it there.`, comment: '{host} is the name of a paired host, as in forge.' })
  return <button type="button" className="pane-action tt-focusable" data-pane-terminal-toggle aria-disabled="true"
    aria-label={t`Terminal drawer`} aria-description={where} title={where}>
    <PanelBottom size={16} aria-hidden="true" /><span className="pane-action__word" aria-hidden="true">{t({ message: 'Terminal', comment: 'The pane header button that shows the terminal drawer under the thread.' })}</span>
  </button>
}
