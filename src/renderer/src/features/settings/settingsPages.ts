import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'

import { platformCopy } from '../../platformCopy'
import { inEnglish } from '../../state/interfaceLanguage'
import type { SottoPlatform } from '../../../../shared/platform'

/** A page in the rail. Its name is read in the interface language each time it is shown (ADR-0123). */
function settingsPage<Id extends string>(id: Id, label: MessageDescriptor | string, run: number): { readonly id: Id; readonly label: string; readonly run: number } {
  return { id, run, get label() { return typeof label === 'string' ? label : i18n._(label) } }
}

/**
 * Settings' pages, in the rail's order, and the run each sits in: a divider falls between runs. Zach's pick B from
 * docs/prototypes/settings-structure-prototype.html (October 22, 2026): fewer, longer pages, each a run of titled groups.
 */
export const SETTINGS_PAGES = [
  settingsPage('settings-capture', msg({ message: 'Dictation', comment: 'A Settings page, named in its rail and its heading. Other messages name it as "Settings > Dictation".' }), 0),
  settingsPage('settings-formatting', msg({ message: 'Cleanup', comment: 'A Settings page, named in its rail and its heading: AI cleanup of dictated text. Other messages name it as "Settings > Cleanup".' }), 0),
  settingsPage('settings-agents', msg({ message: 'Threads', comment: 'A Settings page, named in its rail and its heading: settings for threads. Other messages name it as "Settings > Threads".' }), 1),
  settingsPage('settings-git', msg({ message: 'Git & worktrees', comment: 'A Settings page, named in its rail and its heading. Other messages name it as "Settings > Git & worktrees".' }), 1),
  settingsPage('settings-watcher', 'Watcher', 1),
  settingsPage('settings-providers', msg({ message: 'Providers', comment: 'A Settings page, named in its rail and its heading. Other messages name it as "Settings > Providers".' }), 2),
  settingsPage('settings-hosts', msg({ message: 'Hosts & phones', comment: 'A Settings page, named in its rail and its heading. Other messages name it as "Settings > Hosts & phones".' }), 2),
  settingsPage('settings-cloud-iphone', msg({ message: 'Cloud iPhone', comment: 'A Settings page, named in its rail and its heading: a simulated iPhone on run.cloud. Other messages name it as "Settings > Cloud iPhone".' }), 2),
  settingsPage('settings-appearance', msg({ message: 'Appearance', comment: 'A Settings page, named in its rail and its heading. Other messages name it as "Settings > Appearance".' }), 3),
  settingsPage('settings-privacy', msg({ message: 'Application', comment: 'A Settings page, named in its rail and its heading: startup, history, updates and reset. Other messages name it as "Settings > Application".' }), 3),
  settingsPage('settings-performance', msg({ message: 'Performance', comment: 'A Settings page, named in its rail and its heading. Other messages name it as "Settings > Performance".' }), 3),
] as const

export type SettingsPageId = (typeof SETTINGS_PAGES)[number]['id']

/**
 * Groups worth a link of their own, by the id each had while it was a page or the id it has now. Each opens its page
 * and scrolls to the group; the group carries the id, so the old ids still name somewhere real.
 */
export const SETTINGS_GROUPS = {
  'settings-transcription': 'settings-capture',
  'settings-output': 'settings-capture',
  'settings-browser': 'settings-agents',
  'settings-worktrees': 'settings-git',
  'settings-phones': 'settings-hosts',
  'settings-history': 'settings-privacy',
  'settings-updates': 'settings-privacy',
} as const satisfies Record<string, SettingsPageId>

export type SettingsGroupId = keyof typeof SETTINGS_GROUPS
/** Anything that can be opened in Settings: a page, or a group on one. */
export type SettingsSectionId = SettingsPageId | SettingsGroupId

export function isSettingsSection(id: string): id is SettingsSectionId {
  return SETTINGS_PAGES.some(page => page.id === id) || Object.hasOwn(SETTINGS_GROUPS, id)
}

/** The page a section is on, and the group to scroll to when it is one. */
export function settingsSectionHome(id: SettingsSectionId): { readonly page: SettingsPageId; readonly group: SettingsGroupId | null } {
  return Object.hasOwn(SETTINGS_GROUPS, id)
    ? { page: SETTINGS_GROUPS[id as SettingsGroupId], group: id as SettingsGroupId }
    : { page: id as SettingsPageId, group: null }
}

