import React, { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Check, ChevronDown, Folder, GitBranch, GitMerge, GitPullRequest, GitPullRequestArrow, GitPullRequestClosed, GitPullRequestDraft, Laptop, Plus, Search, Server } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import type { GitPullRequestSummary } from '../../../shared/gitStatus'
import type { GitRef, GitRefsPage } from '../../../shared/gitRefs'
import { parsePullRequestReference } from '../../../shared/gitPullRequests'
import { CheckoutPullRequestDialog } from '../tools/PullRequestDialogs'
import { toolsPanelStore } from '../tools/toolsPanelStore'
import { useOptionalApp } from '../state/AppContext'
import type { AgentConnection } from './AgentContext'
import { moveListboxFocus } from './listboxKeys'
import { writeClipboard } from './richActions'
import { isCompositionKey } from './composerKeys'
import { branchLabel, branchLabelIsRef, chordClaimed, chordMatches, createRefName, newWorktreeDraft, offersCreate, pickOutcome, pullRequestTitle, refBadges, switchFailure, TOOLBAR_SHORTCUTS, toolbarApplies, workspaceChoice, workspaceLabel, workspaceLocked, workspaceOptionId, workspaceOptions, type ToolbarThread, type WorkspaceChoice } from './branchToolbar.logic'
import type { ThreadRow } from './threadFacts'
import { threadHostName } from './HostBadge'
import { wordsOf } from './interfaceWords'
import './branchToolbar.css'

type Command = AgentConnection['command']
const PAGE_SIZE = 60
const SEARCH_DELAY_MS = 120

/** The bridge call the picker reads pages through; absent in a window without the preload, which lists nothing. */
function refsBridge(): ((request: { threadId: string; query?: string; cursor?: number; limit?: number; refresh?: boolean }) => Promise<GitRefsPage>) | undefined {
  return window.sotto?.agents?.gitRefs
}

/** A pull request's state as a glyph, here and on the Pull request surface; a draft takes `GitPullRequestDraft`. */
export const PR_ICONS: Record<GitPullRequestSummary['state'], typeof GitPullRequest> = { open: GitPullRequest, closed: GitPullRequestClosed, merged: GitMerge }

/**
 * Where the pull request badge takes a press, and the words its name ends with. On the Threads page it opens the
 * Pull request surface in Tools, beside the panes. A page with no Tools panel provides its own: Watcher's room takes
 * the thread to the Threads page, selected, with Tools open on its pull request.
 */
export interface PullRequestOpener {
  readonly open: (threadId: string) => void
  readonly where: string
}
const IN_TOOLS_WHERE = msg({ message: 'in Tools', comment: 'Where the pull request opens: Open PR #12 - Open: title in Tools.' })
const IN_TOOLS: PullRequestOpener = { open: threadId => toolsPanelStore.showPullRequest(threadId), get where() { return i18n._(IN_TOOLS_WHERE) } }
export const PullRequestOpenerContext = createContext<PullRequestOpener>(IN_TOOLS)

/**
 * T3's branch toolbar, under the composer of a thread whose folder is a Git repository. Run on and Workspace
 * on the left, the pull request badge and the branch picker on the right. Workspace and Run on read as static
 * text once the thread has a message or a session; the picker keeps working for as long as the folder does.
 * Every change goes to the host as a command and the record it publishes is what the toolbar shows next.
 */
