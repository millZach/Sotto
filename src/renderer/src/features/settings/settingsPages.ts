import { platformCopy } from '../../platformCopy'
import type { SottoPlatform } from '../../../../shared/platform'

/**
 * Settings' pages, in the rail's order, and the run each sits in: a divider falls between runs. Zach's pick B from
 * docs/prototypes/settings-structure-prototype.html (October 22, 2026): fewer, longer pages, each a run of titled groups.
 */
export const SETTINGS_PAGES = [
  { id: 'settings-capture', label: 'Dictation', run: 0 },
  { id: 'settings-formatting', label: 'Cleanup', run: 0 },
  { id: 'settings-agents', label: 'Threads', run: 1 },
  { id: 'settings-git', label: 'Git & worktrees', run: 1 },
  { id: 'settings-watcher', label: 'Watcher', run: 1 },
  { id: 'settings-providers', label: 'Providers', run: 2 },
  { id: 'settings-hosts', label: 'Hosts & phones', run: 2 },
  { id: 'settings-cloud-iphone', label: 'Cloud iPhone', run: 2 },
  { id: 'settings-appearance', label: 'Appearance', run: 3 },
  { id: 'settings-privacy', label: 'Application', run: 3 },
  { id: 'settings-performance', label: 'Performance', run: 3 },
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
export type SettingGate = 'dictation' | 'dictation-off' | 'watcher' | 'worker-roles' | 'main-freeze' | 'resume-after-restart' | 'muse'

export interface SettingEntry {
  /** The name Find a setting shows and matches. */
  readonly label: string
  /** Where it opens. */
  readonly section: SettingsSectionId
  /** The control's own name, where it differs from `label`. */
  readonly target?: string
  /** More words that should find it. Its description on the page counts too (`describeSetting`). */
  readonly words?: string
  /**
   * Where to land while the setting itself is not on the page, for a control that shows only in some states:
   * Custom instructions shows only while that style is chosen, Shell sandbox only while Muse is selected.
   */
  readonly fallback?: string
  readonly gate?: SettingGate
}

/**
 * Every setting Find a setting can reach, and where each lives. settingsReachable.test.tsx holds this list to the page:
 * each entry names a control on its page, and each control on a page has an entry.
 */
export function settingsIndex(platform: SottoPlatform): readonly SettingEntry[] {
  const copy = platformCopy(platform)
  return [
    { label: 'Dictate with Sotto', section: 'settings-capture', words: 'turn dictation off', gate: 'dictation-off' },
    { label: 'Microphone', section: 'settings-capture', words: 'input device', gate: 'dictation' },
    { label: 'Microphone test', section: 'settings-capture', words: 'level hear', gate: 'dictation' },
    ...platform === 'linux'
      ? [{ label: 'Omarchy setup', section: 'settings-capture', words: 'shortcut keys bar theme', gate: 'dictation' } as const]
      : [{ label: 'Dictation shortcuts', section: 'settings-capture', target: 'Press to start and stop', words: 'hotkey keyboard hold', gate: 'dictation' } as const],
    { label: 'Recording limit', section: 'settings-capture', target: 'Maximum recording time', words: 'length seconds minutes', gate: 'dictation' },
    { label: 'Sound cues', section: 'settings-capture', words: 'audio beep', gate: 'dictation' },
    { label: 'Typing speed', section: 'settings-capture', words: 'words per minute time saved', gate: 'dictation' },
    { label: 'Show floating widget when idle', section: 'settings-capture', words: 'sliver', gate: 'dictation' },
    { label: 'Speech model', section: 'settings-transcription', words: 'transcription parakeet language', gate: 'dictation' },
    { label: 'Whitespace formatting', section: 'settings-transcription', words: 'spaces trim', gate: 'dictation' },
    { label: 'Automatic clipboard copy', section: 'settings-output', words: 'output', gate: 'dictation' },
    { label: 'Automatic paste', section: 'settings-output', words: 'output', gate: 'dictation' },
    { label: 'Paste delay', section: 'settings-output', words: 'milliseconds', gate: 'dictation' },
    { label: 'Success message duration', section: 'settings-output', words: 'milliseconds', gate: 'dictation' },
    { label: 'AI formatting', section: 'settings-formatting', words: 'cleanup openrouter', gate: 'dictation' },
    { label: 'OpenRouter key', section: 'settings-formatting', target: 'OpenRouter API key', words: 'api key cleanup', gate: 'dictation' },
    { label: 'Personal dictionary', section: 'settings-formatting', words: 'vocabulary words names spelling', gate: 'dictation' },

    { label: 'New threads start with', section: 'settings-agents', words: 'model reasoning effort permissions defaults' },
    { label: 'Default projects directory', section: 'settings-agents', words: 'folder' },
    { label: 'New threads work in', section: 'settings-agents', words: 'working copy worktree project folder' },
    { label: 'Project defaults', section: 'settings-agents', words: 'working copy worktree' },
    { label: 'Replies in threads', section: 'settings-agents', words: 'streaming as written' },
    { label: 'Generated thread titles', section: 'settings-agents', words: 'names branch' },
    { label: 'Resume threads after a restart', section: 'settings-agents', gate: 'resume-after-restart' },
    { label: 'Web links in threads', section: 'settings-browser', words: 'open links browser' },
    { label: 'Show the browser when an agent opens a page', section: 'settings-browser', words: 'test iphone' },
    { label: 'Let agents use the browser without asking', section: 'settings-browser', words: 'permission' },
    { label: 'Let agents draw visuals in threads', section: 'settings-browser', words: 'diagrams' },

    { label: 'Remove idle worktrees after', section: 'settings-worktrees', words: 'cleanup days' },
    { label: 'Remove a worktree when its thread is settled', section: 'settings-worktrees', words: 'cleanup' },
    { label: 'Remove a worktree once its commits are in the default branch', section: 'settings-worktrees', words: 'cleanup' },
    { label: 'Remove a worktree when its pull request is merged', section: 'settings-worktrees', words: 'cleanup' },
    { label: 'Commit and pull request style', section: 'settings-git', words: 'writing conventional' },
    { label: 'Custom instructions', section: 'settings-git', words: 'commit pull request writing style', fallback: 'Commit and pull request style' },
    { label: 'Generated commit messages', section: 'settings-git' },
    { label: 'Generated pull request text', section: 'settings-git', words: 'title body' },
    { label: 'Follow pull request templates', section: 'settings-git' },
    { label: 'Default merge method', section: 'settings-git', words: 'squash rebase' },
    { label: 'Auto-settle merged threads', section: 'settings-git' },
    { label: 'Let agents babysit pull requests', section: 'settings-git', words: 'checks wake' },
    { label: 'Diff layout', section: 'settings-git', words: 'changes stacked split' },
    { label: 'Hide whitespace changes', section: 'settings-git', words: 'diff' },
    { label: 'Default diff file state', section: 'settings-git', words: 'expanded collapsed' },
    { label: 'Proactive panels', section: 'settings-git', words: 'changes' },
    { label: 'Git fetch interval', section: 'settings-git', words: 'background' },
    { label: 'Automatically pull', section: 'settings-git', words: 'fetch' },

    { label: 'Settle finished threads', section: 'settings-watcher', gate: 'watcher' },
    { label: 'Worker roles', section: 'settings-watcher', words: 'model building research review', gate: 'worker-roles' },

    { label: 'Thread providers', section: 'settings-providers', words: 'claude codex grok devin connect sign in accounts' },
    { label: 'Check for client updates', section: 'settings-providers', words: 'agent clients' },
    { label: 'Shell sandbox', section: 'settings-providers', words: 'muse', fallback: 'Thread providers', gate: 'muse' },
    { label: 'Run the local host', section: 'settings-hosts', words: 'this computer' },
    { label: 'Remote hosts', section: 'settings-hosts', words: 'ssh tailscale add host computers' },
    { label: 'Let phones connect', section: 'settings-phones', words: 'iphone' },
    { label: 'Name on phones', section: 'settings-phones', words: 'iphone' },
    { label: 'Pairing code', section: 'settings-phones', target: 'Phones', words: 'pair iphone' },
    { label: 'run.cloud key', section: 'settings-cloud-iphone', target: 'Key', words: 'cloud iphone' },
    { label: 'Monthly cap', section: 'settings-cloud-iphone', words: 'minutes spending cloud iphone' },
    { label: 'Idle sessions end after', section: 'settings-cloud-iphone', words: 'cloud iphone' },

    { label: 'Themes', section: 'settings-appearance', words: 'color colour look' },
    { label: 'Color scheme', section: 'settings-appearance', words: 'dark light' },
    { label: 'Effort color', section: 'settings-appearance' },
    { label: 'Creature', section: 'settings-appearance', words: 'claude bot sotto composer' },
    { label: 'Contrast', section: 'settings-appearance' },
    { label: 'Reduced motion', section: 'settings-appearance', words: 'animation' },
    { label: copy.settingsLaunchAtStartupLabel, section: 'settings-privacy', words: 'startup login' },
    { label: 'Start minimized', section: 'settings-privacy', words: 'startup tray' },
    { label: 'Keep local history', section: 'settings-history', words: 'transcripts privacy' },
    { label: 'History retention', section: 'settings-history', words: 'transcripts' },
    { label: 'Clear transcript history', section: 'settings-history', words: 'delete' },
    { label: 'Updates', section: 'settings-updates', words: 'version check now download' },
    // Where Sotto never updates itself (Linux), the Updates group says how to update by hand and has no switch.
    ...copy.settingsUpdatesByHand === null ? [{ label: 'Check for updates automatically', section: 'settings-updates' } as const] : [],
    { label: 'Reset settings', section: 'settings-privacy', words: 'defaults setup' },

    { label: 'Tell me when main freezes', section: 'settings-performance', gate: 'main-freeze' },
  ]
}

/** The entries whose name or extra words hold every word typed, best first: names that start with the text lead. */
export function findSettings(index: readonly SettingEntry[], query: string): readonly SettingEntry[] {
  const words = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean)
  if (words.length === 0) return []
  const text = query.trim().toLocaleLowerCase()
  return index
    .filter(entry => { const haystack = `${entry.label} ${entry.words ?? ''}`.toLocaleLowerCase(); return words.every(word => haystack.includes(word)) })
    .map((entry, order) => ({ entry, order, rank: entry.label.toLocaleLowerCase().startsWith(text) ? 0 : entry.label.toLocaleLowerCase().includes(text) ? 1 : 2 }))
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
