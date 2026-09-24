import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Search } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import type { GitPullRequestSummary } from '../../../shared/gitStatus'
import type { GitRef, GitRefsPage } from '../../../shared/gitRefs'
import { useOptionalApp } from '../state/AppContext'
import type { AgentConnection } from './AgentContext'
import { moveListboxFocus } from './listboxKeys'
import { branchLabel, chordClaimed, chordMatches, createRefName, newWorktreeDraft, offersCreate, pickOutcome, pullRequestTitle, refBadges, switchFailure, TOOLBAR_SHORTCUTS, toolbarApplies, workspaceChoice, workspaceLabel, workspaceLocked, workspaceOptionId, workspaceOptions, type ToolbarThread, type WorkspaceChoice } from './branchToolbar.logic'
import type { ThreadRow } from './threadFacts'
import { listedHosts } from './HostBadge'
import './branchToolbar.css'

type Command = AgentConnection['command']
const PAGE_SIZE = 60
const SEARCH_DELAY_MS = 120

/** The bridge call the picker reads pages through; absent in a window without the preload, which lists nothing. */
function refsBridge(): ((request: { threadId: string; query?: string; cursor?: number; limit?: number; refresh?: boolean }) => Promise<GitRefsPage>) | undefined {
  return window.sotto?.agents?.gitRefs
}

