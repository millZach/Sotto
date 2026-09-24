import React, { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  Check, ChevronDown, ChevronRight, Circle, CircleCheck, CircleDashed, CircleHelp, CircleX, Copy, ExternalLink, GitMerge,
  GitPullRequest, GitPullRequestDraft, Link2, RotateCw, Unlink, type LucideIcon,
} from 'lucide-react'
import type { AgentCommand, AgentState, AgentThread } from '../../../shared/agents'
import { branchPullRequestUrl, type GitPullRequestAction, type GitPullRequestDetail, type GitPullRequestMergeMethod } from '../../../shared/gitPullRequests'
import { PR_ICONS } from '../agents/BranchToolbar'
import { menuEntries } from '../agents/gitActionButton.logic'
import { Button } from '../components/Button'
import { ConfirmationDialog } from '../components/ConfirmationDialog'
import { PaneMenu, type PaneMenuItem } from '../agents/PaneMenu'
import { LinkPullRequestDialog, pullRequestBridge, sendCommand } from './PullRequestDialogs'
import {
  canAutoMerge, checklist, checklistHeading, confirmationFor, holdsBack, linesLeft, LINK_SOURCE, MERGE_METHOD_SHORT, mergedWhen, mergeEffect, mergeLabel, mergeReady,
  resolveMergeMethod, stateLabel, type ChecklistLine, type ConfirmedAction, type LineFix, type LineTone,
} from './pullRequestSurface.logic'
import { usePullRequestMergeMethod } from './usePullRequestMergeMethod'
import './pullRequestSurface.css'

type Command = (command: AgentCommand) => Promise<AgentState | null>
type Notice = { readonly text: string; readonly tone: 'status' | 'error' }
type Busy = GitPullRequestAction | 'unlink' | 'create-pr'
const LINE_ICONS: Record<LineTone, LucideIcon> = { done: CircleCheck, failed: CircleX, running: CircleDashed, todo: Circle, unknown: CircleHelp }
/** Said before a line's words, since its colour and icon are not read. */
const LINE_STATE: Record<LineTone, string> = { done: 'Done', failed: 'Failing', running: 'Waiting', todo: 'To do', unknown: 'Unknown' }
const BUSY_LABEL: Partial<Record<Busy, string>> = { merge: 'Merging...', ready: 'Marking ready...', 'update-branch': 'Updating...', reopen: 'Reopening...', 'disable-auto-merge': 'Turning off...', 'create-pr': 'Creating PR...' }
const stateIcon = (detail: Pick<GitPullRequestDetail, 'state' | 'draft'>): LucideIcon => detail.draft && detail.state === 'open' ? GitPullRequestDraft : PR_ICONS[detail.state]
const stateKey = (detail: Pick<GitPullRequestDetail, 'state' | 'draft'>): string => detail.draft && detail.state === 'open' ? 'draft' : detail.state
const onGitHub = (url: string): boolean => /^https:\/\/github\.com\//iu.test(url)

/**
 * The Pull request surface in Tools (ADR-0027): the merge checklist. The branch's pull request, or one linked to
 * the thread, read from GitHub through the host's gh when it opens and on Refresh, as five lines (checks, review,
 * up to date with the base, no conflicts, ready for review), each done or carrying the one press that fixes it.
 * One large Merge, in the method chosen beside it, is enabled only when no line holds it back; Merge when ready
 * arms GitHub's auto-merge instead. The description and the linked pull requests fold below, and the rest is in
 * the ··· menu. Nothing happens from viewing: every change is a press, and the merge, turning on auto-merge,
 * closing and Update with rebase ask first.
 */