/** What has to be on for a setting to show: dictation itself, or an Owl feature that holds it back. */
export type SettingGate = 'dictation' | 'dictation-off' | 'watcher' | 'worker-roles' | 'main-freeze' | 'resume-after-restart' | 'muse' | 'menu-bar-owl' | 'night-falls' | 'notifications' | 'creature-toggle' | 'cleanup-model'

export interface SettingEntry {
  /** The name Find a setting shows and matches, in the interface language. */
  readonly label: string
  /** Its name in English, which Find a setting matches in every language (ADR-0123). */
  readonly english: string
  /** Where it opens. */
  readonly section: SettingsSectionId
  /** The control's own name, where it differs from `label`. */
  readonly target?: string
  /**
   * More words that should find it, in English in every language. Its description on the page counts too
   * (`describeSetting`), in the language the page shows.
   */
  readonly words?: string
  /**
   * Where to land while the setting itself is not on the page, for a control that shows only in some states:
   * Custom instructions shows only while that style is chosen, Shell sandbox only while Muse is selected.
   */
  readonly fallback?: string
  readonly gate?: SettingGate
}

/** A name as the index is written: a message, or a name that is the same in every language. */
type SettingName = MessageDescriptor | string

interface SettingSpec {
  readonly label: SettingName
  readonly section: SettingsSectionId
  readonly target?: SettingName
  readonly words?: string
  readonly fallback?: SettingName
  readonly gate?: SettingGate
}

const shown = (name: SettingName): string => typeof name === 'string' ? name : i18n._(name)

/**
 * Every setting Find a setting can reach, and where each lives, named in the interface language: the names are the
 * page's own messages, so each still finds its control on a translated page. settingsReachable.test.tsx holds this
 * list to the page: each entry names a control on its page, and each control on a page has an entry.
 */