const PR_ICONS: Record<GitPullRequestSummary['state'], typeof GitPullRequest> = { open: GitPullRequest, closed: GitPullRequestClosed, merged: GitMerge }

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
  const app = useOptionalApp()
  const platform = app?.platform ?? 'win32'
  const hotkey = app?.settings?.hotkey
  const [busy, setBusy] = useState<'workspace' | 'branch' | null>(null)
  const [notice, setNotice] = useState<{ readonly text: string; readonly tone: 'error' | 'status' } | null>(null)
  const workspaceTrigger = useRef<HTMLButtonElement>(null)
  const branchTrigger = useRef<HTMLButtonElement>(null)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const inFlight = useRef(false)
  useEffect(() => { setNotice(null); setWorkspaceOpen(false); setBranchOpen(false) }, [thread.id])
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
    } catch { setNotice({ text: failure('Sotto could not confirm this change.'), tone: 'error' }); return false }
    finally { inFlight.current = false; setBusy(null) }
  }, [command])

  const chooseWorkspace = async (choice: WorkspaceChoice): Promise<void> => {
    const worktree = thread.worktree
    const selection = choice.kind === 'current' ? { workingCopy: 'shared' as const }
      : choice.kind === 'new' ? { workingCopy: 'independent' as const, startFromOrigin: worktree?.startFromOrigin ?? true, ...(worktree?.baseBranch ? { baseBranch: worktree.baseBranch } : {}) }
        : { workingCopy: 'independent' as const, existingWorktreePath: choice.path }
    await run('workspace', { type: 'configure-thread-working-copy', threadId: thread.id, ...selection }, error => error ?? 'Could not change the workspace. Your choice is retained.')
  }

  const pick = async (ref: GitRef): Promise<boolean> => {
    const outcome = pickOutcome(ref, thread)
    switch (outcome.kind) {
      case 'refuse': setNotice({ text: outcome.reason, tone: 'error' }); return false
      case 'repoint': return run('branch', { type: 'configure-thread-working-copy', threadId: thread.id, workingCopy: 'independent', existingWorktreePath: outcome.path }, error => error ?? 'Could not use that worktree. Your choice is retained.')
      case 'record-base': return run('branch', { type: 'configure-thread-working-copy', threadId: thread.id, workingCopy: 'independent', baseBranch: outcome.baseBranch, startFromOrigin: outcome.startFromOrigin }, error => error ?? 'Could not record the starting branch. Your choice is retained.')
      case 'switch': return run('branch', { type: 'git-switch-branch', threadId: thread.id, ref: outcome.ref }, switchFailure)
    }
  }
  const create = async (name: string): Promise<boolean> => {
    if (newWorktreeDraft(thread)) { setNotice({ text: 'A new worktree starts from a branch that exists. Choose one, or create the branch after the first send.', tone: 'error' }); return false }
    return run('branch', { type: 'git-switch-branch', threadId: thread.id, ref: name, create: true }, error => error ?? `Could not create ${name}.`)
  }
  const setStartFromOrigin = async (startFromOrigin: boolean): Promise<void> => {
    const worktree = thread.worktree
    await run('branch', { type: 'configure-thread-working-copy', threadId: thread.id, workingCopy: 'independent', startFromOrigin, ...(worktree?.baseBranch ? { baseBranch: worktree.baseBranch } : {}) }, error => error ?? 'Could not change where the worktree starts from.')
  }
  const copyName = async (name: string): Promise<void> => {
    try { await navigator.clipboard.writeText(name); setNotice({ text: `Copied ${name}.`, tone: 'status' }) }
    catch { setNotice({ text: 'Could not copy the branch name.', tone: 'error' }) }
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
  // Named as the host list names it, so a remote host alone is still called by its name, not by a stand-in.
  const listed = listedHosts(state).find(item => item.hostId === row.thread.hostId)
  const hostName = listed?.name ?? (thread.remoteHost ? thread.hostLabel ?? 'Remote host' : 'This computer')
  const draftWorktree = newWorktreeDraft(thread)
  return <div className="branch-toolbar" role="group" aria-label="Branch toolbar" data-busy={busy ?? undefined}>
    <span className="branch-toolbar__static" title={thread.remoteHost ? 'The thread runs on this host; it was chosen when the thread was made.' : 'The thread runs on this computer.'}>Run on <strong>{hostName}</strong></span>
    {locked
      ? <span className="branch-toolbar__static">Workspace <strong>{workspaceLabel(thread)}</strong></span>
      : <WorkspaceMenu triggerRef={workspaceTrigger} open={workspaceOpen} onOpenChange={setWorkspaceOpen} label={workspaceLabel(thread)} value={workspaceOptionId(workspaceChoice(thread))}
        options={options} disabled={busy !== null} onChoose={choice => void chooseWorkspace(choice)} />}
    <span className="branch-toolbar__spacer" />
    {pullRequest ? <PullRequestBadge pullRequest={pullRequest} /> : null}
    <BranchPicker threadId={thread.id} triggerRef={branchTrigger} open={branchOpen} onOpenChange={setBranchOpen} label={branchLabel(thread)} busy={busy === 'branch'} disabled={busy !== null}
      draftWorktree={draftWorktree} startFromOrigin={thread.worktree?.startFromOrigin !== false}
      onPick={pick} onCreate={create} onCopy={copyName} onStartFromOrigin={value => void setStartFromOrigin(value)} />
    {notice ? <p className="branch-toolbar__notice" data-tone={notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}
  </div>
}

/** The badge: the pull request's state as an icon and its number, its title in the tooltip, and a press that opens it in the browser. */
function PullRequestBadge({ pullRequest }: { readonly pullRequest: GitPullRequestSummary }): ReactNode {
  const Icon = pullRequest.draft && pullRequest.state === 'open' ? GitPullRequestDraft : PR_ICONS[pullRequest.state]
  const title = pullRequestTitle(pullRequest)
  const open = window.sotto?.openExternalLink
  return <button type="button" className="branch-toolbar__pr tt-focusable" data-state={pullRequest.draft && pullRequest.state === 'open' ? 'draft' : pullRequest.state}
    title={title} aria-label={`Open ${title}`} disabled={!open} onClick={() => { void open?.(pullRequest.url) }}>
    <Icon size={13} aria-hidden="true" /><span>#{pullRequest.number}</span>
  </button>
}

/** The Workspace chip: a short list of where the draft will work, closed by a choice, Escape, Tab or a pointer outside. */
function WorkspaceMenu({ triggerRef, open, onOpenChange, label, value, options, disabled, onChoose }: {
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>
  readonly open: boolean; readonly onOpenChange: (open: boolean) => void
  readonly label: string; readonly value: string
  readonly options: ReturnType<typeof workspaceOptions>
  readonly disabled: boolean
  readonly onChoose: (choice: WorkspaceChoice) => void
}): ReactNode {
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!list.current?.contains(target) && !triggerRef.current?.contains(target)) onOpenChange(false)
    }
    document.addEventListener('pointerdown', dismiss, true)
    ;(list.current?.querySelector<HTMLButtonElement>('button[aria-selected="true"]') ?? list.current?.querySelector<HTMLButtonElement>('button'))?.focus()
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [open, onOpenChange, triggerRef])
  return <div className="branch-toolbar__menu"
    onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onOpenChange(false); triggerRef.current?.focus() } }}
    onBlur={event => { if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) onOpenChange(false) }}>
    <button ref={triggerRef} type="button" className="branch-toolbar__chip tt-focusable" role="combobox" aria-label="Choose workspace" title={`Workspace: ${label}`} aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open ? listId : undefined} disabled={disabled} onClick={() => onOpenChange(!open)}>
      <span className="branch-toolbar__chip-key">Workspace</span><span>{label}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {open ? <div ref={list} id={listId} role="listbox" aria-label="Workspace" className="branch-toolbar__list" onKeyDown={event => moveListboxFocus(event, list.current)}>
      {options.map(option => <button type="button" role="option" key={option.id} aria-selected={option.id === value}
        onClick={() => { onOpenChange(false); triggerRef.current?.focus(); if (option.id !== value) onChoose(option.choice) }}>
        <span>{option.label}</span>{option.id === value ? <Check size={14} aria-hidden="true" /> : null}</button>)}
    </div> : null}
  </div>
}

