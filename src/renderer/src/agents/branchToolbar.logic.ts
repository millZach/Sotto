import type { MessageDescriptor } from '@lingui/core'
import { msg, ph, t } from '@lingui/core/macro'

import type { AgentThread } from '../../../shared/agents'
import type { GitPullRequestSummary } from '../../../shared/gitStatus'
import type { GitRef } from '../../../shared/gitRefs'
import type { SottoPlatform } from '../../../shared/platform'
import { leftToRight, type LaterWords } from './interfaceWords'

/** The thread fields the toolbar reads; a full record satisfies it, and tests can pass less. */
export type ToolbarThread = Pick<AgentThread, 'id' | 'projectId' | 'nativeSessionStarted' | 'worktree' | 'messages' | 'remoteHost' | 'hostLabel' | 'updatedAt' | 'summary'>

/** The toolbar's shortcut rows on Settings › Keyboard (ADR-0133); their chords are the user's, in `threadShortcuts.ts`. Run on is static text here, so it claims none. */
export const TOOLBAR_SHORTCUTS = { branch: 'branch', workspace: 'working-copy', previous: 'previous-working-copy' } as const
export type ToolbarShortcut = keyof typeof TOOLBAR_SHORTCUTS

/**
 * Whether the toolbar has anything to say: the folder is a Git repository by the host's last reading, or the
 * thread is a draft that will get a worktree of its own, which only a repository can give it.
 */
export function toolbarApplies(thread: ToolbarThread): boolean {
  const worktree = thread.worktree
  if (!worktree) return false
  if (worktree.git?.isRepository === true) return true
  return worktree.mode === 'independent' && !worktree.path && worktree.status !== 'error'
}

/** Workspace and Run on lock to static text once the thread has a message or a session, or its worktree exists. */
export function workspaceLocked(thread: ToolbarThread): boolean {
  if (thread.nativeSessionStarted !== false) return true
  if (thread.messages.length > 0) return true
  return thread.worktree?.mode === 'independent' && Boolean(thread.worktree.path)
}

/** A draft that will make a worktree of its own on first send: no folder yet, and no worktree it points at. */
export function newWorktreeDraft(thread: ToolbarThread): boolean {
  const worktree = thread.worktree
  return worktree?.mode === 'independent' && !worktree.path && !worktree.existingWorktreePath
}
/** A draft pointed at a worktree that exists already; its branch is that worktree's until the thread starts. */
export function previousWorktreeDraft(thread: ToolbarThread): boolean {
  const worktree = thread.worktree
  return worktree?.mode === 'independent' && !worktree.path && Boolean(worktree.existingWorktreePath)
}

export type WorkspaceChoice = { readonly kind: 'current' } | { readonly kind: 'new' } | { readonly kind: 'previous'; readonly path: string }
export interface WorkspaceOption { readonly id: string; readonly label: string; readonly name?: string; readonly choice: WorkspaceChoice }

/** One spelling for a folder, so a path Git wrote with slashes matches the one the record keeps with backslashes. */
export const folderKey = (path: string): string => path.replace(/[\\/]+$/u, '').replace(/\\/gu, '/').toLowerCase()
export const workspaceOptionId = (choice: WorkspaceChoice): string => choice.kind === 'previous' ? `previous:${folderKey(choice.path)}` : choice.kind

/** Where the thread is set to work: the shared checkout, a new worktree, or another thread's worktree. */
export function workspaceChoice(thread: ToolbarThread): WorkspaceChoice {
  const worktree = thread.worktree
  if (worktree?.mode === 'independent') {
    if (worktree.existingWorktreePath && !worktree.path) return { kind: 'previous', path: worktree.existingWorktreePath }
    if (worktree.path && worktree.reused && worktree.status === 'ready') return { kind: 'previous', path: worktree.path }
    return { kind: 'new' }
  }
  return { kind: 'current' }
}