export function settingsIndex(platform: SottoPlatform): readonly SettingEntry[] {
  const copy = platformCopy(platform)
  const specs: readonly SettingSpec[] = [
    { label: msg`Dictate with Sotto`, section: 'settings-capture', words: 'turn dictation off', gate: 'dictation-off' },
    { label: msg`Microphone`, section: 'settings-capture', words: 'input device', gate: 'dictation' },
    { label: msg`Microphone test`, section: 'settings-capture', words: 'level hear', gate: 'dictation' },
    ...platform === 'linux'
      ? [{ label: msg`Omarchy setup`, section: 'settings-capture', words: 'shortcut keys bar theme', gate: 'dictation' } as const]
      : [{ label: msg`Dictation shortcuts`, section: 'settings-capture', target: msg`Press to start and stop`, words: 'hotkey keyboard hold', gate: 'dictation' } as const],
    { label: msg`Recording limit`, section: 'settings-capture', target: msg`Maximum recording time`, words: 'length seconds minutes', gate: 'dictation' },
    { label: msg`Sound cues`, section: 'settings-capture', words: 'audio beep', gate: 'dictation' },
    { label: msg`Typing speed`, section: 'settings-capture', words: 'words per minute time saved', gate: 'dictation' },
    { label: msg`Show floating widget when idle`, section: 'settings-capture', words: 'sliver', gate: 'dictation' },
    { label: msg`Speech model`, section: 'settings-transcription', words: 'transcription parakeet language', gate: 'dictation' },
    { label: msg`Whitespace formatting`, section: 'settings-transcription', words: 'spaces trim', gate: 'dictation' },
    { label: msg`Automatic clipboard copy`, section: 'settings-output', words: 'output', gate: 'dictation' },
    { label: msg`Automatic paste`, section: 'settings-output', words: 'output', gate: 'dictation' },
    { label: msg`Paste delay`, section: 'settings-output', words: 'milliseconds', gate: 'dictation' },
    { label: msg`Success message duration`, section: 'settings-output', words: 'milliseconds', gate: 'dictation' },
    { label: msg`AI formatting`, section: 'settings-formatting', words: 'cleanup openrouter', gate: 'dictation' },
    { label: msg`OpenRouter key`, section: 'settings-formatting', target: msg`OpenRouter API key`, words: 'api key cleanup', gate: 'dictation' },
    { label: msg`Cleanup model`, section: 'settings-formatting', words: 'openrouter ai formatting llm', gate: 'cleanup-model' },
    { label: msg`Cleanup mode`, section: 'settings-formatting', target: msg({ message: 'Mode', comment: 'The label of the cleanup mode choice on Settings > Cleanup: which OpenRouter host serves the cleanup model.' }), words: 'openrouter nitro floor fastest cheapest host', gate: 'cleanup-model' },
    { label: msg`Personal dictionary`, section: 'settings-formatting', words: 'vocabulary words names spelling', gate: 'dictation' },

    { label: msg`New threads start with`, section: 'settings-agents', words: 'model reasoning effort permissions defaults' },
    { label: msg`Default projects directory`, section: 'settings-agents', words: 'folder' },
    { label: msg`New threads work in`, section: 'settings-agents', words: 'working copy worktree project folder' },
    { label: msg`Project defaults`, section: 'settings-agents', words: 'working copy worktree' },
    { label: msg`Replies in threads`, section: 'settings-agents', words: 'streaming as written' },
    { label: msg`Generated thread titles`, section: 'settings-agents', words: 'names branch' },
    { label: msg`Resume threads after a restart`, section: 'settings-agents', gate: 'resume-after-restart' },
    { label: msg`Web links in threads`, section: 'settings-browser', words: 'open links browser' },
    { label: msg`Show the browser when an agent opens a page`, section: 'settings-browser', words: 'test iphone' },
    { label: msg`Let agents use the browser without asking`, section: 'settings-browser', words: 'permission' },
    { label: msg`Let agents draw visuals in threads`, section: 'settings-browser', words: 'diagrams' },

    { label: msg`Remove idle worktrees after`, section: 'settings-worktrees', words: 'cleanup days' },
    { label: msg`Remove a worktree when its thread is settled`, section: 'settings-worktrees', words: 'cleanup' },
    { label: msg`Remove a worktree once its commits are in the default branch`, section: 'settings-worktrees', words: 'cleanup' },
    { label: msg`Remove a worktree when its pull request is merged`, section: 'settings-worktrees', words: 'cleanup' },
    { label: msg`Commit and pull request style`, section: 'settings-git', words: 'writing conventional' },
    { label: msg`Custom instructions`, section: 'settings-git', words: 'commit pull request writing style', fallback: msg`Commit and pull request style` },
    { label: msg`Generated commit messages`, section: 'settings-git' },
    { label: msg`Generated pull request text`, section: 'settings-git', words: 'title body' },
    { label: msg`Follow pull request templates`, section: 'settings-git' },
    { label: msg`Default merge method`, section: 'settings-git', words: 'squash rebase' },
    { label: msg`Auto-settle merged threads`, section: 'settings-git' },
    { label: msg`Let agents babysit pull requests`, section: 'settings-git', words: 'checks wake' },
    { label: msg`Diff layout`, section: 'settings-git', words: 'changes stacked split' },
    { label: msg`Hide whitespace changes`, section: 'settings-git', words: 'diff' },
    { label: msg`Default diff file state`, section: 'settings-git', words: 'expanded collapsed' },
    { label: msg`Proactive panels`, section: 'settings-git', words: 'changes' },
    { label: msg`Git fetch interval`, section: 'settings-git', words: 'background' },
    { label: msg`Automatically pull`, section: 'settings-git', words: 'fetch' },

    { label: msg`Settle finished threads`, section: 'settings-watcher', gate: 'watcher' },
    { label: msg`Worker roles`, section: 'settings-watcher', words: 'model building research review', gate: 'worker-roles' },

    { label: msg`Thread providers`, section: 'settings-providers', words: 'claude codex grok devin connect sign in accounts' },
    { label: msg`Check for client updates`, section: 'settings-providers', words: 'agent clients' },
    { label: msg`Shell sandbox`, section: 'settings-providers', words: 'muse', fallback: msg`Thread providers`, gate: 'muse' },
    { label: msg`Run the local host`, section: 'settings-hosts', words: 'this computer' },
    { label: msg`Remote hosts`, section: 'settings-hosts', words: 'ssh tailscale add host computers' },
    { label: msg`Let phones connect`, section: 'settings-phones', words: 'iphone' },
    { label: msg`Name on phones`, section: 'settings-phones', words: 'iphone' },
    { label: msg`Pairing code`, section: 'settings-phones', target: msg`Phones`, words: 'pair iphone' },
    { label: msg`run.cloud key`, section: 'settings-cloud-iphone', target: msg({ message: 'Key', comment: 'The label of the run.cloud API key field on Settings > Cloud iPhone.' }), words: 'cloud iphone' },
    { label: msg`Monthly cap`, section: 'settings-cloud-iphone', words: 'minutes spending cloud iphone' },
    { label: msg`Idle sessions end after`, section: 'settings-cloud-iphone', words: 'cloud iphone' },

    { label: msg`Themes`, section: 'settings-appearance', words: 'color colour look' },
    { label: msg`Color scheme`, section: 'settings-appearance', words: 'dark light' },
    { label: msg`Effort color`, section: 'settings-appearance' },
    { label: msg`Show the creature`, section: 'settings-appearance', words: 'hide off composer', gate: 'creature-toggle' },
    { label: msg`Creature`, section: 'settings-appearance', words: 'claude bot sotto composer' },
    // The menu bar owl is a Mac's alone (ADR-0114).
    ...platform === 'darwin' ? [{ label: msg`Menu bar owl`, section: 'settings-appearance', words: 'tray icon body eyes colour color', gate: 'menu-bar-owl' } as const] : [],
    { label: msg`Contrast`, section: 'settings-appearance' },
    { label: msg`Reduced motion`, section: 'settings-appearance', words: 'animation' },
    { label: msg`Night falls between Threads and Watcher`, section: 'settings-appearance', words: 'transition animation watcher room', gate: 'night-falls' },
    { label: msg`Night falls speed`, section: 'settings-appearance', words: 'transition animation slower faster', gate: 'night-falls' },
    { label: copy.settingsLaunchAtStartupLabel, section: 'settings-privacy', words: 'startup login' },
    { label: msg`Start minimized`, section: 'settings-privacy', words: 'startup tray' },
    { label: msg`Keep local history`, section: 'settings-history', words: 'transcripts privacy' },
    { label: msg`History retention`, section: 'settings-history', words: 'transcripts' },
    { label: msg`Clear transcript history`, section: 'settings-history', words: 'delete' },
    // Only where the window can show notifications: on a Mac (ADR-0117).
    { label: msg`When a thread needs you`, section: 'settings-privacy', words: 'notifications notify question permission', gate: 'notifications' },
    { label: msg`When a thread has finished everything`, section: 'settings-privacy', words: 'notifications notify done', gate: 'notifications' },
    { label: msg`Send a test notification`, section: 'settings-privacy', words: 'notifications', gate: 'notifications' },
    { label: msg`Updates`, section: 'settings-updates', words: 'version check now download' },
    // Where Sotto never updates itself (Linux), the Updates group says how to update by hand and has no switch.
    ...copy.settingsUpdatesByHand === null ? [{ label: msg`Check for updates automatically`, section: 'settings-updates' } as const] : [],
    { label: msg`Reset settings`, section: 'settings-privacy', words: 'defaults setup' },

    { label: msg`Tell me when main freezes`, section: 'settings-performance', gate: 'main-freeze' },
  ]
  return specs.map(({ label, target, fallback, ...spec }) => ({
    ...spec,
    label: shown(label),
    english: typeof label === 'string' ? label : inEnglish(label),
    ...target === undefined ? {} : { target: shown(target) },
    ...fallback === undefined ? {} : { fallback: shown(fallback) },
  }))
}