export function BranchToolbar({ row, state, command, focused = true, onExplainedError }: {
  readonly row: ThreadRow
  readonly state: AgentState
  readonly command: Command
  /** Only the focused pane answers the shortcuts, so two panes side by side never both open. */
  readonly focused?: boolean
  /** The refusal this row is showing under itself, so the pane's own error line does not say it twice; null when none. */
  readonly onExplainedError?: ((error: string | null) => void) | undefined
}): ReactNode {
  const thread: ToolbarThread = row.thread
  const { t } = useLingui()
  const app = useOptionalApp()
  const platform = app?.platform ?? 'win32'
  const hotkey = app?.settings?.hotkey
  const opener = useContext(PullRequestOpenerContext)
  const [busy, setBusy] = useState<'workspace' | 'branch' | null>(null)
  const [notice, setNotice] = useState<{ readonly text: string; readonly tone: 'error' | 'status' } | null>(null)
  const workspaceTrigger = useRef<HTMLButtonElement>(null)
  const branchTrigger = useRef<HTMLButtonElement>(null)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  /** The reference Checkout pull request opened with; null while its dialog is closed. */
  const [checkout, setCheckout] = useState<string | null>(null)
  const inFlight = useRef(false)
  useEffect(() => { setNotice(null); setWorkspaceOpen(false); setBranchOpen(false); setCheckout(null) }, [thread.id])
  const explained = useRef(onExplainedError)
  explained.current = onExplainedError
  useEffect(() => { explained.current?.(notice?.tone === 'error' ? notice.text : null) }, [notice])
  useEffect(() => () => explained.current?.(null), [])

  const locked = workspaceLocked(thread)
  const options = workspaceOptions(thread, state.host.threads)
  const previous = options.find(option => option.choice.kind === 'previous')

  const run = useCallback(async (lane: 'workspace' | 'branch', request: Parameters<Command>[0], failure: (error: string | null | undefined) => string): Promise<boolean> => {
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(lane); setNotice(null)
    try {
      const result = await command(request)
      if (!result || result.error) { setNotice({ text: failure(result?.error), tone: 'error' }); return false }
      return true
    } catch { setNotice({ text: failure(t`Sotto could not confirm this change.`), tone: 'error' }); return false }
    finally { inFlight.current = false; setBusy(null) }
  }, [command, t])

  const chooseWorkspace = async (choice: WorkspaceChoice): Promise<void> => {
    const worktree = thread.worktree
    const selection = choice.kind === 'current' ? { workingCopy: 'shared' as const }
      : choice.kind === 'new' ? { workingCopy: 'independent' as const, startFromOrigin: worktree?.startFromOrigin ?? true, ...(worktree?.baseBranch ? { baseBranch: worktree.baseBranch } : {}) }
        : { workingCopy: 'independent' as const, existingWorktreePath: choice.path }
    await run('workspace', { type: 'configure-thread-working-copy', threadId: thread.id, ...selection }, error => error ?? t`Could not change the workspace. Your choice is retained.`)
  }

  const pick = async (ref: GitRef): Promise<boolean> => {
    const outcome = pickOutcome(ref, thread)
    switch (outcome.kind) {
      case 'refuse': setNotice({ text: outcome.reason, tone: 'error' }); return false
      case 'repoint': return run('branch', { type: 'configure-thread-working-copy', threadId: thread.id, workingCopy: 'independent', existingWorktreePath: outcome.path }, error => error ?? t`Could not use that worktree. Your choice is retained.`)
      case 'record-base': return run('branch', { type: 'configure-thread-working-copy', threadId: thread.id, workingCopy: 'independent', baseBranch: outcome.baseBranch, startFromOrigin: outcome.startFromOrigin }, error => error ?? t`Could not record the starting branch. Your choice is retained.`)
      case 'switch': return run('branch', { type: 'git-switch-branch', threadId: thread.id, ref: outcome.ref }, switchFailure)
    }
  }
  const create = async (name: string): Promise<boolean> => {
    if (newWorktreeDraft(thread)) { setNotice({ text: t`A new worktree starts from a branch that exists. Choose one, or create the branch after the first send.`, tone: 'error' }); return false }
    return run('branch', { type: 'git-switch-branch', threadId: thread.id, ref: name, create: true }, error => error ?? t({ message: `Could not create ${name}.`, comment: '{name} is a Git branch name.' }))
  }
  const setStartFromOrigin = async (startFromOrigin: boolean): Promise<void> => {
    const worktree = thread.worktree
    await run('branch', { type: 'configure-thread-working-copy', threadId: thread.id, workingCopy: 'independent', startFromOrigin, ...(worktree?.baseBranch ? { baseBranch: worktree.baseBranch } : {}) }, error => error ?? t`Could not change where the worktree starts from.`)
  }
  const copyName = async (name: string): Promise<void> => {
    try { await writeClipboard(name); setNotice({ text: t({ message: `Copied ${name}.`, comment: '{name} is a Git branch name.' }), tone: 'status' }) }
    catch { setNotice({ text: t`Could not copy the branch name. Select it and copy it with Ctrl+C.`, tone: 'error' }) }
  }

  // The shortcuts: each is claimed only when the dictation hotkey does not already mean the same keys, and only
  // for the focused pane. Previous worktree acts at once, since it names one choice; the other two open their control.
  useEffect(() => {
    if (!focused || !toolbarApplies(thread)) return
    const onKey = (event: KeyboardEvent): void => {
      if (document.querySelector('dialog[open], [role="dialog"]')) return
      const claims = (chord: string): boolean => chordClaimed(chord, hotkey, platform) && chordMatches(event, chord, platform)
      if (claims(TOOLBAR_SHORTCUTS.branch)) { event.preventDefault(); setWorkspaceOpen(false); setBranchOpen(true); return }
      if (claims(TOOLBAR_SHORTCUTS.workspace) && !locked) { event.preventDefault(); setBranchOpen(false); setWorkspaceOpen(true); workspaceTrigger.current?.focus(); return }
      if (claims(TOOLBAR_SHORTCUTS.previous) && !locked && previous && busy === null) { event.preventDefault(); void chooseWorkspace(previous.choice) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!toolbarApplies(thread)) return null
  const pullRequest = thread.worktree?.git?.pullRequest ?? null
  const hostName = threadHostName(state, row.thread)
  const draftWorktree = newWorktreeDraft(thread)
  const workspace = workspaceLabel(thread)
  return <div className="branch-toolbar" role="group" aria-label={t`Branch toolbar`} data-busy={busy ?? undefined}>
    <LabelPill icon={thread.remoteHost ? Server : Laptop} label={t`Run on`} value={hostName}
      title={thread.remoteHost ? t`The thread runs on this host; it was chosen when the thread was made.` : t`The thread runs on this computer.`} />
    <Separator />
    {locked
      ? <LabelPill icon={Folder} label={t({ message: 'Workspace', comment: 'Where the thread works: its checkout or a worktree.' })} value={workspace} title={t`Workspace: ${workspace}`} />
      : <WorkspaceMenu triggerRef={workspaceTrigger} open={workspaceOpen} onOpenChange={setWorkspaceOpen} label={workspace} value={workspaceOptionId(workspaceChoice(thread))}
        options={options} disabled={busy !== null} onChoose={choice => void chooseWorkspace(choice)} />}
    {/* The badge and the picker wrap as one onto the next line when the line has no room for them. */}
    <span className="branch-toolbar__end">
      <Separator />
      {pullRequest ? <><PullRequestBadge pullRequest={pullRequest} where={opener.where} onOpen={() => opener.open(thread.id)} /><Separator /></> : null}
      <BranchPicker threadId={thread.id} triggerRef={branchTrigger} open={branchOpen} onOpenChange={setBranchOpen} label={branchLabel(thread)} copyable={branchLabelIsRef(thread)} busy={busy === 'branch'} disabled={busy !== null}
        draftWorktree={draftWorktree} startFromOrigin={thread.worktree?.startFromOrigin !== false}
        onPick={pick} onCreate={create} onCopy={copyName} onStartFromOrigin={value => void setStartFromOrigin(value)} onCheckoutPullRequest={reference => setCheckout(reference)} />
    </span>
    {notice ? <p className="branch-toolbar__notice" data-tone={notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}
    {checkout !== null ? <CheckoutPullRequestDialog threadId={thread.id} initialReference={checkout} command={command} worktreeAllowed={!locked} localMovesToCheckout={!locked && thread.worktree?.mode !== 'shared'}
      onClose={() => { setCheckout(null); branchTrigger.current?.focus() }} onDone={text => { setCheckout(null); setNotice({ text, tone: 'status' }); branchTrigger.current?.focus() }} /> : null}
  </div>
}

/** The words a ref's badges show; `data-badge` keeps the key. */
const REF_BADGE_WORDS = wordsOf({
  current: msg({ message: 'current', comment: 'A badge on a Git ref: the branch checked out here.' }),
  worktree: msg({ message: 'worktree', comment: 'A badge on a Git ref: checked out in a worktree.' }),
  remote: msg({ message: 'remote', comment: 'A badge on a Git ref: a remote branch.' }),
  default: msg({ message: 'default', comment: 'A badge on a Git ref: the repository\'s default branch.' }),
})

/** The faint dot between the line's parts, for the eye only. */
function Separator(): ReactNode {
  return <span className="branch-toolbar__separator" aria-hidden="true">·</span>
}

/**
 * A label in the line that is not a control: Run on, and Workspace once it has locked. The key word stays in the text for
 * the screen reader and the tests; the eye gets the glyph and the value.
 */
function LabelPill({ icon: Icon, label, value, title }: { readonly icon: typeof Laptop; readonly label: string; readonly value: string; readonly title: string }): ReactNode {
  return <span className="branch-toolbar__static" title={title}><Icon size={13} aria-hidden="true" /><span className="tt-visually-hidden">{label} </span><span>{value}</span></span>
}

/**
 * The badge: the pull request's state as an icon and its number, its title in the tooltip, and a press that opens the
 * Pull request surface in Tools, on this page or, where `where` says so, on the Threads page.
 */
function PullRequestBadge({ pullRequest, where, onOpen }: { readonly pullRequest: GitPullRequestSummary; readonly where: string; readonly onOpen: () => void }): ReactNode {
  const Icon = pullRequest.draft && pullRequest.state === 'open' ? GitPullRequestDraft : PR_ICONS[pullRequest.state]
  const { t } = useLingui()
  const title = pullRequestTitle(pullRequest)
  return <button type="button" className="branch-toolbar__pr tt-focusable" data-state={pullRequest.draft && pullRequest.state === 'open' ? 'draft' : pullRequest.state}
    title={title} aria-label={t({ message: `Open ${title} ${where}`, comment: '{title} reads PR #12 - Open: its title; {where} says where it opens, such as in Tools.' })} onClick={onOpen}>
    <Icon size={13} aria-hidden="true" /><span>#{pullRequest.number}</span>
  </button>
}

/** The Workspace chip: fixed starting choices, five recent worktrees, and search across the project's worktrees. */
function WorkspaceMenu({ triggerRef, open, onOpenChange, label, value, options, disabled, onChoose }: {
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>
  readonly open: boolean; readonly onOpenChange: (open: boolean) => void
  readonly label: string; readonly value: string
  readonly options: ReturnType<typeof workspaceOptions>
  readonly disabled: boolean
  readonly onChoose: (choice: WorkspaceChoice) => void
}): ReactNode {
  const { t } = useLingui()
  const panel = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const restoreFocus = useRef(false)
  const [query, setQuery] = useState('')
  const [position, setPosition] = useState<{ left: number; width: number; maxHeight: number; below: boolean } | null>(null)
  const listId = useId()
  const panelId = useId()
  const needle = query.trim().toLowerCase()
  const worktrees = options.filter(option => option.choice.kind === 'previous')
  const recent = needle ? worktrees.filter(option => `${option.name ?? option.label} ${option.choice.kind === 'previous' ? option.choice.path : ''}`.toLowerCase().includes(needle)) : worktrees.slice(0, 5)
  useEffect(() => {
    if (disabled || !restoreFocus.current) return
    restoreFocus.current = false
    // Disabling a focused button drops focus to the document. Restore it after the command, unless the
    // user has already moved elsewhere while it was running.
    if (document.activeElement === document.body) triggerRef.current?.focus()
  }, [disabled, triggerRef])
  useEffect(() => {
    if (!open) return
    setQuery('')
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!panel.current?.contains(target) && !triggerRef.current?.contains(target)) onOpenChange(false)
    }
    document.addEventListener('pointerdown', dismiss, true)
    search.current?.focus()
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [open, onOpenChange, triggerRef])
  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    if (!trigger) return
    const composerElement = trigger.closest('.thread-workspace__compose')
    const paneElement = trigger.closest('.thread-pane') ?? composerElement
    const update = (): void => {
      const anchor = trigger.getBoundingClientRect()
      const pane = paneElement?.getBoundingClientRect()
      const leftEdge = Math.max(8, (pane?.left ?? 0) + 8)
      const rightEdge = Math.min(window.innerWidth - 8, (pane?.right ?? window.innerWidth) - 8)
      const width = Math.min(340, rightEdge - leftEdge)
      const left = Math.max(leftEdge, Math.min(anchor.left, rightEdge - width)) - anchor.left
      const topEdge = Math.max(0, pane?.top ?? 0) + 8
      const bottomEdge = Math.min(window.innerHeight, pane?.bottom ?? window.innerHeight) - 8
      const above = anchor.top - topEdge - 6
      const below = bottomEdge - anchor.bottom - 6
      const opensBelow = above < 280 && below > above
      const maxHeight = Math.min(380, Math.max(0, opensBelow ? below : above))
      setPosition(previous => previous?.left === left && previous.width === width && previous.maxHeight === maxHeight && previous.below === opensBelow ? previous : { left, width, maxHeight, below: opensBelow })
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(trigger)
    if (paneElement) observer?.observe(paneElement)
    if (composerElement && composerElement !== paneElement) observer?.observe(composerElement)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
  }, [open, triggerRef])
  const optionButton = (option: ReturnType<typeof workspaceOptions>[number]): ReactNode => {
    const Icon = option.choice.kind === 'current' ? Folder : option.choice.kind === 'new' ? Plus : GitBranch
    return <button type="button" role="option" key={option.id} aria-label={option.label} aria-selected={option.id === value}
      className="branch-toolbar__workspace-option" title={option.choice.kind === 'previous' ? option.choice.path : undefined}
      onClick={() => { onOpenChange(false); triggerRef.current?.focus(); if (option.id !== value) { restoreFocus.current = true; onChoose(option.choice) } }}>
      <Icon size={14} aria-hidden="true" /><span>{option.name ?? option.label}</span>{option.id === value ? <Check size={14} aria-hidden="true" /> : null}</button>
  }
  return <div className="branch-toolbar__menu"
    onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onOpenChange(false); triggerRef.current?.focus() } }}
    onBlur={event => { if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) onOpenChange(false) }}>
    <button ref={triggerRef} type="button" className="branch-toolbar__chip tt-focusable" role="combobox" aria-label={t`Choose workspace`} title={t`Workspace: ${label}`} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? panelId : undefined} disabled={disabled} onClick={() => onOpenChange(!open)}>
      <Folder size={13} aria-hidden="true" /><span>{label}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {open ? <div ref={panel} id={panelId} role="dialog" aria-label={t`Choose workspace`} className="branch-toolbar__list branch-toolbar__workspace"
      style={position ? { left: position.left, width: position.width, maxHeight: position.maxHeight, ...(position.below ? { top: 'calc(100% + 6px)', bottom: 'auto' } : {}) } : undefined}>
      <label className="branch-toolbar__search"><Search size={14} aria-hidden="true" /><input ref={search} type="search" aria-label={t`Search worktrees`} placeholder={t`Search worktrees`} value={query} aria-controls={listId}
        onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const items = list.current?.querySelectorAll<HTMLButtonElement>('button'); (event.key === 'ArrowDown' ? items?.[0] : items?.[items.length - 1])?.focus() }
        }} /></label>
      <div ref={list} id={listId} role="listbox" aria-label={t({ message: 'Workspace', comment: 'Where the thread works: its checkout or a worktree.' })} className="branch-toolbar__workspace-choices" onKeyDown={event => moveListboxFocus(event, list.current)}>
        <div role="group" aria-label={t`Start here`} className="branch-toolbar__workspace-start">{options.filter(option => option.choice.kind !== 'previous').map(optionButton)}</div>
        <div className="branch-toolbar__workspace-heading" aria-hidden="true">{needle ? t`Search results` : t`Recent worktrees`}</div>
        <div role="group" aria-label={needle ? t`Search results` : t`Recent worktrees`} className="branch-toolbar__workspace-recent">{recent.map(optionButton)}
          {recent.length === 0 ? <p className="branch-toolbar__empty tt-paragraph" role="status">{needle ? t`No matching worktrees.` : t`No recent worktrees.`}</p> : null}
        </div>
      </div>
    </div> : null}
  </div>
}

