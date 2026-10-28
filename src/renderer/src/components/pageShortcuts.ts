import { useEffect, useMemo } from 'react'

import type { SottoPlatform } from '../../../shared/platform'
import { PAGE_SHORTCUT_IDS, THREAD_SHORTCUT_IDS, type PageShortcutId, type ThreadShortcutId } from '../../../shared/threadShortcuts'
import { chosenThreadChord, claimedThreadChord, sameThreadKeys, threadChordLabel, threadChordPressed, type ThreadChordLabel, type ThreadShortcutSettings } from '../agents/threadShortcuts'
import { useOptionalApp, type AppNavigation } from '../state/AppContext'
import { useDictationOn } from '../state/dictationFeature'
import { useOwlFeature } from '../state/owlFeature'
import { useWatcherEnabled } from '../state/watcherFeature'
import { handRoomFocus, type AppRoom } from './AppShell'

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

const isPageShortcut = (id: ThreadShortcutId): id is PageShortcutId => (PAGE_SHORTCUT_IDS as readonly string[]).includes(id)

/**
 * The thread shortcut the user set to the same keys as this page shortcut, or null. Digits were already allowed on
 * thread shortcuts before the page shortcuts took Ctrl+1 to Ctrl+5 as defaults, and a saved choice beats a new default:
 * the page shortcut at its default stands down until one of the two moves. Settings refuses a new clash, so only a
 * page shortcut's default can meet a saved thread shortcut.
 */
export function pageChordHolder(settings: Pick<ThreadShortcutSettings, 'threadShortcuts'> | null | undefined, id: PageShortcutId, platform: SottoPlatform): ThreadShortcutId | null {
  const saved = settings?.threadShortcuts ?? {}
  const chord = chosenThreadChord(settings, id)
  if (chord === null || Object.hasOwn(saved, id)) return null
  return THREAD_SHORTCUT_IDS.find(other => {
    const held = saved[other]
    return !isPageShortcut(other) && typeof held === 'string' && sameThreadKeys(held, chord, platform)
  }) ?? null
}

/** The chord a page shortcut answers to: none for a page left out, a removed row, dictation's keys or a thread shortcut's. */
export function claimedPageChord(settings: ThreadShortcutSettings | null | undefined, id: PageShortcutId, platform: SottoPlatform, gates: PageShortcutGates): string | null {
  if (!pageShortcutShown(id, gates) || pageChordHolder(settings, id, platform) !== null) return null
  return claimedThreadChord(settings, id, platform)
}

/**
 * Each page shortcut's chord in a control's words, for the room tabs and page links that open the same pages: their
 * title and `aria-keyshortcuts` follow the saved choice (ADR-0133 decision 2). None before settings load.
 */
export function usePageShortcutLabels(): Partial<Record<PageShortcutId, ThreadChordLabel>> {
  const app = useOptionalApp()
  const { watcher, usage, dictation } = usePageShortcutGates()
  const settings = app?.settings
  const platform = app?.platform ?? 'win32'
  return useMemo(() => {
    if (!settings) return {}
    const labels: Partial<Record<PageShortcutId, ThreadChordLabel>> = {}
    for (const id of PAGE_SHORTCUT_IDS) {
      const chord = claimedPageChord(settings, id, platform, { watcher, usage, dictation })
      if (chord !== null) labels[id] = threadChordLabel(chord, platform)
    }
    return labels
  }, [settings, platform, watcher, usage, dictation])
}

/** The page shortcut that opens a destination the room switch or a page link opens, if any. */
export function pageShortcutFor(destination: ManagementNavigation): PageShortcutId | undefined {
  return PAGE_SHORTCUT_IDS.find(id => PAGE_SHORTCUT_PAGES[id].destination === destination)
}

/**
 * Focus for a room a press opened. A room already open takes it on its lit tab at once, as a click on that tab does;
 * another is handed it, for its page's switch to take once drawn. Where no switch on screen takes it (the sidebar
 * folded to its rail), the page's main room does, so focus never falls to nowhere.
 */
function focusRoom(room: AppRoom, open: boolean): void {
  const litTab = (): HTMLElement | undefined => [...document.querySelectorAll<HTMLElement>(`[role="tab"][data-room="${room}"][aria-selected="true"]`)]
    .find(tab => tab.checkVisibility?.() !== false)
  if (open) { litTab()?.focus(); return }
  handRoomFocus(room)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (document.activeElement !== null && document.activeElement !== document.body) return
    const main = document.getElementById('main-content')
    main?.focus({ preventScroll: true })
  }))
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
 * rules (`threadChordPressed`): standing down for dictation's keys, in a terminal and while a dialog is open, and for a
 * thread shortcut saved on the same keys (`pageChordHolder`). A press opens the page as its room tab or page link does,
 * and a room's lit tab takes focus as a click on it would (`focusRoom`).
 */
export function usePageShortcuts({ settings, platform, navigation, navigate }: PageShortcutsInput): void {
  const { watcher, usage, dictation } = usePageShortcutGates()
  useEffect(() => {
    if (settings?.onboardingComplete !== true || navigation === 'onboarding') return
    const gates = { watcher, usage, dictation }
    const chords = PAGE_SHORTCUT_IDS.map(id => claimedPageChord(settings, id, platform, gates))
    if (chords.every(chord => chord === null)) return
    const onKey = (event: KeyboardEvent): void => {
      const index = chords.findIndex(chord => chord !== null && threadChordPressed(event, chord, platform))
      if (index < 0) return
      event.preventDefault()
      const { destination, room } = PAGE_SHORTCUT_PAGES[PAGE_SHORTCUT_IDS[index]!]
      if (room !== null) focusRoom(room, navigation === destination)
      navigate(destination)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settings, platform, navigation, navigate, watcher, usage, dictation])
}