/**
 * The entries whose name or extra words hold every word typed, best first: names that start with the text lead. A
 * setting is found by its name as shown and by its English name, so English still finds it in any language.
 */
export function findSettings(index: readonly SettingEntry[], query: string): readonly SettingEntry[] {
  const words = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean)
  if (words.length === 0) return []
  const text = query.trim().toLocaleLowerCase()
  const namesOf = (entry: SettingEntry): string[] => [entry.label.toLocaleLowerCase(), entry.english.toLocaleLowerCase()]
  return index
    .filter(entry => { const haystack = `${entry.label} ${entry.english} ${entry.words ?? ''}`.toLocaleLowerCase(); return words.every(word => haystack.includes(word)) })
    .map((entry, order) => ({ entry, order, rank: namesOf(entry).some(name => name.startsWith(text)) ? 0 : namesOf(entry).some(name => name.includes(text)) ? 1 : 2 }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ entry }) => entry)
}

/**
 * The control a setting's name points at inside `root`: a control named by `aria-label`, a field's `<label>`, a group
 * named by its heading or legend, or the heading itself. Null when the page does not show it.
 */
export function findSettingControl(root: HTMLElement, name: string): HTMLElement | null {
  const same = (text: string | null | undefined): boolean => (text ?? '').replace(/\s+/gu, ' ').trim() === name
  const labelled = [...root.querySelectorAll<HTMLElement>('[aria-label]')].find(element => same(element.getAttribute('aria-label')))
  if (labelled) return labelled
  for (const label of root.querySelectorAll<HTMLLabelElement>('label')) {
    if (!same(label.textContent) && !same(label.firstChild?.textContent)) continue
    const control = label.htmlFor ? root.ownerDocument.getElementById(label.htmlFor) : label.querySelector<HTMLElement>('input, select, textarea')
    if (control) return control
  }
  for (const legend of root.querySelectorAll<HTMLElement>('legend')) if (same(legend.textContent) && legend.parentElement) return legend.parentElement
  // A group named by another element, such as a run of dictation shortcuts under its own label.
  for (const group of root.querySelectorAll<HTMLElement>('[role="group"][aria-labelledby], [role="radiogroup"][aria-labelledby]')) {
    const ids = group.getAttribute('aria-labelledby')!.split(/\s+/u)
    if (same(ids.map(id => root.ownerDocument.getElementById(id)?.textContent ?? '').join(' '))) return group
  }
  for (const button of root.querySelectorAll<HTMLElement>('button')) if (same(button.textContent)) return button
  for (const heading of root.querySelectorAll<HTMLElement>('h2, h3, h4')) {
    if (!same(heading.textContent)) continue
    const group = heading.id ? root.querySelector<HTMLElement>(`[aria-labelledby~="${CSS.escape(heading.id)}"]`) : null
    if (group) return group
    // A heading that names a row, such as Clear transcript history or Remote hosts: the row's own button.
    for (let row = heading.parentElement, step = 0; row && row !== root && step < 2; row = row.parentElement, step++) {
      const control = row.querySelector<HTMLElement>(FOCUSABLE)
      if (control) return control
    }
    return heading
  }
  // A control named for one of several computers, such as Default projects directory on forge: the first of them.
  return [...root.querySelectorAll<HTMLElement>('[aria-label]')].find(element => (element.getAttribute('aria-label') ?? '').startsWith(`${name} on `)) ?? null
}

/**
 * What the page says about a setting, so Find a setting matches its description as well as its name: the text the
 * control is described by, or else its whole row, as for Clear transcript history and Reset settings.
 */
export function describeSetting(control: HTMLElement): string {
  const ids = control.getAttribute('aria-describedby')?.split(/\s+/u) ?? []
  if (ids.length > 0) return ids.map(id => control.ownerDocument.getElementById(id)?.textContent ?? '').join(' ')
  let row: HTMLElement | null = control
  while (row && !row.parentElement?.classList.contains('settings-rows')) row = row.parentElement
  return row?.textContent ?? ''
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Brings a setting's control into view and puts focus on it, or on the first control in its group. */
export function revealSetting(control: HTMLElement): void {
  const focusable = control.matches(FOCUSABLE) ? control
    : control.getAttribute('role') === 'radiogroup' ? control.querySelector<HTMLElement>('[aria-checked="true"]') ?? control.querySelector<HTMLElement>(FOCUSABLE)
    : control.querySelector<HTMLElement>(FOCUSABLE)
  const target = focusable ?? control
  if (target === control && !control.matches(FOCUSABLE)) control.tabIndex = -1
  target.scrollIntoView?.({ block: 'center' })
  target.focus({ preventScroll: true })
}
