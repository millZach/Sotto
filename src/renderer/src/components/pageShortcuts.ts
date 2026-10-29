import { useEffect, useMemo } from 'react'

import type { SottoPlatform } from '../../../shared/platform'
import { isPageShortcut, PAGE_SHORTCUT_IDS, THREAD_SHORTCUT_IDS, type PageShortcutId, type ThreadShortcutId } from '../../../shared/threadShortcuts'
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

/**
 * The shortcut whose saved keys this page shortcut meets, or null. Settings refuses a clash only among the rows it
 * shows, so two ways lead here: a thread shortcut saved on a digit before the page shortcuts took Ctrl+1 to Ctrl+5 as
 * defaults, and a page shortcut saved while another row's page was hidden (Dictate's, while dictation was off), met
 * when it comes back. A saved choice beats a default, and two saved page shortcuts on the same keys both stand down, each
 * row naming the other, rather than one quietly winning. A hidden page's saved keys hold nothing against a row on screen.
 */
export function pageChordHolder(settings: Pick<ThreadShortcutSettings, 'threadShortcuts'> | null | undefined, id: PageShortcutId, platform: SottoPlatform, gates: PageShortcutGates): ThreadShortcutId | null {
  const saved = settings?.threadShortcuts ?? {}
  const chord = chosenThreadChord(settings, id)
  if (chord === null) return null
  return THREAD_SHORTCUT_IDS.find(other => {
    if (other === id || isPageShortcut(other) && !pageShortcutShown(other, gates)) return false
    const held = saved[other]
    return typeof held === 'string' && sameThreadKeys(held, chord, platform)
  }) ?? null
}

/** The chord a page shortcut answers to: none for a page left out, a removed row, dictation's keys or a thread shortcut's. */
export function claimedPageChord(settings: ThreadShortcutSettings | null | undefined, id: PageShortcutId, platform: SottoPlatform, gates: PageShortcutGates): string | null {
  if (!pageShortcutShown(id, gates) || pageChordHolder(settings, id, platform, gates) !== null) return null
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
 * Where focus lands after a press, as a click on the page's own control leaves it: on the room's lit tab or the page's
 * link, where one is on screen, and otherwise on the page's main room (the sidebar folded to its rail, or Settings,
 * which draws no link to itself), so focus never falls to the document.
 */
function landFocus(destination: ManagementNavigation, room: AppRoom | null): void {
  const selector = room !== null ? `[role="tab"][data-room="${room}"][aria-selected="true"]` : `a[href="#${destination}"][aria-current="page"]`
  const control = [...document.querySelectorAll<HTMLElement>(selector)].find(element => element.checkVisibility?.() !== false)
  ;(control ?? document.getElementById('main-content'))?.focus({ preventScroll: true })
}

/**
 * Focus for a press. The page already open lands at once. Another room is handed focus for its switch to take as it
 * draws, as a switch press hands it; then, once the page has drawn, focus lands as above, unless the user has already
 * put it somewhere since.
 */
function focusAfterPress(destination: ManagementNavigation, room: AppRoom | null, open: boolean): void {
  if (open) { landFocus(destination, room); return }
  if (room !== null) handRoomFocus(room)
  const before = document.activeElement
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const active = document.activeElement
    const moved = active !== null && active !== document.body && active !== before && !(room !== null && active.matches(`[role="tab"][data-room="${room}"]`))
    if (!moved) landFocus(destination, room)
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
      navigate(destination)
      focusAfterPress(destination, room, navigation === destination)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [settings, platform, navigation, navigate, watcher, usage, dictation])
}