/** What the workspace control says now, in T3's words: the checkout, the worktree the thread already has, or the one it will make. */
export function workspaceLabel(thread: ToolbarThread): string {
  const choice = workspaceChoice(thread)
  if (choice.kind === 'previous') return previousWorktreeLabel(thread.worktree?.branch)
  if (choice.kind === 'new') return thread.worktree?.path ? t`Current worktree` : t`New worktree`
  return t`Current checkout`
}

/** "Previous worktree (main)", or "(detached)" for a worktree on no branch. */
function previousWorktreeLabel(branch: string | null | undefined): string {
  return branch == null
    ? t({ message: 'Previous worktree (detached)', comment: 'A worktree another thread made, on no branch.' })
    : t({ message: `Previous worktree (${ph({ branch: leftToRight(branch) })})`, comment: '{branch} is a Git branch name.' })
}

/**
 * The choices a draft can make: the checkout it shares, a worktree of its own, and every worktree another
 * thread of the same project already has, each named by its branch so two can be told apart.
 */
export function workspaceOptions(thread: ToolbarThread, threads: readonly ToolbarThread[]): WorkspaceOption[] {
  const previous: WorkspaceOption[] = []
  const seen = new Set<string>()
  // Use activity, not Git's polling time. Shell snapshots carry the newest message time in their summary.
  const recent = threads.filter(other => other.id !== thread.id && other.projectId === thread.projectId).map(other => ({ thread: other,
    at: other.messages.reduce((latest, message) => Math.max(latest, Date.parse(message.createdAt) || 0), Math.max(0, Date.parse(other.updatedAt ?? '') || 0, Date.parse(other.summary?.lastMessageAt ?? '') || 0)),
  }))
    .sort((a, b) => b.at - a.at)
  for (const { thread: other } of recent) {
    const worktree = other.worktree
    if (!worktree || worktree.mode !== 'independent' || worktree.status !== 'ready' || !worktree.path || worktree.reclaimedAt) continue
    // The machine's check worktree is the checks' own (#1312): the next check moves it, so no thread is offered it (Zach, October 27).
    if (worktree.check && worktree.reused) continue
    const key = folderKey(worktree.path)
    if (seen.has(key)) continue
    seen.add(key)
    const folder = worktree.path.split(/[\\/]/u).filter(Boolean).at(-1)
    previous.push({ id: `previous:${key}`, label: previousWorktreeLabel(worktree.branch), name: worktree.branch ?? t({ message: `Detached · ${ph({ folder: leftToRight(folder ?? '') })}`, comment: 'A worktree on no branch, named by its folder.' }), choice: { kind: 'previous', path: worktree.path } })
  }
  return [
    { id: 'current', label: t`Current checkout`, choice: { kind: 'current' } },
    { id: 'new', label: t`New worktree`, choice: { kind: 'new' } },
    ...previous,
  ]
}

/** The picker's own label: the branch, Select ref for a detached HEAD, or the base a new worktree will start from. */
export function branchLabel(thread: ToolbarThread): string {
  const worktree = thread.worktree
  if (!worktree) return t`Select ref`
  if (newWorktreeDraft(thread)) {
    // A pull request checked out into a worktree: the new folder takes that branch as it stands.
    if (worktree.checkoutBranch && worktree.branch) return worktree.branch
    const base = worktree.baseBranch ?? worktree.git?.branch ?? worktree.git?.defaultBranch ?? 'main'
    const ref = `${worktree.startFromOrigin === false ? '' : 'origin/'}${base}`
    return t({ message: `From ${ph({ ref: leftToRight(ref) })}`, comment: '{ref} is the Git branch a new worktree will start from.' })
  }
  return worktree.git?.branch ?? worktree.branch ?? t`Select ref`
}

/** Whether the picker's label names a branch or where a new worktree starts from, rather than asking for one (Select ref). */
export function branchLabelChosen(thread: ToolbarThread): boolean {
  const worktree = thread.worktree
  if (!worktree) return false
  if (newWorktreeDraft(thread)) return true
  return (worktree.git?.branch ?? worktree.branch) != null
}