export function PullRequestSurface({ thread, command, onStatus }: { readonly thread: AgentThread; readonly command: Command | undefined; readonly onStatus: (message: string) => void }): ReactNode {
  /** The pull request chosen from Linked pull requests; null for the thread's own (its branch's, else the one linked last). */
  const [chosen, setChosen] = useState<string | null>(null)
  const [detail, setDetail] = useState<GitPullRequestDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState<Busy | null>(null)
  const [confirming, setConfirming] = useState<ConfirmedAction | null>(null)
  const [linking, setLinking] = useState(false)
  const [descriptionOpen, setDescriptionOpen] = useState(false)
  const [linksOpen, setLinksOpen] = useState(false)
  const [preferred, choosePreferred] = usePullRequestMergeMethod()
  const generation = useRef(0)
  const surface = useRef<HTMLDivElement>(null)
  const top = useRef<HTMLHeadingElement>(null)
  const hintId = useId()
  const branchUrl = branchPullRequestUrl(thread) ?? null
  const links = thread.pullRequests ?? []
  // Which pull requests are linked, not what they last said: a read that brings a link's title up to date must not read again.
  const linkKey = links.map(link => link.url).join('|')

  const load = useCallback(async (): Promise<void> => {
    const turn = ++generation.current
    const read = pullRequestBridge()
    if (!read) { setLoading(false); setFailure('Pull requests are not available in this window.'); return }
    setLoading(true); setFailure(null)
    try {
      const next = await read({ threadId: thread.id, ...(chosen ? { reference: chosen } : {}) })
      if (turn !== generation.current) return
      setDetail(next)
    } catch {
      if (turn === generation.current) setFailure('Could not read the pull request from GitHub. Check your gh sign-in and connection, then refresh.')
    } finally { if (turn === generation.current) setLoading(false) }
  }, [thread.id, chosen])
  // Read again when another pull request is chosen, and when the record says GitHub moved (a new branch pull request, a link).
  useEffect(() => { void load() }, [load, branchUrl, linkKey])
  useEffect(() => () => { generation.current++ }, [])
  useEffect(() => { setChosen(null); setNotice(null); setDescriptionOpen(false); setLinksOpen(false) }, [thread.id])

  /** One command at a time. `then` runs before the press counts as over, so its controls stay off until it has finished too. */
  const send = async (request: AgentCommand, pending: Busy, fallback: string, then?: () => Promise<void>): Promise<boolean> => {
    if (!command || busy) return false
    setBusy(pending); setNotice(null)
    try {
      const result = await sendCommand(command, request, fallback)
      setNotice(result.error ? { text: result.error, tone: 'error' } : { text: result.notice ?? 'Done.', tone: 'status' })
      await then?.()
      return result.error === null
    } finally { setBusy(null) }
  }
  const act = async (action: GitPullRequestAction, withMethod?: GitPullRequestMergeMethod): Promise<void> => {
    if (!detail) return
    // The press is over only once GitHub has been read again: until then the checklist shows the pull request as it was
    // before the press, and a control enabled over it could merge twice or update a branch that was just updated.
    await send({ type: 'git-pull-request-action', threadId: thread.id, url: detail.url, action, ...(withMethod ? { method: withMethod } : {}) }, action,
      'Sotto could not confirm this. Refresh to see what GitHub has.', load)
    // A press that settled its line takes its own button away; focus comes back to the pull request rather than the page.
    requestAnimationFrame(() => { if (!surface.current?.contains(document.activeElement)) top.current?.focus() })
  }
  const unlink = async (url: string): Promise<void> => {
    if (await send({ type: 'git-unlink-pull-request', threadId: thread.id, url }, 'unlink', 'Could not unlink the pull request.') && chosen === url) setChosen(null)
  }
  const copyLink = async (url: string): Promise<void> => {
    try { await navigator.clipboard.writeText(url); onStatus('Link copied') } catch { onStatus('Could not copy the link') }
  }
  const openExternal = (url: string): void => { void window.sotto?.openExternalLink?.(url) }
  /** A linked pull request opens here; the view starts again at its top line. */
  const show = (url: string): void => { setChosen(url); setDescriptionOpen(false); requestAnimationFrame(() => top.current?.focus()) }
  const linkDialog = linking && command ? <LinkPullRequestDialog threadId={thread.id} command={command} onClose={() => setLinking(false)}
    onLinked={text => { setLinking(false); setNotice({ text, tone: 'status' }) }} /> : null
  const noticeLine = <>
    {notice ? <p className="pr-surface__notice" data-tone={notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p> : null}
    {/* A read that failed under a checklist already shown: the checklist is the last one GitHub gave, and says so. */}
    {failure && detail ? <p className="pr-surface__notice" data-tone="error" role="alert">{failure} What shows below is from the last read.</p> : null}
  </>
  const linked = <LinkedFold thread={thread} open={linksOpen} onToggle={() => setLinksOpen(value => !value)} onShow={show} onLink={command ? () => setLinking(true) : null} />
  const refresh = <button type="button" className="files-icon tt-focusable" aria-label="Refresh pull request" title="Refresh pull request" data-busy={loading || undefined} onClick={() => { setNotice(null); void load() }}><RotateCw size={15} aria-hidden="true" /></button>

  if (!detail) {
    return <div ref={surface} className="pr-surface" aria-busy={loading || busy !== null}>
      <div className="tools-chrome pr-surface__top">
        <span className="pr-surface__lead"><GitPullRequest size={16} aria-hidden="true" data-state="none" /><h2 ref={top} tabIndex={-1} className="pr-surface__name">{loading ? 'Pull request' : 'No pull request'}</h2></span>
        <div className="tools-chrome__actions">{refresh}</div>
      </div>
      {noticeLine}
      <div className="pr-surface__body">
        {loading ? <p className="files-preview__loading" role="status">Reading the pull request…</p>
          : failure ? <div className="files-problem" role="status"><strong>{failure}</strong><button type="button" className="files-link tt-focusable" onClick={() => void load()}>Try again</button></div>
            : <NoPullRequest thread={thread} busy={busy} command={command} onLink={() => setLinking(true)}
              onCreate={actionId => void send({ type: 'git-action', threadId: thread.id, actionId, action: 'create_pr' }, 'create-pr', 'Sotto could not confirm this Git command.').then(() => setNotice(current => current?.tone === 'status' ? null : current))} />}
        {!loading && !failure && (links.length > 0 || thread.worktree?.git?.pullRequest) ? linked : null}
      </div>
      {linkDialog}
    </div>
  }

  const lines = checklist(detail)
  const ready = mergeReady(detail, lines)
  const allowed = detail.mergeMethods
  const selected = resolveMergeMethod(allowed, preferred)
  // A read in flight, a Refresh or the one after a press, also holds every press: what is on screen may already be out of date.
  const running = busy !== null || loading
  const open = detail.state === 'open'
  const autoMerge = canAutoMerge(detail)
  const behind = (detail.behindBy ?? 0) > 0
  const done = lines.filter(line => line.tone === 'done').length
  const clear = !lines.some(holdsBack)
  const StateIcon = stateIcon(detail)
  const confirmation = confirming ? confirmationFor(confirming, detail.number, selected, detail.baseBranch) : null
  const menu: PaneMenuItem[][] = [[
    ...(open ? [detail.draft ? { id: 'ready', label: 'Ready for review', disabled: running, run: () => void act('ready') }
      : { id: 'draft', label: 'Convert to draft', disabled: running, run: () => void act('draft') }] : []),
    ...(open && behind && detail.canUpdateBranch ? [{ id: 'rebase', label: 'Update with rebase', disabled: running, run: () => setConfirming('update-with-rebase') }] : []),
    ...(autoMerge ? [{ id: 'auto', label: 'Merge when ready (auto-merge)', disabled: running, run: () => setConfirming('enable-auto-merge') }] : []),
    ...(detail.autoMerge ? [{ id: 'no-auto', label: 'Disable auto-merge', disabled: running, run: () => void act('disable-auto-merge') }] : []),
    { id: 'copy', label: 'Copy link', icon: <Copy size={15} aria-hidden="true" />, run: () => void copyLink(detail.url) },
    ...(command ? [{ id: 'link', label: 'Link pull request', icon: <Link2 size={15} aria-hidden="true" />, run: () => setLinking(true) }] : []),
    ...(detail.linked ? [{ id: 'unlink', label: 'Unlink from thread', icon: <Unlink size={15} aria-hidden="true" />, disabled: running, run: () => void unlink(detail.url) }] : []),
  ], [
    ...(open ? [{ id: 'close', label: 'Close pull request', tone: 'danger' as const, disabled: running, run: () => setConfirming('close') }] : []),
    ...(detail.state === 'closed' ? [{ id: 'reopen', label: 'Reopen pull request', disabled: running, run: () => void act('reopen') }] : []),
  ]]
  const fix = (line: ChecklistLine, press: LineFix): ReactNode => {
    switch (press.kind) {
      case 'open-check': return <Button variant="secondary" aria-label={`Open ${press.name} ${onGitHub(press.url) ? 'on GitHub' : 'in the browser'}`} onClick={() => openExternal(press.url)}>
        <ExternalLink size={14} aria-hidden="true" />Open check</Button>
      case 'open-review': return <Button variant="secondary" aria-label={press.author ? `Open ${press.author}'s review on GitHub` : 'Open the review on GitHub'} onClick={() => openExternal(press.url)}>
        <ExternalLink size={14} aria-hidden="true" />Open review</Button>
      case 'update-branch': return <Button variant="secondary" disabled={running} onClick={() => void act('update-branch')}>{busy === 'update-branch' ? BUSY_LABEL['update-branch'] : 'Update branch'}</Button>
      case 'ready': return <Button variant="secondary" disabled={running} onClick={() => void act('ready')}>{busy === 'ready' ? BUSY_LABEL.ready : line.label}</Button>
    }
  }
  const when = mergedWhen(detail.mergedAt)

  return <div ref={surface} className="pr-surface" aria-busy={loading || running}>
    <div className="tools-chrome pr-surface__top">
      <span className="pr-surface__lead">
        <StateIcon size={16} aria-hidden="true" data-state={stateKey(detail)} />
        <h2 ref={top} tabIndex={-1} className="pr-surface__name"><span className="pr-surface__number">#{detail.number}</span> {detail.title}</h2>
        <span className="pr-surface__tag">{stateLabel(detail)}</span>
      </span>
      <div className="tools-chrome__actions">
        <button type="button" className="files-icon tt-focusable" aria-label="Open on GitHub" title="Open on GitHub" onClick={() => openExternal(detail.url)}><ExternalLink size={15} aria-hidden="true" /></button>
        {refresh}
        <PaneMenu groups={menu} label="More pull request actions" className="pr-surface__menu" />
      </div>
    </div>
    {noticeLine}
    <div className="pr-surface__body">
      <h3 className="pr-surface__heading">{checklistHeading(detail, clear)}{' '}<small data-tone={done === lines.length ? 'done' : undefined}>{done} of {lines.length} done</small></h3>
      <ol className="pr-surface__lines" aria-label="Merge checklist">{lines.map(line => {
        const Icon = LINE_ICONS[line.tone]
        return <li key={line.id} className="pr-surface__line" data-tone={line.tone}>
          <Icon size={18} aria-hidden="true" />
          <div className="pr-surface__line-text"><strong><span className="tt-visually-hidden">{LINE_STATE[line.tone]}: </span>{line.label}</strong><span className="pr-surface__why">{line.why}</span></div>
          {line.fix ? <span className="pr-surface__fix">{fix(line, line.fix)}</span> : null}
        </li>
      })}</ol>
      <div className="pr-surface__dock">
        {detail.state === 'merged' ? <div className="pr-surface__finished" data-state="merged"><CircleCheck size={20} aria-hidden="true" />
          <div><strong>Merged into <bdi>{detail.baseBranch}</bdi></strong>{when ? <span>{when}</span> : null}</div></div>
          : detail.state === 'closed' ? <div className="pr-surface__finished" data-state="closed"><Circle size={20} aria-hidden="true" />
            <div><strong>Closed without merging</strong></div>
            <Button variant="secondary" disabled={running} onClick={() => void act('reopen')}>{busy === 'reopen' ? BUSY_LABEL.reopen : 'Reopen'}</Button></div>
            : detail.autoMerge ? <div className="pr-surface__finished" data-state="auto"><CircleDashed size={20} aria-hidden="true" />
              <div><strong>Auto-merge is on</strong><span>GitHub merges this{detail.autoMerge.method ? ` with ${mergeLabel(detail.autoMerge.method).toLowerCase()}` : ''} when every line is done.</span></div>
              <Button variant="secondary" aria-label="Turn off auto-merge" disabled={running} onClick={() => void act('disable-auto-merge')}>{busy === 'disable-auto-merge' ? BUSY_LABEL['disable-auto-merge'] : 'Turn off'}</Button></div>
              : <>
                <div className="pr-surface__merge">
                  <Button variant="primary" className="pr-surface__merge-go" aria-disabled={!ready || running || undefined} aria-describedby={hintId}
                    onClick={() => { if (ready && !running) setConfirming('merge') }}>
                    <GitMerge size={17} aria-hidden="true" />{busy === 'merge' ? BUSY_LABEL.merge : `Merge #${detail.number}`}</Button>
                  {allowed.length > 1 ? <MergeMethodMenu allowed={allowed} selected={selected} base={detail.baseBranch} disabled={running} onChoose={choosePreferred} /> : null}
                </div>
                <p id={hintId} className="pr-surface__hint">{ready ? `${mergeEffect(selected, detail.baseBranch)}.` : allowed.length === 0 ? 'This repository allows no merge method. Change that on GitHub.' : <>{linesLeft(lines)}{autoMerge
                  ? <> <button type="button" className="pr-surface__textlink tt-focusable" disabled={running} onClick={() => setConfirming('enable-auto-merge')}>Merge when ready</button></> : null}</>}</p>
              </>}
      </div>
      <Fold label="Description" open={descriptionOpen} onToggle={() => setDescriptionOpen(value => !value)}>
        {detail.body.trim() ? <div className="pr-surface__description">{detail.body}</div> : <p className="pr-surface__quiet">No description.</p>}
      </Fold>
      {linked}
    </div>
    {linkDialog}
    {confirmation && confirming ? <ConfirmationDialog title={confirmation.title} description={confirmation.description} confirmLabel={confirmation.confirm} cancelLabel="Cancel" danger={confirmation.danger}
      fallbackFocusRef={top} onCancel={() => setConfirming(null)}
      onConfirm={async () => {
        const action = confirming
        setConfirming(null)
        if (action === 'update-with-rebase') void act('update-branch', 'rebase')
        else void act(action, action === 'close' ? undefined : selected)
      }} /> : null}
  </div>
}

/**
 * No pull request yet: what the checklist would list once there is one, Create PR as the Git action runs it (the
 * same press, disabled with the same reason), and Link pull request.
 */
function NoPullRequest({ thread, busy, command, onCreate, onLink }: {
  readonly thread: AgentThread; readonly busy: Busy | null; readonly command: Command | undefined
  readonly onCreate: (actionId: string) => void; readonly onLink: () => void
}): ReactNode {
  const status = thread.worktree?.git
  const create = menuEntries(status).find(entry => entry.id === 'create_pr')
  const gitRunning = thread.gitAction?.status === 'running' || busy !== null
  const hintId = useId()
  const branch = status?.branch
  const base = status?.defaultBranch ? <bdi className="pr-surface__branch">{status.defaultBranch}</bdi> : 'its base'
  return <div className="pr-surface__none">
    <h3 className="pr-surface__heading">Nothing to merge yet</h3>
    {branch && status?.isDefaultBranch ? <p><bdi className="pr-surface__branch">{branch}</bdi> is the default branch. Once this thread is on a branch with a pull request, this lists what stands between it and {base}.</p>
      : <p>{branch ? <><bdi className="pr-surface__branch">{branch}</bdi> has no pull request.</> : 'This thread has no pull request.'} Once it has one, this lists what stands between it and {base}.</p>}
    {command ? <div className="pr-surface__none-actions">
      {create ? <Button variant="primary" aria-disabled={create.hint !== undefined || gitRunning || undefined} aria-describedby={create.hint ? hintId : undefined} title={create.hint}
        onClick={() => { if (!create.hint && !gitRunning) onCreate(crypto.randomUUID()) }}>
        <GitPullRequest size={15} aria-hidden="true" />{busy === 'create-pr' ? BUSY_LABEL['create-pr'] : 'Create PR'}</Button> : null}
      <Button variant="secondary" onClick={onLink}><Link2 size={15} aria-hidden="true" />Link pull request</Button>
      {create?.hint ? <span id={hintId} className="tt-visually-hidden">{create.hint}</span> : null}
    </div> : null}
  </div>
}

/** A part of the surface that folds away: the description, the linked pull requests. */
function Fold({ label, count, open, onToggle, children }: { readonly label: string; readonly count?: number; readonly open: boolean; readonly onToggle: () => void; readonly children: ReactNode }): ReactNode {
  const id = useId()
  const Chevron = open ? ChevronDown : ChevronRight
  return <div className="pr-surface__fold">
    <button type="button" className="pr-surface__fold-head tt-focusable" aria-expanded={open} aria-controls={open ? id : undefined} onClick={onToggle}>
      <Chevron size={15} aria-hidden="true" />{label}{count !== undefined ? <>{' '}<span className="pr-surface__quiet">{count}</span></> : null}
    </button>
    {open ? <div id={id} className="pr-surface__fold-body">{children}</div> : null}
  </div>
}

/** Linked pull requests: the thread's links, and its branch's pull request when that is not linked, each opening in the surface. */
function LinkedFold({ thread, open, onToggle, onShow, onLink }: {
  readonly thread: AgentThread; readonly open: boolean; readonly onToggle: () => void
  readonly onShow: (url: string) => void; readonly onLink: (() => void) | null
}): ReactNode {
  const links = [...(thread.pullRequests ?? [])].reverse()
  const branch = thread.worktree?.git?.pullRequest
  const branchLinked = branch ? links.some(link => link.url.toLowerCase() === branch.url.toLowerCase()) : false
  const rows = [
    ...(branch && !branchLinked ? [{ number: branch.number, url: branch.url, title: branch.title, state: branch.state, draft: branch.draft, source: 'This branch' }] : []),
    ...links.map(link => ({ number: link.number, url: link.url, title: link.title, state: link.state, draft: link.draft, source: LINK_SOURCE[link.source] })),
  ]
  return <Fold label="Linked pull requests" count={rows.length} open={open} onToggle={onToggle}>
    {rows.length ? <ul className="pr-surface__links" aria-label="Linked pull requests">{rows.map(row => {
      const Icon = stateIcon(row)
      return <li key={row.url} className="pr-surface__link">
        <button type="button" className="pr-surface__link-open tt-focusable" onClick={() => onShow(row.url)} aria-label={`PR #${row.number}, ${stateLabel(row)}: ${row.title}. ${row.source}`}>
          <Icon size={15} aria-hidden="true" data-state={stateKey(row)} />
          <span className="pr-surface__link-number">#{row.number}</span>
          <span className="pr-surface__link-title">{row.title}</span>
          <span className="pr-surface__link-source">{row.source}</span>
        </button>
      </li>
    })}</ul> : <p className="pr-surface__quiet">None yet. A pull request the Git action creates is linked here, and so is one you link or check out from the branch picker.</p>}
    {onLink ? <Button variant="ghost" className="pr-surface__link-add" onClick={onLink}><Link2 size={14} aria-hidden="true" />Link pull request</Button> : null}
  </Fold>
}

/** The method beside Merge: its short name on the button, and a menu of the methods this repository allows, each saying what it leaves. */
function MergeMethodMenu({ allowed, selected, base, disabled, onChoose }: {
  readonly allowed: readonly GitPullRequestMergeMethod[]; readonly selected: GitPullRequestMergeMethod; readonly base: string
  readonly disabled: boolean; readonly onChoose: (method: GitPullRequestMergeMethod) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    list.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!list.current?.contains(target) && !button.current?.contains(target)) setOpen(false)
    }
    const away = (): void => setOpen(false)
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('blur', away)
    return () => { document.removeEventListener('pointerdown', dismiss, true); window.removeEventListener('blur', away) }
  }, [open])
  const close = (): void => { setOpen(false); button.current?.focus() }
  return <div className="pr-surface__method">
    <Button ref={button} variant="secondary" className="pr-surface__method-button" aria-label={`Merge method: ${mergeLabel(selected)}`} title="Merge method"
      aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(value => !value)}
      onKeyDown={event => {
        if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) }
        if (!open && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); setOpen(true) }
      }}>
      {MERGE_METHOD_SHORT[selected]}<ChevronDown size={14} aria-hidden="true" />
    </Button>
    {open ? <div ref={list} className="pr-surface__method-list" role="menu" aria-label="Merge method"
      onKeyDown={event => {
        if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(); return }
        const entries = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])]
        const index = entries.indexOf(document.activeElement as HTMLElement)
        const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : null
        if (next === null) return
        event.preventDefault()
        entries[(next + entries.length) % entries.length]?.focus()
      }}>
      {allowed.map(method => <button key={method} type="button" role="menuitemradio" aria-checked={method === selected} tabIndex={-1} className="pr-surface__method-item"
        aria-label={mergeLabel(method)} aria-description={mergeEffect(method, base)} onClick={() => { onChoose(method); close() }}>
        <span><span>{mergeLabel(method)}</span><small>{mergeEffect(method, base)}</small></span>
        {method === selected ? <Check size={14} aria-hidden="true" /> : null}
      </button>)}
    </div> : null}
  </div>
}
