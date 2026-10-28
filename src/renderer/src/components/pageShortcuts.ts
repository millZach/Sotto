import { useEffect } from 'react'

import type { SottoPlatform } from '../../../shared/platform'
import { PAGE_SHORTCUT_IDS, type PageShortcutId } from '../../../shared/threadShortcuts'
import { claimedThreadChord, threadChordPressed, type ThreadShortcutSettings } from '../agents/threadShortcuts'
import type { AppNavigation } from '../state/AppContext'
import { useDictationOn } from '../state/dictationFeature'
import { useOwlFeature } from '../state/owlFeature'
import { useWatcherEnabled } from '../state/watcherFeature'
import { handRoomFocus, roomFor, type AppRoom } from './AppShell'

type ManagementNavigation = Exclude<AppNavigation, 'onboarding'>

/** Where each page shortcut goes, and the room it lights when the page is one of the switch's (ADR-0158). */
export const PAGE_SHORTCUT_PAGES: Readonly<Record<PageShortcutId, { readonly destination: ManagementNavigation; readonly room: AppRoom | null }>> = {
  'page-dictate': { destination: 'home', room: 'dictate' },
  'page-watcher': { destination: 'watcher', room: 'watcher' },
  'page-threads': { destination: 'threads', room: 'threads' },
  'page-usage': { destination: 'usage', room: null },
  'page-settings': { destination: 'settings', room: null },
}

/** Which pages are there to switch to: Watcher and Usage while their Owl features are on, Dictate while dictation is. */
export interface PageShortcutGates { readonly watcher: boolean; readonly usage: boolean; readonly dictation: boolean }

/** Whether a page shortcut has a page. One without keeps its saved keys, shows no row and answers nothing. */
export function pageShortcutShown(id: PageShortcutId, gates: PageShortcutGates): boolean {
  if (id === 'page-dictate') return gates.dictation
  if (id === 'page-watcher') return gates.watcher
  if (id === 'page-usage') return gates.usage
  return true
}

/** The gates read where a page shortcut is answered or listed. */
export function usePageShortcutGates(): PageShortcutGates {
  return { watcher: useWatcherEnabled(), usage: useOwlFeature('usage'), dictation: useDictationOn() }
}

export interface PageShortcutsInput {
  readonly settings: (ThreadShortcutSettings & { readonly onboardingComplete?: boolean }) | null | undefined
  readonly platform: SottoPlatform
  readonly navigation: AppNavigation
  readonly navigate: (destination: ManagementNavigation) => void
}

/**
 * The page shortcuts (ADR-0158): Ctrl+1 to Ctrl+5 (⌘ on a Mac) by default open Dictate, Watcher, Threads, Usage and
 * Settings while the window holds the keys, from any page once setup is finished. They keep every thread shortcut's
 * rules (`threadChordPressed`): standing down for dictation's keys, in a terminal and while a dialog is open. A press
 * opens the page as its room tab or page link does, so a room's lit tab takes focus as after a switch press.
 */
export function usePageShortcuts({ settings, platform, navigation, navigate }: PageShortcutsInput): void {
  const { watcher, usage, dictation } = usePageShortcutGates()
  useEffect(() => {
    if (settings?.onboardingComplete !== true || navigation === 'onboarding') return
    const gates = { watcher, usage, dictation }
    const chords = PAGE_SHORTCUT_IDS.map(id => pageShortcutShown(id, gates) ? claimedThreadChord(settings, id, platform) : null)
    if (chords.every(chord => chord === null)) return
    const onKey = (event: KeyboardEvent): void => {
      const index = chords.findIndex(chord => chord !== null && threadChordPressed(event, chord, platform))
      if (index < 0) return
      event.preventDefault()
      const { destination, room } = PAGE_SHORTCUT_PAGES[PAGE_SHORTCUT_IDS[index]!]
      if (room !== null && room !== roomFor(navigation)) handRoomFocus(room)
      navigate(destination)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settings, platform, navigation, navigate, watcher, usage, dictation])
}