/** Whether the picker's label is a ref's own name, which a right-click copies, rather than Select ref or a new worktree's base. */
export function branchLabelIsRef(thread: ToolbarThread): boolean {
  const worktree = thread.worktree
  if (!worktree) return false
  if (newWorktreeDraft(thread)) return Boolean(worktree.checkoutBranch && worktree.branch)
  return (worktree.git?.branch ?? worktree.branch) != null
}

/** The badge's tooltip, the way T3 writes it: "PR #12 - Open: title". */
export function pullRequestTitle(pullRequest: GitPullRequestSummary): string {
  const state = pullRequest.state.charAt(0).toUpperCase() + pullRequest.state.slice(1).toLowerCase()
  const number = pullRequest.number, title = pullRequest.title
  return t({ message: `PR #${number} - ${state}: ${title}`, comment: '{state} is GitHub\'s word for the pull request\'s state; {title} is its title.' })
}

/** The name Create new ref gives a typed query: trimmed, whitespace to dashes. Empty when nothing usable was typed. */
export function createRefName(query: string): string {
  return query.trim().replace(/\s+/gu, '-')
}

/** Whether the query names a ref the page does not already list, so Create new ref is offered. */
export function offersCreate(query: string, refs: readonly GitRef[]): boolean {
  const name = createRefName(query)
  if (!name || name.startsWith('-') || name.includes('..') || name.endsWith('/') || name.endsWith('.lock')) return false
  const lower = name.toLowerCase()
  return !refs.some(ref => ref.name.toLowerCase() === lower || (ref.remote && ref.name.slice(ref.remote.length + 1).toLowerCase() === lower))
}

export type RefBadge = 'current' | 'worktree' | 'remote' | 'default'
export function refBadges(ref: GitRef): RefBadge[] {
  const badges: RefBadge[] = []
  if (ref.current) badges.push('current')
  if (ref.worktreePath) badges.push('worktree')
  if (ref.remote) badges.push('remote')
  if (ref.isDefault) badges.push('default')
  return badges
}

/** What a pick does for this thread, decided before anything is sent. */
export type PickOutcome =
  | { readonly kind: 'switch'; readonly ref: string }
  | { readonly kind: 'repoint'; readonly path: string }
  // Sotto's own words, kept as a message and read in the interface language when shown.
  | { readonly kind: 'refuse'; readonly reason: MessageDescriptor }
  | { readonly kind: 'record-base'; readonly baseBranch: string; readonly startFromOrigin: boolean }
export function pickOutcome(ref: GitRef, thread: ToolbarThread): PickOutcome {
  const worktree = thread.worktree
  if (newWorktreeDraft(thread)) {
    // A worktree not made yet: the pick only says where it starts from. A remote ref means fetching that branch first.
    const base = ref.remote ? ref.name.slice(ref.remote.length + 1) : ref.name
    return { kind: 'record-base', baseBranch: base, startFromOrigin: ref.remote ? true : worktree?.startFromOrigin !== false }
  }
  const name = ref.name
  if (ref.current) return { kind: 'refuse', reason: msg({ message: `${ph({ name: leftToRight(name) })} is already checked out here.`, comment: '{name} is a Git branch name.' }) }
  if (ref.worktreePath) {
    if (!workspaceLocked(thread)) return { kind: 'repoint', path: ref.worktreePath }
    return { kind: 'refuse', reason: msg({ message: `${ph({ name: leftToRight(name) })} is checked out in another worktree. Start a new thread there to work on it.`, comment: '{name} is a Git branch name.' }) }
  }
  // A draft pointed at another thread's worktree does not move that worktree's branch before it has started there.
  if (previousWorktreeDraft(thread)) {
    const branch = worktree?.branch
    return { kind: 'refuse', reason: branch == null
      ? msg`This thread will work in a worktree that is on its own branch. Switch branches there after the first send.`
      : msg({ message: `This thread will work in a worktree that is on ${ph({ branch: leftToRight(branch) })}. Switch branches there after the first send.`, comment: '{branch} is a Git branch name.' }) }
  }
  return { kind: 'switch', ref: ref.name }
}

