import type { AgentThread } from '../../../shared/agents'
import type { GitPullRequestSummary } from '../../../shared/gitStatus'
import type { GitRef } from '../../../shared/gitRefs'
import type { SottoPlatform } from '../../../shared/platform'

/** The thread fields the toolbar reads; a full record satisfies it, and tests can pass less. */
export type ToolbarThread = Pick<AgentThread, 'id' | 'projectId' | 'nativeSessionStarted' | 'worktree' | 'messages' | 'remoteHost' | 'hostLabel'>

/** The three shortcuts the toolbar claims, in T3's chords. Run on is static text here, so it claims none. */
export const TOOLBAR_SHORTCUTS = { branch: 'mod+shift+g', workspace: 'mod+shift+x', previous: 'mod+shift+l' } as const
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
export interface WorkspaceOption { readonly id: string; readonly label: string; readonly choice: WorkspaceChoice }

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
  if (choice.kind === 'previous') return `Previous worktree (${thread.worktree?.branch ?? 'detached'})`
  if (choice.kind === 'new') return thread.worktree?.path ? 'Current worktree' : 'New worktree'
  return 'Current checkout'
}

/**
 * The choices a draft can make: the checkout it shares, a worktree of its own, and every worktree another
 * thread of the same project already has, each named by its branch so two can be told apart.
 */
export function workspaceOptions(thread: ToolbarThread, threads: readonly ToolbarThread[]): WorkspaceOption[] {
  const previous: WorkspaceOption[] = []
  const seen = new Set<string>()
  for (const other of threads) {
    const worktree = other.worktree
    if (other.id === thread.id || other.projectId !== thread.projectId || !worktree || worktree.mode !== 'independent' || worktree.status !== 'ready' || !worktree.path || worktree.reclaimedAt) continue
    const key = folderKey(worktree.path)
    if (seen.has(key)) continue
    seen.add(key)
    previous.push({ id: `previous:${key}`, label: `Previous worktree (${worktree.branch ?? 'detached'})`, choice: { kind: 'previous', path: worktree.path } })
  }
  return [
    { id: 'current', label: 'Current checkout', choice: { kind: 'current' } },
    { id: 'new', label: 'New worktree', choice: { kind: 'new' } },
    ...previous,
  ]
}

/** The picker's own label: the branch, Select ref for a detached HEAD, or the base a new worktree will start from. */
export function branchLabel(thread: ToolbarThread): string {
  const worktree = thread.worktree
  if (!worktree) return 'Select ref'
  if (newWorktreeDraft(thread)) {
    const base = worktree.baseBranch ?? worktree.git?.branch ?? worktree.git?.defaultBranch ?? 'main'
    return `From ${worktree.startFromOrigin === false ? '' : 'origin/'}${base}`
  }
  return worktree.git?.branch ?? worktree.branch ?? 'Select ref'
}

/** The badge's tooltip, the way T3 writes it: "PR #12 - Open: title". */
export function pullRequestTitle(pullRequest: GitPullRequestSummary): string {
  const state = pullRequest.state.charAt(0).toUpperCase() + pullRequest.state.slice(1).toLowerCase()
  return `PR #${pullRequest.number} - ${state}: ${pullRequest.title}`
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
  | { readonly kind: 'refuse'; readonly reason: string }
  | { readonly kind: 'record-base'; readonly baseBranch: string; readonly startFromOrigin: boolean }
export function pickOutcome(ref: GitRef, thread: ToolbarThread): PickOutcome {
  const worktree = thread.worktree
  if (newWorktreeDraft(thread)) {
    // A worktree not made yet: the pick only says where it starts from. A remote ref means fetching that branch first.
    const base = ref.remote ? ref.name.slice(ref.remote.length + 1) : ref.name
    return { kind: 'record-base', baseBranch: base, startFromOrigin: ref.remote ? true : worktree?.startFromOrigin !== false }
  }
  if (ref.current) return { kind: 'refuse', reason: `${ref.name} is already checked out here.` }
  if (ref.worktreePath) {
    if (!workspaceLocked(thread)) return { kind: 'repoint', path: ref.worktreePath }
    return { kind: 'refuse', reason: `${ref.name} is checked out in another worktree. Start a new thread there to work on it.` }
  }
  // A draft pointed at another thread's worktree does not move that worktree's branch before it has started there.
  if (previousWorktreeDraft(thread)) return { kind: 'refuse', reason: `This thread will work in a worktree that is on ${worktree?.branch ?? 'its own branch'}. Switch branches there after the first send.` }
  return { kind: 'switch', ref: ref.name }
}

/** T3's toast title, then Git's own words. The host already says it that way; a refusal from elsewhere gets the title here. */
export function switchFailure(error: string | null | undefined): string {
  const detail = (error ?? '').replace(/\s+/gu, ' ').trim()
  if (!detail) return 'Failed to switch ref.'
  return detail.startsWith('Failed to switch ref') ? detail : `Failed to switch ref. ${detail}`
}

interface Chord { readonly key: string; readonly ctrl: boolean; readonly shift: boolean; readonly alt: boolean; readonly meta: boolean }

/** A chord in T3's spelling (`mod+shift+g`) resolved for one platform: mod is Command on macOS and Control elsewhere. */
export function parseChord(chord: string, platform: SottoPlatform): Chord {
  const parts = chord.toLowerCase().split('+').map(part => part.trim()).filter(Boolean)
  const key = parts.at(-1) ?? ''
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

/** Whether a keydown is this chord, read from the event's modifier flags and its key. */
export function chordMatches(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>, chord: string, platform: SottoPlatform): boolean {
  const own = parseChord(chord, platform)
  return event.key.toLowerCase() === own.key && event.ctrlKey === own.ctrl && event.shiftKey === own.shift && event.altKey === own.alt && event.metaKey === own.meta
}