/**
 * The branch picker: a ghost button with the branch, and a popover that searches the host's refs, lists them
 * with T3's badges and pages them, offers Create new ref for a name nothing matches, and for a worktree not
 * made yet carries the Start from origin switch. Right-click on a ref copies its name.
 */
function BranchPicker({ threadId, triggerRef, open, onOpenChange, label, busy, disabled, draftWorktree, startFromOrigin, onPick, onCreate, onCopy, onStartFromOrigin }: {
  readonly threadId: string
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>
  readonly open: boolean; readonly onOpenChange: (open: boolean) => void
  readonly label: string; readonly busy: boolean; readonly disabled: boolean
  readonly draftWorktree: boolean; readonly startFromOrigin: boolean
  readonly onPick: (ref: GitRef) => Promise<boolean>
  readonly onCreate: (name: string) => Promise<boolean>
  readonly onCopy: (name: string) => Promise<void>
  readonly onStartFromOrigin: (value: boolean) => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState<GitRefsPage | null>(null)
  const [refs, setRefs] = useState<GitRef[]>([])
  /** The query the listed refs answer; Enter waits until it is the one typed. */
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const enterPending = useRef(false)
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
    if (!bridge) { setFailure('Branches are unavailable in this window.'); return }
    setLoading(true); setFailure(null)
    try {
      const result = await bridge({ threadId, ...(nextQuery ? { query: nextQuery } : {}), ...(cursor !== undefined ? { cursor } : {}), limit: PAGE_SIZE, ...(refresh ? { refresh: true } : {}) })
      if (turn !== generation.current) return
      setPage(result)
      setRefs(previous => cursor ? [...previous, ...result.refs] : result.refs)
      setLoadedQuery(nextQuery)
    } catch {
      if (turn === generation.current) setFailure('Could not read the branches. Close and open the picker to try again.')
    } finally { if (turn === generation.current) setLoading(false) }
  }, [threadId])
  useEffect(() => {
    if (!open) { generation.current++; enterPending.current = false; return }
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
    // The open read already answered the empty query; only a typed one asks the host again.
    if (!open || query === '') return
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
  const close = (refocus: boolean): void => { onOpenChange(false); if (refocus) triggerRef.current?.focus() }
  const choose = async (ref: GitRef): Promise<void> => { close(true); await onPick(ref) }
  const createName = createRefName(query)
  const answered = loadedQuery === query
  const canCreate = !draftWorktree && answered && offersCreate(query, refs)
  /** Enter's meaning: the first listed ref, or the create when nothing is listed. Only once the list answers the typed query. */
  const takeEnter = useCallback((): boolean => {
    if (loadedQuery !== query) return false
    const first = refs[0]
    if (first) { void choose(first); return true }
    if (!draftWorktree && offersCreate(query, refs)) { close(true); void onCreate(createRefName(query)); return true }
    return true
  }, [loadedQuery, query, refs, draftWorktree])
  useEffect(() => { if (enterPending.current && takeEnter()) enterPending.current = false }, [takeEnter])
  const empty = !loading && answered && refs.length === 0 && !canCreate
  const more = page?.nextCursor ?? null
  return <div className="branch-toolbar__picker"
    onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) } }}
    onBlur={event => { if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) onOpenChange(false) }}>
    <button ref={triggerRef} type="button" className="branch-toolbar__branch tt-focusable" role="combobox" aria-label="Choose branch" title={busy ? 'Switching…' : label} aria-haspopup="listbox" aria-expanded={open}
      aria-controls={open ? listId : undefined} disabled={disabled} data-busy={busy || undefined} onClick={() => onOpenChange(!open)}
      onContextMenu={event => { if (!label.startsWith('From ') && label !== 'Select ref') { event.preventDefault(); void onCopy(label) } }}>
      <GitBranch size={13} aria-hidden="true" /><span>{busy ? 'Switching…' : label}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {open ? <div ref={panel} id={panelId} className="branch-toolbar__panel" role="group" aria-label="Branches" style={position ?? undefined}>
      <div className="branch-toolbar__search"><Search size={14} aria-hidden="true" />
        <input ref={search} aria-label="Search refs" placeholder="Search refs..." value={query} autoComplete="off" spellCheck={false}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }
            if (event.key === 'Enter') {
              event.preventDefault()
              // Pressed before the list has answered the typed query, Enter waits for that answer rather than
              // acting on the previous one, which could check out a branch that was never chosen.
              if (!takeEnter()) enterPending.current = true
            }
          }} />
      </div>
      <div ref={list} id={listId} role="listbox" aria-label="Refs" className="branch-toolbar__refs" onKeyDown={event => moveListboxFocus(event, list.current)}
        onScroll={event => { const element = event.currentTarget; if (more !== null && !loading && element.scrollTop + element.clientHeight >= element.scrollHeight - 24) void load(query, more, false) }}>
        {refs.map(ref => <button type="button" role="option" key={ref.name} aria-selected={ref.current} title={ref.worktreePath ? `Checked out in ${ref.worktreePath}` : ref.name}
          onClick={() => void choose(ref)} onContextMenu={event => { event.preventDefault(); void onCopy(ref.name) }}>
          <span className="branch-toolbar__ref-name">{ref.name}</span>
          <span className="branch-toolbar__badges">{refBadges(ref).map(badge => <small key={badge} data-badge={badge}>{badge}</small>)}</span>
        </button>)}
        {canCreate ? <button type="button" role="option" aria-selected={false} className="branch-toolbar__create" onClick={() => { close(true); void onCreate(createName) }}>
          <span className="branch-toolbar__ref-name">Create new ref “{createName}”</span></button> : null}
      </div>
      {more !== null ? <button type="button" className="branch-toolbar__more" disabled={loading} onClick={() => void load(query, more, false)}>{loading ? 'Loading…' : 'Show more'}</button> : null}
      {empty ? <p className="branch-toolbar__empty">{failure ?? (page && !page.isRepository ? 'This folder is not a Git repository.' : query ? 'No refs match.' : 'No branches yet.')}</p> : null}
      {failure && !empty ? <p className="branch-toolbar__empty" role="alert">{failure}</p> : null}
      {draftWorktree ? <label className="branch-toolbar__switch"><input type="checkbox" role="switch" checked={startFromOrigin} onChange={event => onStartFromOrigin(event.target.checked)} />Start from origin<small>{startFromOrigin ? 'Fetches the branch on first send.' : 'Uses the local branch as it is.'}</small></label> : null}
    </div> : null}
  </div>
}