/**
 * The branch picker: a ghost button with the branch, and a popover that searches the host's refs, lists them
 * with T3's badges and pages them, offers Create new ref for a name nothing matches, and for a worktree not
 * made yet carries the Start from origin switch. Right-click on a ref copies its name.
 */
function BranchPicker({ threadId, triggerRef, open, onOpenChange, label, copyable, busy, disabled, draftWorktree, startFromOrigin, onPick, onCreate, onCopy, onStartFromOrigin, onCheckoutPullRequest }: {
  readonly threadId: string
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>
  readonly open: boolean; readonly onOpenChange: (open: boolean) => void
  readonly label: string; readonly busy: boolean; readonly disabled: boolean
  /** The label is a ref's own name, which a right-click copies. */
  readonly copyable: boolean
  readonly draftWorktree: boolean; readonly startFromOrigin: boolean
  readonly onPick: (ref: GitRef) => Promise<boolean>
  readonly onCreate: (name: string) => Promise<boolean>
  readonly onCopy: (name: string) => Promise<void>
  readonly onStartFromOrigin: (value: boolean) => void
  /** A pull request URL, `#42` or a `gh pr checkout` line typed into the search opens Checkout pull request, as in T3. */
  readonly onCheckoutPullRequest: (reference: string) => void
}): ReactNode {
  const { t } = useLingui()
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<GitRefsPage | null>(null)
  const [refs, setRefs] = useState<GitRef[]>([])
  /** The query the listed refs answer; Enter waits until it is the one typed. */
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const enterPending = useRef(false)
  const searchEdited = useRef(false)
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; width: number } | null>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const generation = useRef(0)
  const panelId = useId()
  const listId = useId()
  const load = useCallback(async (nextQuery: string, cursor: number | undefined, refresh: boolean): Promise<void> => {
    const bridge = refsBridge()
    const turn = ++generation.current
    if (!bridge) { setFailure(t`Branches are unavailable in this window.`); return }
    setLoading(true); setFailure(null)
    try {
      const result = await bridge({ threadId, ...(nextQuery ? { query: nextQuery } : {}), ...(cursor !== undefined ? { cursor } : {}), limit: PAGE_SIZE, ...(refresh ? { refresh: true } : {}) })
      if (turn !== generation.current) return
      setPage(result)
      setRefs(previous => cursor ? [...previous, ...result.refs] : result.refs)
      setLoadedQuery(nextQuery)
    } catch {
      if (turn === generation.current) setFailure(t`Could not read the branches. Close and open the picker to try again.`)
    } finally { if (turn === generation.current) setLoading(false) }
  }, [threadId, t])
  useEffect(() => {
    if (!open) { generation.current++; enterPending.current = false; return }
    enterPending.current = false; searchEdited.current = false
    setQuery(''); setRefs([]); setPage(null); setLoadedQuery(null)
    void load('', undefined, true)
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!panel.current?.contains(target) && !triggerRef.current?.contains(target)) onOpenChange(false)
    }
    document.addEventListener('pointerdown', dismiss, true)
    search.current?.focus()
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [open, load, onOpenChange, triggerRef])
  useEffect(() => {
    // The open read answers the initial empty query. Every edit, including clearing it, asks again.
    if (!open || !searchEdited.current) return
    const timer = window.setTimeout(() => { void load(query, undefined, false) }, SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [open, query, load])
  // The row wraps at narrow widths and the trigger can land anywhere along it, so the panel is placed by
  // measurement: as wide as the pane allows, ending at the trigger's right edge when that fits and otherwise
  // slid along the row to stay inside the pane, and inside the window when there is no pane.
  useLayoutEffect(() => {
    if (!open) { setPosition(null); return }
    const element = triggerRef.current
    if (!element) return
    const pane = element.closest('.thread-pane, .thread-workspace__compose')
    const update = (): void => {
      const anchor = element.getBoundingClientRect()
      const bounds = pane?.getBoundingClientRect()
      const leftEdge = Math.max(0, bounds?.left ?? 0) + 8
      const rightEdge = Math.min(document.documentElement.clientWidth, bounds?.right ?? document.documentElement.clientWidth) - 8
      const width = Math.min(340, Math.max(0, rightEdge - leftEdge))
      const left = Math.max(leftEdge, Math.min(anchor.right - width, rightEdge - width)) - anchor.left
      setPosition(previous => previous?.left === left && previous.width === width ? previous : { left, width })
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(element)
    if (pane) observer?.observe(pane)
    window.addEventListener('resize', update)
    return () => { observer?.disconnect(); window.removeEventListener('resize', update) }
  }, [open, triggerRef])
  const close = useCallback((refocus: boolean): void => { enterPending.current = false; onOpenChange(false); if (refocus) triggerRef.current?.focus() }, [onOpenChange, triggerRef])
  const choose = useCallback(async (ref: GitRef): Promise<void> => { close(true); await onPick(ref) }, [close, onPick])
  const createName = createRefName(query)
  const pullRequestReference = parsePullRequestReference(query)
  const checkoutPullRequest = (): void => { if (!pullRequestReference) return; close(false); onCheckoutPullRequest(pullRequestReference) }
  const answered = loadedQuery === query
  const canCreate = !draftWorktree && answered && offersCreate(query, refs)
  /** Enter's meaning: the first listed ref, or the create when nothing is listed. Only once the list answers the typed query. */
  const takeEnter = useCallback((): boolean => {
    // A pull request reference stands first in the list, so Enter checks it out, the way T3 orders it.
    if (pullRequestReference) { close(false); onCheckoutPullRequest(pullRequestReference); return true }
    if (loadedQuery !== query) return false
    const first = refs[0]
    if (first) { void choose(first); return true }
    if (!draftWorktree && offersCreate(query, refs)) { close(true); void onCreate(createRefName(query)); return true }
    return true
  }, [loadedQuery, query, refs, draftWorktree, pullRequestReference, close, choose, onCheckoutPullRequest, onCreate])
  useEffect(() => { if (open && !disabled && enterPending.current && takeEnter()) enterPending.current = false }, [open, disabled, takeEnter])
  const empty = !loading && answered && refs.length === 0 && !canCreate && !pullRequestReference
  const checkedOutIn = (path: string): string => t({ message: `Checked out in ${path}`, comment: '{path} is the folder of the worktree that has the branch.' })
  const more = page?.nextCursor ?? null
  return <div className="branch-toolbar__picker"
    onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) } }}
    onBlur={event => { if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) onOpenChange(false) }}>
    <button ref={triggerRef} type="button" className="branch-toolbar__branch tt-focusable" role="combobox" aria-label={t`Choose branch`} title={busy ? t`Switching…` : label} aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open ? listId : undefined} disabled={disabled} data-busy={busy || undefined} onClick={() => onOpenChange(!open)}
      onContextMenu={event => { if (copyable) { event.preventDefault(); void onCopy(label) } }}>
      <GitBranch size={13} aria-hidden="true" /><span>{busy ? t`Switching…` : label}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {open ? <div ref={panel} id={panelId} className="branch-toolbar__panel" role="group" aria-label={t`Branches`} style={position ?? undefined}>
      <div className="branch-toolbar__search"><Search size={14} aria-hidden="true" />
        <input ref={search} aria-label={t`Search refs`} placeholder={t`Search refs...`} value={query} autoComplete="off" spellCheck={false}
          onChange={event => {
            enterPending.current = false; searchEdited.current = true; generation.current++
            setLoadedQuery(null); setLoading(true); setQuery(event.target.value)
          }}
          onKeyDown={event => {
            if (isCompositionKey(event.nativeEvent)) { event.stopPropagation(); return }
            if (event.key === 'ArrowDown') { event.preventDefault(); list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }
            if (event.key === 'Enter') {
              event.preventDefault()
              // Pressed before the list has answered the typed query, Enter waits for that answer rather than
              // acting on the previous one, which could check out a branch that was never chosen.
              if (!takeEnter()) enterPending.current = true
            }
          }} />
      </div>
      <div ref={list} id={listId} role="listbox" aria-label={t`Refs`} className="branch-toolbar__refs" onKeyDown={event => moveListboxFocus(event, list.current)}
        onScroll={event => { const element = event.currentTarget; if (more !== null && !loading && element.scrollTop + element.clientHeight >= element.scrollHeight - 24) void load(query, more, false) }}>
        {pullRequestReference ? <button type="button" role="option" aria-selected={false} className="branch-toolbar__create branch-toolbar__checkout" onClick={checkoutPullRequest}>
          <GitPullRequestArrow size={14} aria-hidden="true" /><span className="branch-toolbar__ref-name"><Trans>Checkout pull request</Trans></span><small>{pullRequestReference}</small></button> : null}
        {refs.map(ref => <button type="button" role="option" key={ref.name} aria-selected={ref.current} title={ref.worktreePath ? checkedOutIn(ref.worktreePath) : ref.name}
          onClick={() => void choose(ref)} onContextMenu={event => { event.preventDefault(); void onCopy(ref.name) }}>
          <span className="branch-toolbar__ref-name">{ref.name}</span>
          <span className="branch-toolbar__badges">{refBadges(ref).map(badge => <small key={badge} data-badge={badge}>{REF_BADGE_WORDS[badge]}</small>)}</span>
        </button>)}
        {canCreate ? <button type="button" role="option" aria-selected={false} className="branch-toolbar__create" onClick={() => { close(true); void onCreate(createName) }}>
          <span className="branch-toolbar__ref-name"><Trans>Create new ref “{createName}”</Trans></span></button> : null}
      </div>
      {more !== null ? <button type="button" className="branch-toolbar__more" disabled={loading} onClick={() => void load(query, more, false)}>{loading ? t`Loading…` : t`Show more`}</button> : null}
      {empty ? <p className="branch-toolbar__empty tt-paragraph">{failure ?? (page && !page.isRepository ? t`This folder is not a Git repository.` : query ? t`No refs match.` : t`No branches yet.`)}</p> : null}
      {failure && !empty ? <p className="branch-toolbar__empty" role="alert">{failure}</p> : null}
      {draftWorktree ? <label className="branch-toolbar__switch"><input type="checkbox" role="switch" checked={startFromOrigin} onChange={event => onStartFromOrigin(event.target.checked)} />{t`Start from origin`}<small>{startFromOrigin ? t`Fetches the branch before first send.` : t`Uses the local branch as it is.`}</small></label> : null}
    </div> : null}
  </div>
}