/** T3's toast title, then Git's own words. The host already says it that way; a refusal from elsewhere gets the title here. */
export function switchFailure(error: string | null | undefined): LaterWords {
  const detail = (error ?? '').replace(/\s+/gu, ' ').trim()
  if (!detail) return msg`Failed to switch ref.`
  // The host writes its own refusal with this title already, in English.
  return detail.startsWith('Failed to switch ref') ? detail : msg({ message: `Failed to switch ref. ${detail}`, comment: '{detail} is the host\'s or Git\'s own words for why.' })
}

interface Chord { readonly key: string; readonly ctrl: boolean; readonly shift: boolean; readonly alt: boolean; readonly meta: boolean }

/** A chord in T3's spelling (`mod+shift+g`) resolved for one platform: mod is Command on macOS and Control elsewhere. */
export function parseChord(chord: string, platform: SottoPlatform): Chord {
  const parts = chord.toLowerCase().split('+').map(part => part.trim()).filter(Boolean)
  // `space` names the key a keydown calls ' ', the spelling `parseAccelerator` below already resolves to, so the two agree.
  const key = (parts.at(-1) ?? '') === 'space' ? ' ' : (parts.at(-1) ?? '')
  const mods = new Set(parts.slice(0, -1))
  const mod = mods.has('mod')
  return {
    key, shift: mods.has('shift'), alt: mods.has('alt') || mods.has('option'),
    ctrl: mods.has('ctrl') || mods.has('control') || (mod && platform !== 'darwin'),
    meta: mods.has('meta') || mods.has('cmd') || mods.has('command') || (mod && platform === 'darwin'),
  }
}

/** An Electron accelerator (`CommandOrControl+Shift+Space`), the dictation hotkey's spelling, on the same footing. */
export function parseAccelerator(accelerator: string, platform: SottoPlatform): Chord | null {
  const parts = accelerator.split('+').map(part => part.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const key = parts.at(-1)!.toLowerCase()
  const mods = new Set(parts.slice(0, -1).map(part => part.toLowerCase()))
  const commandOrControl = mods.has('commandorcontrol') || mods.has('cmdorctrl')
  return {
    key: key === 'space' ? ' ' : key, shift: mods.has('shift'), alt: mods.has('alt') || mods.has('option') || mods.has('altgr'),
    ctrl: mods.has('control') || mods.has('ctrl') || (commandOrControl && platform !== 'darwin'),
    meta: mods.has('command') || mods.has('cmd') || mods.has('super') || mods.has('meta') || (commandOrControl && platform === 'darwin'),
  }
}

/** A toolbar chord is claimed only when the dictation hotkey does not already mean something on the same keys. */
export function chordClaimed(chord: string, hotkey: string | undefined, platform: SottoPlatform): boolean {
  if (!hotkey) return true
  const own = parseChord(chord, platform), taken = parseAccelerator(hotkey, platform)
  if (!taken) return true
  return !(own.key === taken.key && own.ctrl === taken.ctrl && own.shift === taken.shift && own.alt === taken.alt && own.meta === taken.meta)
}

/**
 * The key a keydown means, for matching a chord. Shift turns a digit into its symbol ('!') and Option turns a
 * letter into another character ('å'), while `code` names the physical key either way — which is also how a
 * shortcut was recorded. Letters and digits therefore read from `code` when the event carries it; every
 * other key (Enter, Space, the arrows, F keys) already spells itself the same in `key`.
 */
function eventKey(event: { key: string; code?: string }): string {
  if (typeof event.code === 'string') {
    if (/^Key[A-Z]$/u.test(event.code)) return event.code.slice(3).toLowerCase()
    if (/^Digit[0-9]$/u.test(event.code)) return event.code.slice(5)
  }
  return event.key.toLowerCase()
}

/** Whether a keydown is this chord, read from the event's modifier flags and its key. */
export function chordMatches(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'> & { code?: string }, chord: string, platform: SottoPlatform): boolean {
  const own = parseChord(chord, platform)
  return eventKey(event) === own.key && event.ctrlKey === own.ctrl && event.shiftKey === own.shift && event.altKey === own.alt && event.metaKey === own.meta
}
